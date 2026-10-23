#!/usr/bin/env node
/**
 * Status server for Homebase's Server mini-app: system stats, services and containers, and
 * start/stop/restart for them, with their logs, the Tailscale devices and what fills the media
 * drive. Also watches for problems and reports them through ntfy, since the app can't get push
 * notifications. Stops the download stack while a game runs (game mode)
 * and runs Seerr only while it's used. Passes the Requests mini-app's calls on to Seerr, Sonarr
 * and Radarr, and qBittorrent's speed limit and seeding. Takes files, text and links from the
 * Drop mini-app, and hands back the files in its folder. Saves web videos into Jellyfin with
 * yt-dlp for the Videos mini-app. Runs the Assistant mini-app's chats on a local model, starting it
 * when asked. No dependencies beyond Node.js (and yt-dlp for videos).
 *
 * It also keeps a year of history (CPU, memory, network, power, drives, and each service's memory,
 * CPU, disk and network use) at finer detail the more recent it is, a log of what happened to the
 * services (crashes, restarts, memory kills, reboots), the drives' health, and can list the
 * processes and cgroups using the most memory and CPU.
 *
 * Every request needs `Authorization: Bearer <token>`. The token lives in `token` next to this
 * file and is created on first start. `node server.mjs pair` sends a link to the phone through
 * ntfy that fills in the app's connection settings. The link carries a one-time code rather than
 * the token, since ntfy keeps messages for days.
 *
 * Only loopback and Tailscale addresses are answered, in case the firewall ever opens the port to
 * the home network.
 */
import { execFile, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, createWriteStream, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { appendFile, link, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.join(ROOT, 'token');
const PAIRING_PATH = path.join(ROOT, 'pairing');
const PAIRING_TTL_MS = 10 * 60_000;
const PORT = Number(process.env.PORT ?? 8788);
/** Address the phone uses, sent in the pairing link. */
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://fedora.tail27f991.ts.net:${PORT}`;
const NTFY_URL = process.env.NTFY_URL ?? 'http://localhost:2586/Homebase';

/**
 * systemd units to show besides the Podman containers, which are found on their own. `system`
 * units belong to the whole machine and are shown read-only. A timer's actions run the service
 * it triggers instead of starting and stopping the timer.
 */
const UNITS = [
  { id: 'homebase-updates', name: 'Homebase updates', unit: 'homebase-updates.service' },
  { id: 'homebase-status', name: 'Homebase status', unit: 'homebase-status.service', self: true },
  { id: 'jellyfin-backup', name: 'Jellyfin backup', unit: 'jellyfin-backup.timer', runs: 'jellyfin-backup.service' },
  { id: 'tailscale', name: 'Tailscale', unit: 'tailscaled.service', system: true },
];

/** Mounts to leave out of the disk list. */
const HIDDEN_MOUNTS = /^\/(boot|efi)(\/|$)/;
const REAL_FILESYSTEMS = new Set(['ext4', 'ext3', 'btrfs', 'xfs', 'f2fs', 'zfs', 'ntfs', 'ntfs3', 'exfat', 'vfat']);

const DISK_WARN = 0.9;
const TEMP_WARN = 90;
const WATCH_INTERVAL = 5 * 60_000;
const DAY_MS = 24 * 3600_000;

// ---------------------------------------------------------------------------------------------
// Token

let token;
async function getToken() {
  if (token) return token;
  try {
    token = (await readFile(TOKEN_PATH, 'utf8')).trim();
  } catch {
    token = randomBytes(24).toString('base64url');
    await writeFile(TOKEN_PATH, token + '\n', { mode: 0o600 });
    console.log(`Created a new token in ${TOKEN_PATH}`);
  }
  return token;
}

function authorized(req, expected) {
  const given = Buffer.from(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '');
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Loopback, or Tailscale's 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
function allowedPeer(address = '') {
  const a = address.replace(/^::ffff:/, '').toLowerCase();
  if (a === '127.0.0.1' || a === '::1') return true;
  const second = Number(/^100\.(\d+)\./.exec(a)?.[1]);
  if (second) return second >= 64 && second <= 127;
  return a.startsWith('fd7a:115c:a1e0:');
}

// ---------------------------------------------------------------------------------------------
// Rates: CPU, GPU and network are sampled in the background so a request gets a current figure
// without waiting.

const rates = { cpu: undefined, rxPerSec: undefined, txPerSec: undefined, cores: [], cpuWatts: undefined };
/** Read and write speed and share of time busy, by kernel name (sda). */
let diskRates = new Map();
let lastCpu;
let lastNet;
let lastEnergy;
let lastDiskStats;
/** Why the CPU's power draw can't be read, when it can't. */
let cpuPowerError;

function cpuTimes(line) {
  const [user, nice, system, idle, iowait, irq, softirq, steal] = line.split(/\s+/).slice(1).map(Number);
  return { idle: idle + iowait, total: user + nice + system + idle + iowait + irq + softirq + steal };
}

/** The whole CPU and each core. */
async function readCpu() {
  const lines = (await readFile('/proc/stat', 'utf8')).split('\n');
  return { ...cpuTimes(lines[0]), cores: lines.filter((l) => /^cpu\d+ /.test(l)).map(cpuTimes) };
}

const busyBetween = (a, b) => (b.total > a.total ? 1 - (b.idle - a.idle) / (b.total - a.total) : undefined);

// The CPU package's energy counter (RAPL), which AMD chips offer under Intel's name too. Only root
// can read it unless a udev rule lets this user read it (see README.md).
const RAPL = '/sys/class/powercap/intel-rapl:0';

async function readEnergy() {
  try {
    const uj = Number((await readFile(`${RAPL}/energy_uj`, 'utf8')).trim());
    cpuPowerError = undefined;
    return { uj, at: Date.now() };
  } catch (e) {
    cpuPowerError = e.code === 'EACCES' ? 'permission' : 'missing';
    return undefined;
  }
}

/** Whole drives: NVMe and SATA disks have a `device` link; zram, loop and dm devices don't. */
async function physicalDisks() {
  const names = await readdir('/sys/block').catch(() => []);
  const checks = await Promise.all(names.map((n) => readdir(`/sys/block/${n}/device`).then(() => n, () => undefined)));
  return new Set(checks.filter(Boolean));
}

/** Bytes read and written and milliseconds busy, per drive, from /proc/diskstats (in 512-byte sectors). */
async function readDiskStats() {
  const disks = await physicalDisks();
  const out = new Map();
  for (const line of (await readFile('/proc/diskstats', 'utf8')).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14 || !disks.has(f[2])) continue;
    out.set(f[2], { read: Number(f[5]) * 512, written: Number(f[9]) * 512, busyMs: Number(f[12]) });
  }
  return { at: Date.now(), disks: out };
}

/** Physical interfaces only: lo, tailscale0 and container bridges have no `device` link. */
async function physicalInterfaces() {
  const names = await readdir('/sys/class/net');
  const checks = await Promise.all(
    names.map((n) => readdir(`/sys/class/net/${n}/device`).then(() => n, () => undefined)),
  );
  return new Set(checks.filter(Boolean));
}

async function readNet() {
  const ifaces = await physicalInterfaces();
  let rx = 0;
  let tx = 0;
  for (const line of (await readFile('/proc/net/dev', 'utf8')).split('\n').slice(2)) {
    const [name, data] = line.trim().split(':');
    if (!data || !ifaces.has(name)) continue;
    const fields = data.trim().split(/\s+/).map(Number);
    rx += fields[0];
    tx += fields[8];
  }
  return { rx, tx, at: Date.now() };
}

async function sample() {
  try {
    const cpu = await readCpu();
    if (lastCpu && cpu.total > lastCpu.total) {
      rates.cpu = busyBetween(lastCpu, cpu);
      rates.cores = cpu.cores.map((c, i) => (lastCpu.cores[i] ? busyBetween(lastCpu.cores[i], c) : undefined));
    }
    lastCpu = cpu;

    const energy = await readEnergy();
    if (energy && lastEnergy && energy.at > lastEnergy.at) {
      let used = energy.uj - lastEnergy.uj;
      // The counter wraps around.
      if (used < 0) used += (await readNumber(`${RAPL}/max_energy_range_uj`)) ?? 0;
      rates.cpuWatts = used >= 0 ? used / 1e6 / ((energy.at - lastEnergy.at) / 1000) : undefined;
    } else if (!energy) rates.cpuWatts = undefined;
    lastEnergy = energy;

    const disk = await readDiskStats();
    if (lastDiskStats && disk.at > lastDiskStats.at) {
      const ms = disk.at - lastDiskStats.at;
      diskRates = new Map(
        [...disk.disks].flatMap(([name, d]) => {
          const p = lastDiskStats.disks.get(name);
          if (!p) return [];
          return [
            [
              name,
              {
                readPerSec: Math.max(0, ((d.read - p.read) * 1000) / ms),
                writePerSec: Math.max(0, ((d.written - p.written) * 1000) / ms),
                busy: Math.min(1, Math.max(0, (d.busyMs - p.busyMs) / ms)),
              },
            ],
          ];
        }),
      );
    }
    lastDiskStats = disk;

    const net = await readNet();
    if (lastNet && net.at > lastNet.at) {
      const secs = (net.at - lastNet.at) / 1000;
      rates.rxPerSec = Math.max(0, (net.rx - lastNet.rx) / secs);
      rates.txPerSec = Math.max(0, (net.tx - lastNet.tx) / secs);
    }
    lastNet = net;
  } catch (e) {
    console.error('Sampling failed:', e);
  }
}

// ---------------------------------------------------------------------------------------------
// Readings

async function readNumber(file) {
  try {
    return Number((await readFile(file, 'utf8')).trim());
  } catch {
    return undefined;
  }
}

/** /proc/meminfo in bytes. */
async function meminfo() {
  return Object.fromEntries(
    (await readFile('/proc/meminfo', 'utf8'))
      .split('\n')
      .map((l) => /^(\w+):\s+(\d+)/.exec(l))
      .filter(Boolean)
      .map(([, k, v]) => [k, Number(v) * 1024]),
  );
}

async function memory() {
  const info = await meminfo();
  return {
    totalBytes: info.MemTotal,
    availableBytes: info.MemAvailable,
    swapTotalBytes: info.SwapTotal,
    swapFreeBytes: info.SwapFree,
  };
}

/** One reading per sensor chip we know about, picking its most telling input. */
const SENSORS = [
  { chip: 'k10temp', label: 'CPU', input: ['Tctl', 'Tdie'] },
  { chip: 'coretemp', label: 'CPU', input: ['Package id 0'] },
  { chip: 'amdgpu', label: 'GPU', input: ['edge'] },
  { chip: 'nvme', label: 'SSD', input: ['Composite'] },
];

async function temperatures() {
  const out = [];
  const hwmons = await readdir('/sys/class/hwmon').catch(() => []);
  for (const h of hwmons) {
    const dir = `/sys/class/hwmon/${h}`;
    const chip = (await readFile(`${dir}/name`, 'utf8').catch(() => '')).trim();
    const sensor = SENSORS.find((s) => s.chip === chip);
    if (!sensor) continue;
    const files = await readdir(dir);
    for (const f of files.filter((f) => /^temp\d+_label$/.test(f))) {
      const label = (await readFile(`${dir}/${f}`, 'utf8')).trim();
      if (!sensor.input.includes(label)) continue;
      const milli = await readNumber(`${dir}/${f.replace('_label', '_input')}`);
      if (milli !== undefined) out.push({ label: sensor.label, celsius: milli / 1000 });
      break;
    }
  }
  return out.sort((a, b) => SENSORS.findIndex((s) => s.label === a.label) - SENSORS.findIndex((s) => s.label === b.label));
}

async function gpuBusy() {
  const cards = (await readdir('/sys/class/drm').catch(() => [])).filter((c) => /^card\d+$/.test(c));
  for (const c of cards) {
    const busy = await readNumber(`/sys/class/drm/${c}/device/gpu_busy_percent`);
    if (busy !== undefined) return busy / 100;
  }
  return undefined;
}

async function disks() {
  const seen = new Map();
  for (const line of (await readFile('/proc/mounts', 'utf8')).split('\n')) {
    const [device, mount, type] = line.split(' ');
    if (!REAL_FILESYSTEMS.has(type) || HIDDEN_MOUNTS.test(mount)) continue;
    const mountPath = mount.replace(/\\040/g, ' ');
    // btrfs subvolumes (/ and /home) share a device; keep the shortest mount point.
    const prev = seen.get(device);
    if (!prev || mountPath.length < prev.length) seen.set(device, mountPath);
  }
  const out = await Promise.all(
    [...seen.values()].map(async (mount) => {
      const s = await statfs(mount);
      const total = s.blocks * s.bsize;
      const available = s.bavail * s.bsize;
      return { mount, totalBytes: total, usedBytes: total - s.bfree * s.bsize, availableBytes: available };
    }),
  );
  return out.sort((a, b) => a.mount.localeCompare(b.mount));
}

/**
 * Where memory goes, from /proc/meminfo. `apps` is memory programs asked for (including shared
 * memory, which graphics and browsers use), `cache` is file data the kernel keeps around and
 * hands back when something needs it, and `kernel` is the rest of what isn't free.
 */
function memoryBreakdown(info) {
  const apps = info.AnonPages + info.Shmem;
  const cache = info.Buffers + info.Cached - info.Shmem + info.SReclaimable;
  const free = info.MemFree;
  return {
    totalBytes: info.MemTotal,
    availableBytes: info.MemAvailable,
    appsBytes: apps,
    cacheBytes: cache,
    kernelBytes: Math.max(0, info.MemTotal - free - apps - cache),
    freeBytes: free,
    swapTotalBytes: info.SwapTotal,
    swapUsedBytes: info.SwapTotal - info.SwapFree,
  };
}

/**
 * Share of the last minute (or `window` seconds: 10, 60 or 300) that something was stalled
 * waiting on CPU, memory or disk.
 */
async function pressure(window = 60) {
  const out = {};
  for (const kind of ['cpu', 'memory', 'io']) {
    const text = await readFile(`/proc/pressure/${kind}`, 'utf8').catch(() => '');
    const avg = Number(new RegExp(`^some .*avg${window}=([\\d.]+)`, 'm').exec(text)?.[1]);
    if (!Number.isNaN(avg)) out[kind] = avg / 100;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Usage per service and process. Every systemd unit and container has its own cgroup, which
// counts the memory, CPU time and disk traffic of everything inside it.

const CGROUP_ROOT = '/sys/fs/cgroup';
const CLOCK_TICKS = 100;
const PAGE_SIZE = 4096;

/**
 * /proc and /sys files are made on the spot from kernel memory, so reading one takes
 * microseconds. Read asynchronously, each costs a trip through libuv's four threads, which made
 * reading the ~1500 a process list needs take 60-80 ms instead of ~11 ms.
 */
function readKernelFile(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function readKernelDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Services and scopes, as paths relative to the cgroup root. A unit's own sub-groups (a
 * terminal's tabs, a container's payload) count toward it; only a user manager, which holds
 * slices of its own, is looked into.
 */
function leafGroups(dir = '') {
  const entries = readKernelDir(path.join(CGROUP_ROOT, dir));
  const children = entries.filter((e) => e.isDirectory() && /\.(slice|service|scope)$/.test(e.name));
  const isUnit = /\.(service|scope)$/.test(dir);
  if (isUnit && !children.some((c) => c.name.endsWith('.slice'))) return [dir];
  if (dir && !children.length) return [];
  return children.flatMap((c) => leafGroups(path.join(dir, c.name)));
}

function statFields(text) {
  return Object.fromEntries(
    text
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' '))
      .map(([k, v]) => [k, Number(v)]),
  );
}

function readGroup(dir) {
  const base = path.join(CGROUP_ROOT, dir);
  const currentText = readKernelFile(`${base}/memory.current`);
  if (currentText === undefined) return undefined;
  const current = Number(currentText.trim());
  const memStat = readKernelFile(`${base}/memory.stat`) ?? '';
  const cpuStat = readKernelFile(`${base}/cpu.stat`) ?? '';
  const ioStat = readKernelFile(`${base}/io.stat`) ?? '';
  const mem = statFields(memStat);
  const cpu = statFields(cpuStat);
  let read = 0;
  let written = 0;
  // Per drive, by "major:minor".
  const devices = {};
  for (const m of ioStat.matchAll(/^(\d+:\d+) rbytes=(\d+) wbytes=(\d+)/gm)) {
    read += Number(m[2]);
    written += Number(m[3]);
    devices[m[1]] = [Number(m[2]), Number(m[3])];
  }
  // File pages are cache the kernel can take back, except shared memory, which counts as file.
  const cache = Math.max(0, (mem.file ?? 0) - (mem.shmem ?? 0));
  return {
    dir,
    usedBytes: current - cache,
    cacheBytes: cache,
    cpuUsec: cpu.usage_usec ?? 0,
    readBytes: read,
    writtenBytes: written,
    devices,
  };
}

/** "app-org.kde.konsole-3158.scope" → "konsole", "session-c10.scope" → "Login session c10". */
function groupLabel(unit) {
  const login = /^session-(\w+)\.scope$/.exec(unit);
  if (login) return `Login session ${login[1]}`;
  if (/^run-/.test(unit)) return 'Command';
  const name = unit
    .replace(/\.(service|scope)$/, '')
    .replace(/^app-/, '')
    .replace(/@.*$/, '')
    .replace(/-\d+$/, '')
    .replace(/\\x2d/g, '-');
  // Reverse-DNS names (org.kde.konsole) read best as their last part.
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
}

function groupCategory(dir) {
  if (dir.startsWith('system.slice/') || dir === 'init.scope') return 'system';
  if (/^user\.slice\/[^/]+\/session-/.test(dir)) return 'login';
  return 'desktop';
}

let lastGroups;
let groupRates = new Map();

/**
 * Every leaf cgroup with its memory now and its CPU and disk rates since the last reading.
 * Readings less than a second apart reuse the previous rates rather than divide by almost zero.
 */
async function groupUsage() {
  const now = Date.now();
  const groups = leafGroups().map(readGroup).filter(Boolean);
  if (!lastGroups || now - lastGroups.at >= 1000) {
    if (lastGroups) {
      const secs = (now - lastGroups.at) / 1000;
      const cores = os.availableParallelism();
      const prev = new Map(lastGroups.groups.map((g) => [g.dir, g]));
      groupRates = new Map(
        groups.flatMap((g) => {
          const p = prev.get(g.dir);
          if (!p) return [];
          return [
            [
              g.dir,
              {
                cpu: Math.max(0, (g.cpuUsec - p.cpuUsec) / 1e6 / secs / cores),
                readPerSec: Math.max(0, (g.readBytes - p.readBytes) / secs),
                writePerSec: Math.max(0, (g.writtenBytes - p.writtenBytes) / secs),
                deviceRates: Object.fromEntries(
                  Object.entries(g.devices).map(([dev, [r, w]]) => {
                    const [pr, pw] = p.devices[dev] ?? [r, w];
                    return [dev, [Math.max(0, (r - pr) / secs), Math.max(0, (w - pw) / secs)]];
                  }),
                ),
              },
            ],
          ];
        }),
      );
    }
    lastGroups = { at: now, groups };
  }
  return groups.map((g) => ({ ...g, ...groupRates.get(g.dir) }));
}

/** Maps cgroups to the dashboard's services: by systemd unit, or a plain container's scope. */
function serviceGroups(groups, pods) {
  const byUnit = new Map();
  for (const g of groups) {
    const unit = path.basename(g.dir);
    // A user unit wins over a system unit of the same name.
    if (!byUnit.has(unit) || g.dir.includes('/user@')) byUnit.set(unit, g);
  }
  const out = new Map();
  for (const p of pods) {
    const name = p.Names?.[0] ?? p.Id.slice(0, 12);
    const unit = p.Labels?.PODMAN_SYSTEMD_UNIT;
    const g = (unit && byUnit.get(unit)) ?? byUnit.get(`libpod-${p.Id}.scope`);
    if (g) out.set(`container:${name}`, g);
  }
  for (const u of UNITS) {
    const g = byUnit.get(u.runs ?? u.unit);
    if (g) out.set(`unit:${u.id}`, g);
  }
  return out;
}

/** Plain numbers for the app: memory in use, cache, and share of the whole machine's CPU. */
function usageOf(g) {
  return {
    usedBytes: g.usedBytes,
    cacheBytes: g.cacheBytes,
    cpu: g.cpu,
    readPerSec: g.readPerSec,
    writePerSec: g.writePerSec,
  };
}

/** Everything using memory, named after its service where there is one. */
async function usage() {
  const [groups, pods, info, press] = await Promise.all([
    groupUsage(),
    containers().catch(() => []),
    meminfo(),
    pressure(),
  ]);
  const services = serviceGroups(groups, pods);
  const names = new Map();
  for (const p of pods) names.set(`container:${p.Names?.[0] ?? p.Id.slice(0, 12)}`, p.Names?.[0]);
  for (const u of UNITS) names.set(`unit:${u.id}`, u.name);
  const serviceByDir = new Map([...services].map(([id, g]) => [g.dir, id]));

  return {
    memory: memoryBreakdown(info),
    pressure: press,
    groups: groups
      .map((g) => {
        const serviceId = serviceByDir.get(g.dir);
        return {
          id: g.dir,
          name: serviceId ? names.get(serviceId) : groupLabel(path.basename(g.dir)),
          category: serviceId ? (serviceId.startsWith('container:') ? 'container' : 'homebase') : groupCategory(g.dir),
          serviceId,
          ...usageOf(g),
        };
      })
      .sort((a, b) => b.usedBytes - a.usedBytes),
    at: Date.now(),
  };
}

/** The named cgroup a process's cgroup sits in, such as a container's unit for its payload. */
function serviceOfGroup(group, groupNames) {
  for (let dir = group; dir && dir !== '.'; dir = path.dirname(dir)) {
    const name = groupNames.get(dir);
    if (name) return name;
  }
  return undefined;
}

let lastProcs;

/** Processes using the most memory or CPU, with CPU measured since the previous call. */
async function processes() {
  const now = Date.now();
  const pids = readKernelDir('/proc').filter((e) => /^\d+$/.test(e.name)).map((e) => e.name);
  const list = pids
    .map((pid) => {
      const stat = readKernelFile(`/proc/${pid}/stat`);
      const cgroup = readKernelFile(`/proc/${pid}/cgroup`);
      const cmdline = readKernelFile(`/proc/${pid}/cmdline`);
      if (stat === undefined || cgroup === undefined || cmdline === undefined) return undefined; // Exited while we looked.
      // The name sits in parentheses and can itself contain spaces or parentheses.
      const close = stat.lastIndexOf(')');
      const f = stat.slice(close + 2).split(' ');
      const rss = Number(f[21]) * PAGE_SIZE;
      if (!rss) return undefined; // Kernel threads.
      return {
        pid: Number(pid),
        name: stat.slice(stat.indexOf('(') + 1, close),
        command: cmdline.replace(/\0+$/, '').replace(/\0/g, ' ').slice(0, 300),
        group: /^0::\/(.*)$/m.exec(cgroup)?.[1],
        key: `${pid}:${f[19]}`,
        ticks: Number(f[11]) + Number(f[12]),
        rssBytes: rss,
      };
    })
    .filter(Boolean);

  const prev = lastProcs && now - lastProcs.at < 5 * 60_000 ? lastProcs : undefined;
  lastProcs = { at: now, ticks: new Map(list.map((p) => [p.key, p.ticks])) };
  const secs = prev ? (now - prev.at) / 1000 : 0;
  const cores = os.availableParallelism();

  const { groups } = await usage();
  const groupNames = new Map(groups.map((g) => [g.id, g.name]));
  const withCpu = list.map((p) => {
    const before = prev?.ticks.get(p.key);
    return {
      pid: p.pid,
      name: p.name,
      command: p.command,
      service: p.group && serviceOfGroup(p.group, groupNames),
      rssBytes: p.rssBytes,
      cpu: before !== undefined && secs > 0 ? Math.max(0, (p.ticks - before) / CLOCK_TICKS / secs / cores) : undefined,
    };
  });
  const byMemory = [...withCpu].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 40);
  const byCpu = [...withCpu].sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0)).slice(0, 40);
  return {
    processes: [...new Map([...byMemory, ...byCpu].map((p) => [p.pid, p])).values()],
    count: list.length,
    at: now,
  };
}

// ---------------------------------------------------------------------------------------------
// Graphics card
/** The first card that reports how busy it is, which skips display-only devices. */
async function gpuCard() {
  const cards = (await readdir('/sys/class/drm').catch(() => [])).filter((c) => /^card\d+$/.test(c));
  for (const c of cards) {
    const dir = `/sys/class/drm/${c}/device`;
    if ((await readNumber(`${dir}/gpu_busy_percent`)) !== undefined) return dir;
  }
  return undefined;
}

const gpuNames = new Map();

/** The marketing name from lspci, such as "Radeon RX 5600 OEM/5600 XT / 5700/5700 XT". */
async function gpuName(dir) {
  if (gpuNames.has(dir)) return gpuNames.get(dir);
  const slot = path.basename(await realpath(dir));
  let name = 'Graphics card';
  try {
    const { stdout } = await run('lspci', ['-mm', '-s', slot], { timeout: 5000 });
    const device = [...stdout.matchAll(/"([^"]*)"/g)][2]?.[1];
    if (device) name = /\[(.+)\]/.exec(device)?.[1] ?? device;
  } catch {}
  gpuNames.set(dir, name);
  return name;
}

const readText = (file) => readFile(file, 'utf8').then((t) => t.trim(), () => undefined);

/** Highest level in a pp_dpm_* table ("2: 2100Mhz"), in MHz. */
async function maxClock(file) {
  const text = await readText(file);
  const levels = [...(text ?? '').matchAll(/(\d+)Mhz/gi)].map((m) => Number(m[1]));
  return levels.length ? Math.max(...levels) : undefined;
}

const GPU_TEMPS = { edge: 'Edge', junction: 'Hotspot', mem: 'Memory' };
const CLOCKS = { sclk: { label: 'Core', table: 'pp_dpm_sclk' }, mclk: { label: 'Memory', table: 'pp_dpm_mclk' } };

/** Sensors from the card's hwmon: temperatures, power, fan, clocks and voltage. */
async function gpuSensors(dir) {
  const hwmon = (await readdir(`${dir}/hwmon`).catch(() => []))[0];
  const out = { temperatures: [], clocks: [] };
  if (!hwmon) return out;
  const h = `${dir}/hwmon/${hwmon}`;
  const files = await readdir(h);
  for (const f of files.filter((f) => /^temp\d+_label$/.test(f))) {
    const label = await readText(`${h}/${f}`);
    const base = f.replace('_label', '');
    const milli = await readNumber(`${h}/${base}_input`);
    if (milli === undefined) continue;
    const crit = await readNumber(`${h}/${base}_crit`);
    out.temperatures.push({ label: GPU_TEMPS[label] ?? label, celsius: milli / 1000, criticalCelsius: crit && crit / 1000 });
  }
  for (const f of files.filter((f) => /^freq\d+_label$/.test(f))) {
    const clock = CLOCKS[await readText(`${h}/${f}`)];
    const hz = await readNumber(`${h}/${f.replace('_label', '_input')}`);
    if (!clock || hz === undefined) continue;
    out.clocks.push({ label: clock.label, mhz: Math.round(hz / 1e6), maxMhz: await maxClock(`${dir}/${clock.table}`) });
  }
  const micro = (await readNumber(`${h}/power1_average`)) ?? (await readNumber(`${h}/power1_input`));
  if (micro !== undefined) {
    out.power = { watts: micro / 1e6, capWatts: ((await readNumber(`${h}/power1_cap`)) ?? 0) / 1e6 || undefined };
  }
  const rpm = await readNumber(`${h}/fan1_input`);
  if (rpm !== undefined) out.fan = { rpm, maxRpm: await readNumber(`${h}/fan1_max`) };
  const mv = await readNumber(`${h}/in0_input`);
  if (mv !== undefined) out.voltageMv = mv;
  return out;
}

const ENGINE_LABELS = { gfx: '3D', compute: 'Compute', dec: 'Video decode', enc: 'Video encode', jpeg: 'JPEG', dma: 'Copy' };

let lastGpuClients;

/**
 * Which files of which processes are the card, by pid. Finding them means looking at all ~5000
 * open files on the machine (~25 ms), so only new processes are looked at each time, which
 * catches a transcode as it starts, and all of them every CARD_FILES_RESCAN_MS, which catches
 * a program that opens the card some time after starting.
 */
const CARD_FILES_RESCAN_MS = 30_000;
let cardFilesAt = 0;
let cardFilesByPid = new Map();

function cardFiles() {
  const full = Date.now() - cardFilesAt >= CARD_FILES_RESCAN_MS;
  const next = new Map();
  for (const e of readKernelDir('/proc')) {
    const pid = e.name;
    if (!/^\d+$/.test(pid)) continue;
    if (!full && cardFilesByPid.has(pid)) {
      next.set(pid, cardFilesByPid.get(pid));
      continue;
    }
    const fds = [];
    for (const fd of readKernelDir(`/proc/${pid}/fd`)) {
      try {
        if (readlinkSync(`/proc/${pid}/fd/${fd.name}`).startsWith('/dev/dri/')) fds.push(fd.name);
      } catch {} // Closed while we looked.
    }
    next.set(pid, fds);
  }
  cardFilesByPid = next;
  if (full) cardFilesAt = Date.now();
  return [...next].filter(([, fds]) => fds.length);
}

/**
 * Programs with the card open, from the DRM fdinfo the kernel keeps per open file: the memory
 * each holds and the time each engine spent on its work, turned into a share since the previous
 * call. Only our own processes are readable, which covers the containers since they're rootless.
 */
async function gpuClients(slot) {
  const now = Date.now();
  const clients = new Map();
  for (const [pid, fds] of cardFiles()) {
    for (const fd of fds) {
      // Gone if it exited or closed the card; someone else's isn't readable. An fd number taken
      // since by another file has no client id.
      const info = readKernelFile(`/proc/${pid}/fdinfo/${fd}`);
      if (!info) continue;
      const fields = Object.fromEntries([...info.matchAll(/^([\w-]+):\s+(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
      const id = fields['drm-client-id'];
      if (!id || fields['drm-pdev'] !== slot || clients.has(id)) continue;
      const kib = (k) => Number.parseInt(fields[k] ?? '0', 10) * 1024;
      const engines = {};
      for (const [k, v] of Object.entries(fields)) {
        const e = /^drm-engine-(?!capacity)(.+)$/.exec(k);
        if (e) engines[e[1]] = Number.parseInt(v, 10) / (Number(fields[`drm-engine-capacity-${e[1]}`]) || 1);
      }
      clients.set(id, {
        pid: Number(pid),
        vramBytes: kib('drm-memory-vram') || kib('drm-total-vram'),
        gttBytes: kib('drm-memory-gtt') || kib('drm-total-gtt'),
        engines,
      });
    }
  }

  const prev = lastGpuClients && now - lastGpuClients.at < 5 * 60_000 ? lastGpuClients : undefined;
  lastGpuClients = { at: now, clients };
  const elapsedNs = prev ? (now - prev.at) * 1e6 : 0;

  // One program can open the card several times; add those up.
  const byPid = new Map();
  for (const [id, c] of clients) {
    const p = byPid.get(c.pid) ?? { pid: c.pid, vramBytes: 0, gttBytes: 0, engines: {} };
    p.vramBytes += c.vramBytes;
    p.gttBytes += c.gttBytes;
    const before = prev?.clients.get(id);
    for (const [e, ns] of Object.entries(c.engines)) {
      const was = before?.engines[e];
      if (was === undefined || !elapsedNs) continue;
      p.engines[e] = (p.engines[e] ?? 0) + Math.max(0, ns - was) / elapsedNs;
    }
    byPid.set(c.pid, p);
  }

  const { groups } = await usage();
  const groupNames = new Map(groups.map((g) => [g.id, g.name]));
  const list = await Promise.all(
    [...byPid.values()].map(async (p) => {
      const [comm, cgroup] = await Promise.all([
        readText(`/proc/${p.pid}/comm`),
        readFile(`/proc/${p.pid}/cgroup`, 'utf8').catch(() => ''),
      ]);
      const group = /^0::\/(.*)$/m.exec(cgroup)?.[1];
      for (const e of Object.keys(p.engines)) p.engines[e] = Math.min(1, p.engines[e]);
      return { ...p, name: comm ?? String(p.pid), service: group && serviceOfGroup(group, groupNames) };
    }),
  );
  return { list: list.sort((a, b) => b.vramBytes - a.vramBytes), measured: Boolean(prev) };
}

async function gpu() {
  const dir = await gpuCard();
  if (!dir) throw new HttpError(404, 'No graphics card that reports its load');
  const slot = path.basename(await realpath(dir));
  const n = (f) => readNumber(`${dir}/${f}`);
  const [name, busy, memBusy, vramTotal, vramUsed, gttTotal, gttUsed, sensors, clients, level, link] = await Promise.all([
    gpuName(dir),
    n('gpu_busy_percent'),
    n('mem_busy_percent'),
    n('mem_info_vram_total'),
    n('mem_info_vram_used'),
    n('mem_info_gtt_total'),
    n('mem_info_gtt_used'),
    gpuSensors(dir),
    gpuClients(slot),
    readText(`${dir}/power_dpm_force_performance_level`),
    Promise.all(['current_link_speed', 'current_link_width', 'max_link_speed', 'max_link_width'].map((f) => readText(`${dir}/${f}`))),
  ]);

  // The card as a whole, from adding up every program's share of each engine. The kernel only
  // lists an engine for a program once it has used it, so start with the ones worth watching.
  const engines = { gfx: 0, compute: 0, dec: 0, enc: 0 };
  for (const c of clients.list) for (const [e, v] of Object.entries(c.engines)) engines[e] = Math.min(1, (engines[e] ?? 0) + v);

  const pcie = (speed) => speed && /([\d.]+) GT\/s/.exec(speed)?.[1];
  return {
    name,
    driver: path.basename(await realpath(`${dir}/driver`).catch(() => '')) || undefined,
    usage: busy === undefined ? undefined : busy / 100,
    memoryControllerUsage: memBusy === undefined ? undefined : memBusy / 100,
    vram: vramTotal ? { totalBytes: vramTotal, usedBytes: vramUsed ?? 0 } : undefined,
    gtt: gttTotal ? { totalBytes: gttTotal, usedBytes: gttUsed ?? 0 } : undefined,
    ...sensors,
    performanceLevel: level,
    link: link[0] ? { gts: Number(pcie(link[0])), width: Number(link[1]), maxGts: Number(pcie(link[2])), maxWidth: Number(link[3]) } : undefined,
    engines: clients.measured
      ? Object.entries(engines).map(([id, v]) => ({ id, label: ENGINE_LABELS[id] ?? id, usage: v }))
      : undefined,
    clients: clients.list.map((c) => ({
      ...c,
      engines: clients.measured ? Object.entries(c.engines).map(([id, v]) => ({ id, label: ENGINE_LABELS[id] ?? id, usage: v })) : undefined,
    })),
    at: Date.now(),
  };
}

// ---------------------------------------------------------------------------------------------
// Services

const UNIT_PROPS = ['ActiveState', 'SubState', 'Result', 'ActiveEnterTimestamp', 'LastTriggerUSec', 'NextElapseUSecRealtime', 'NRestarts'];

/** `systemctl show` readings by its arguments, since each takes ~10 ms. */
const unitReadings = new Map();

async function showUnits(units, system) {
  if (!units.length) return {};
  const args = [...(system ? [] : ['--user']), 'show', '--timestamp=unix', `--property=${UNIT_PROPS.join(',')}`, ...units];
  const key = args.join(' ');
  if (!unitReadings.has(key)) {
    unitReadings.set(
      key,
      backgroundRefreshed(async () => (await run('systemctl', args)).stdout, { staleMs: 2000, maxAgeMs: 10_000, label: 'systemctl show' }),
    );
  }
  const stdout = await unitReadings.get(key).get();
  // One block per unit, in the order asked, separated by blank lines.
  const blocks = stdout.trim().split(/\n\n+/);
  return Object.fromEntries(
    units.map((u, i) => [
      u,
      Object.fromEntries((blocks[i] ?? '').split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])),
    ]),
  );
}

/** "@1792553287" → milliseconds, or undefined for an empty or zero timestamp. */
function unixTimestamp(value) {
  const secs = Number(value?.replace(/^@/, ''));
  return secs ? secs * 1000 : undefined;
}

function unitState(props) {
  if (props.ActiveState === 'failed') return 'failed';
  if (props.ActiveState === 'active' || props.ActiveState === 'reloading') return 'running';
  if (props.ActiveState === 'activating' || props.ActiveState === 'deactivating') return 'changing';
  return 'stopped';
}

const QUADLET_DIR = path.join(os.homedir(), '.config/containers/systemd');

/**
 * Containers that systemd runs from Quadlet files, with their units. Quadlet removes a container
 * when it stops, so this is how stopped ones still get listed.
 */
async function quadlets() {
  const files = (await readdir(QUADLET_DIR).catch(() => [])).filter((f) => f.endsWith('.container'));
  return Promise.all(
    files.map(async (f) => {
      const text = await readFile(path.join(QUADLET_DIR, f), 'utf8');
      const base = f.slice(0, -'.container'.length);
      return {
        name: /^ContainerName=(.+)$/m.exec(text)?.[1].trim() ?? `systemd-${base}`,
        image: /^Image=(.+)$/m.exec(text)?.[1].trim(),
        unit: `${base}.service`,
      };
    }),
  );
}

/**
 * A reading that's slow to take and asked for every few seconds. One younger than `staleMs` is
 * answered as is, and one younger than `maxAgeMs` is answered while a fresh one is taken in the
 * background. After changing what it reads, `expire` makes the next call wait for a fresh one.
 */
function backgroundRefreshed(take, { staleMs, maxAgeMs, label }) {
  let value;
  let at = 0;
  let pending;
  // Bumped on expiry, so a reading that started before a change isn't kept as fresh.
  let generation = 0;

  function refresh() {
    if (pending) return pending;
    const started = generation;
    const reading = take()
      .then((v) => {
        if (started === generation) {
          value = v;
          at = Date.now();
        }
        return v;
      })
      .finally(() => {
        if (pending === reading) pending = undefined;
      });
    pending = reading;
    return reading;
  }

  return {
    async get() {
      const age = Date.now() - at;
      if (age >= maxAgeMs) return refresh();
      if (age >= staleMs) refresh().catch((e) => console.error(`${label} failed:`, e.message));
      return value;
    },
    refresh,
    expire() {
      generation++;
      at = 0;
      pending = undefined;
    },
  };
}

/** The last list, for readings that need a container's process without asking Podman again. */
let lastPods = [];

/** `podman ps` takes ~60 ms, and most screens ask for it every few seconds. */
const containerList = backgroundRefreshed(
  async () => {
    const { stdout } = await run('podman', ['ps', '--all', '--format', 'json']);
    lastPods = JSON.parse(stdout || '[]');
    return lastPods;
  },
  { staleMs: 2000, maxAgeMs: 10_000, label: 'podman ps' },
);

const containers = () => containerList.get();

/** After starting or stopping something, so the next look waits for what it's doing now. */
function expireServices() {
  containerList.expire();
  for (const c of unitReadings.values()) c.expire();
  unitReadings.clear();
}

/** Everything the dashboard lists, with what each one can do. */
async function services() {
  const [pods, quadletList, groups] = await Promise.all([
    containers().catch((e) => {
      console.error('podman ps failed:', e.message);
      return [];
    }),
    quadlets().catch((e) => {
      console.error('Reading Quadlet files failed:', e.message);
      return [];
    }),
    groupUsage().catch((e) => {
      console.error('Reading cgroups failed:', e.message);
      return [];
    }),
  ]);
  const usageById = serviceGroups(groups, pods);
  const gone = quadletList.filter((q) => !pods.some((p) => p.Names?.includes(q.name)));
  const quadletUnits = [...pods.map((p) => p.Labels?.PODMAN_SYSTEMD_UNIT).filter(Boolean), ...gone.map((q) => q.unit)];
  const timerTargets = UNITS.filter((u) => u.runs).map((u) => u.runs);
  const [userProps, systemProps] = await Promise.all([
    showUnits([...quadletUnits, ...UNITS.filter((u) => !u.system).map((u) => u.unit), ...timerTargets], false),
    showUnits(UNITS.filter((u) => u.system).map((u) => u.unit), true),
  ]);

  const list = pods.map((p) => {
    const name = p.Names?.[0] ?? p.Id.slice(0, 12);
    const unit = p.Labels?.PODMAN_SYSTEMD_UNIT;
    const props = unit && userProps[unit];
    const running = p.State === 'running';
    const health = /\((healthy|unhealthy|starting)\)/.exec(p.Status ?? '')?.[1];
    return {
      id: `container:${name}`,
      name,
      kind: 'container',
      detail: p.Image?.replace(/^docker\.io\/(library\/)?/, ''),
      state: props ? unitState(props) : running ? 'running' : p.State === 'created' || p.State === 'exited' ? 'stopped' : 'changing',
      health,
      since: running ? p.StartedAt * 1000 : p.ExitedAt ? p.ExitedAt * 1000 : undefined,
      restarts: Number(props?.NRestarts) || 0,
      actions: running ? ['restart', 'stop'] : ['start'],
    };
  });

  for (const q of gone) {
    const state = unitState(userProps[q.unit] ?? {});
    list.push({
      id: `container:${q.name}`,
      name: q.name,
      kind: 'container',
      detail: q.image?.replace(/^docker\.io\/(library\/)?/, ''),
      state,
      actions: state === 'changing' ? [] : ['start'],
    });
  }

  for (const u of UNITS) {
    const props = (u.system ? systemProps : userProps)[u.unit] ?? {};
    if (u.runs) {
      const job = userProps[u.runs] ?? {};
      const state = job.ActiveState === 'failed' ? 'failed' : job.ActiveState === 'activating' ? 'changing' : unitState(props);
      list.push({
        id: `unit:${u.id}`,
        name: u.name,
        kind: 'timer',
        detail: job.Result && job.Result !== 'success' ? `Last run: ${job.Result}` : undefined,
        state,
        lastRun: unixTimestamp(props.LastTriggerUSec),
        nextRun: unixTimestamp(props.NextElapseUSecRealtime),
        actions: state === 'changing' ? [] : ['run'],
      });
      continue;
    }
    const state = unitState(props);
    list.push({
      id: `unit:${u.id}`,
      name: u.name,
      kind: 'service',
      detail: state === 'failed' && props.Result ? `Failed: ${props.Result}` : undefined,
      state,
      since: unixTimestamp(props.ActiveEnterTimestamp),
      restarts: Number(props.NRestarts) || 0,
      actions: u.system ? [] : u.self ? ['restart'] : state === 'running' ? ['restart', 'stop'] : ['start'],
    });
  }
  for (const s of list) {
    const g = usageById.get(s.id);
    // A stopped unit's cgroup can linger with leftover cache; don't show that as usage.
    if (g && s.state !== 'stopped') s.usage = usageOf(g);
  }
  return list;
}

/**
 * Starts a container that isn't a Quadlet in a transient systemd unit of its own. Started
 * directly, it would land in this service's cgroup, inherit its sandbox, and be killed whenever
 * this server restarts. `podman start --attach` stays in the foreground, so the unit lives as
 * long as the container and its output goes to the journal.
 */
async function startContainerUnit(name, restart) {
  const unit = `container-${name}.service`;
  if (restart) {
    await run('podman', ['stop', name], { timeout: 120_000 });
    // The unit ends once `podman start --attach` notices; wait so the name is free again.
    for (let i = 0; i < 50; i++) {
      const state = await run('systemctl', ['--user', 'is-active', unit]).then((r) => r.stdout.trim(), (e) => e.stdout?.trim());
      if (state !== 'active' && state !== 'deactivating') break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await run('systemctl', ['--user', 'reset-failed', unit]).catch(() => {});
  await run(
    'systemd-run',
    ['--user', '--collect', `--unit=${unit}`, `--description=Podman container ${name}`, 'podman', 'start', '--attach', name],
    { timeout: 30_000 },
  );
}

async function performAction(id, action) {
  intents.set(id, { by: 'you', at: Date.now() });
  try {
    await changeService(id, action);
  } finally {
    expireServices();
  }
}

async function changeService(id, action) {
  const [kind, name] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (kind === 'container') {
    if (!['start', 'stop', 'restart'].includes(action)) throw new HttpError(400, `Can't ${action} a container`);
    const pod = (await containerList.refresh()).find((p) => p.Names?.includes(name));
    if (!pod) {
      // A stopped Quadlet container no longer exists; its unit creates it again.
      const q = (await quadlets()).find((x) => x.name === name);
      if (!q) throw new HttpError(404, `No container named ${name}`);
      await run('systemctl', ['--user', action === 'stop' ? 'stop' : 'start', q.unit], { timeout: 120_000 });
      return;
    }
    // Quadlet containers go through systemd, which would otherwise restart or fight a direct
    // podman command.
    const unit = pod.Labels?.PODMAN_SYSTEMD_UNIT;
    if (unit) await run('systemctl', ['--user', action, unit], { timeout: 120_000 });
    else if (action === 'stop') await run('podman', ['stop', name], { timeout: 120_000 });
    else await startContainerUnit(name, action === 'restart');
    return;
  }

  const u = UNITS.find((x) => x.id === name);
  if (kind !== 'unit' || !u) throw new HttpError(404, `No service ${id}`);
  if (u.system) throw new HttpError(403, `${u.name} is read-only`);
  if (u.runs) {
    if (action !== 'run') throw new HttpError(400, `Can't ${action} a timer`);
    await run('systemctl', ['--user', 'start', '--no-block', u.runs]);
    return;
  }
  if (!['start', 'stop', 'restart'].includes(action)) throw new HttpError(400, `Can't ${action} a service`);
  if (u.self) {
    if (action !== 'restart') throw new HttpError(400, 'The status server can only be restarted');
    // Answer first; the restart stops this process.
    setTimeout(() => run('systemctl', ['--user', 'restart', u.unit]).catch(console.error), 500);
    return;
  }
  await run('systemctl', ['--user', action, u.unit], { timeout: 120_000 });
}

// ---------------------------------------------------------------------------------------------
// Logs

const LOG_LINES = 300;
const LOG_ERRORS = 'error|fatal|exception|fail|warn|crit|panic|traceback|denied';
// Sonarr and Prowlarr put API keys in the URLs they log.
const SECRET_IN_LOG = /((?:api[_-]?key|token|password|passkey|secret)["']?\s*[=:]\s*["']?)[^\s&"',;]+/gi;
const BEARER_IN_LOG = /(Bearer\s+)[\w.~+/=-]+/gi;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** journalctl arguments that pick out one dashboard service's journal. */
async function logSource(id) {
  const [kind, name] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (kind === 'container') {
    const pod = (await containers()).find((p) => p.Names?.includes(name));
    const unit = pod?.Labels?.PODMAN_SYSTEMD_UNIT ?? (await quadlets()).find((q) => q.name === name)?.unit;
    if (unit) return ['--user', '-u', unit];
    if (pod) return ['--user', `CONTAINER_NAME=${name}`];
    throw new HttpError(404, `No container named ${name}`);
  }
  const u = UNITS.find((x) => x.id === name);
  if (kind !== 'unit' || !u) throw new HttpError(404, `No service ${id}`);
  return [...(u.system ? [] : ['--user']), '-u', u.runs ?? u.unit];
}

/**
 * The last lines a service wrote, or with `after` (the cursor from an earlier call) only what
 * came since. `errors` keeps lines that mention an error, failure or warning. `since` and `until`
 * (ms) keep to a stretch of time.
 */
async function serviceLogs(id, { after, errors, since, until, lines: count = LOG_LINES }) {
  const args = [...(await logSource(id)), '--no-pager', '-o', 'json', '--output-fields=MESSAGE,PRIORITY', '-n', String(count)];
  if (after) args.push(`--after-cursor=${after}`);
  if (since) args.push(`--since=@${Math.floor(since / 1000)}`);
  if (until) args.push(`--until=@${Math.ceil(until / 1000)}`);
  if (errors) args.push(`--grep=${LOG_ERRORS}`, '--case-sensitive=false');
  // journalctl exits 1 when --grep matches nothing.
  const { stdout } = await run('journalctl', args, { maxBuffer: 32 * 1024 * 1024, timeout: 15_000 }).catch((e) => {
    if (e.code === 1 && !e.stderr?.trim()) return { stdout: e.stdout ?? '' };
    throw e;
  });
  const lines = [];
  let cursor = after;
  for (const row of stdout.split('\n')) {
    if (!row) continue;
    const entry = JSON.parse(row);
    cursor = entry.__CURSOR;
    // Messages that aren't valid UTF-8 come as arrays of bytes.
    let text = Array.isArray(entry.MESSAGE) ? Buffer.from(entry.MESSAGE).toString('utf8') : String(entry.MESSAGE ?? '');
    text = text.replace(ANSI, '').replace(SECRET_IN_LOG, '$1•••').replace(BEARER_IN_LOG, '$1•••').trimEnd();
    if (!text) continue;
    lines.push({ at: Math.round(Number(entry.__REALTIME_TIMESTAMP) / 1000), priority: Number(entry.PRIORITY ?? 6), text });
  }
  return { lines, cursor, at: Date.now() };
}

// ---------------------------------------------------------------------------------------------
// Tailscale

/** Tailscale leaves times it doesn't know at year 1. */
const tailscaleTime = (s) => (s && !s.startsWith('0001-') ? Date.parse(s) : undefined);

function tailscaleDevice(p, self) {
  return {
    id: p.ID,
    name: p.DNSName?.split('.')[0] || p.HostName,
    os: p.OS,
    ips: p.TailscaleIPs ?? [],
    self,
    online: !!p.Online,
    // Traffic in the last couple of minutes.
    active: !!p.Active,
    lastSeen: tailscaleTime(p.LastSeen),
    // A direct address once one is found; until then traffic goes through Tailscale's relay.
    direct: p.CurAddr || undefined,
    relay: p.Relay || undefined,
    rxBytes: p.RxBytes ?? 0,
    txBytes: p.TxBytes ?? 0,
    keyExpiry: tailscaleTime(p.KeyExpiry),
    exitNode: !!p.ExitNode,
    offersExitNode: !!p.ExitNodeOption,
  };
}

async function tailscale() {
  const { stdout } = await run('tailscale', ['status', '--json'], { timeout: 10_000 });
  const s = JSON.parse(stdout);
  const peers = Object.values(s.Peer ?? {}).map((p) => tailscaleDevice(p, false));
  peers.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return {
    state: s.BackendState,
    version: s.Version?.split('-')[0],
    tailnet: s.CurrentTailnet?.Name,
    health: s.Health ?? [],
    devices: [tailscaleDevice(s.Self, true), ...peers],
    at: Date.now(),
  };
}

// ---------------------------------------------------------------------------------------------
// Storage

const MEDIA_ROOT = process.env.MEDIA_ROOT ?? '/mnt/media';
/**
 * What the media drive holds, in this order: du counts a hardlinked file only the first time it
 * sees it, so downloads that are also in the library count toward the library.
 */
const MEDIA_FOLDERS = [
  { id: 'shows', dir: 'Shows', label: 'Shows' },
  { id: 'movies', dir: 'Movies', label: 'Movies' },
  { id: 'youtube', dir: 'YouTube', label: 'Videos' },
  // tv/ and movies/ hold the torrents; list those rather than the two folders.
  { id: 'downloads', dir: 'Downloads', label: 'Downloads', depth: 2 },
  { id: 'conversions', dir: '.tdarr-cache', label: 'Conversion cache' },
  { id: 'partial', dir: '.youtube-partial', label: 'Unfinished videos' },
  { id: 'backups', dir: 'Backups', label: 'Backups' },
  { id: 'trash', dir: '.Trash-1000', label: 'Trash' },
];
const STORAGE_ITEMS = 8;

/** Parses `du -B1` output into sizes by path. */
function duSizes(stdout) {
  const sizes = new Map();
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab > 0) sizes.set(line.slice(tab + 1), Number(line.slice(0, tab)));
  }
  return sizes;
}

async function du(args) {
  // du exits 1 when it can't read something (lost+found) but still prints the rest.
  const { stdout } = await run('du', ['-B1', '-x', ...args], { cwd: MEDIA_ROOT, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }).catch(
    (e) => {
      if (e.stdout) return e;
      throw e;
    },
  );
  return duSizes(stdout);
}

async function storage() {
  const present = [];
  for (const f of MEDIA_FOLDERS) if (await stat(path.join(MEDIA_ROOT, f.dir)).catch(() => undefined)) present.push(f);
  const [sizes, downloadsAlone, fs] = await Promise.all([
    du(['-d', '2', ...present.map((f) => f.dir)]),
    present.some((f) => f.id === 'downloads') ? du(['-s', 'Downloads']) : new Map(),
    statfs(MEDIA_ROOT),
  ]);
  const categories = present.map((f) => {
    const depth = f.depth ?? 1;
    const items = [...sizes]
      .filter(([p]) => p.startsWith(`${f.dir}/`) && p.split('/').length === depth + 1)
      .map(([p, bytes]) => ({ name: p.split('/').pop(), bytes }))
      .filter((i) => i.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes);
    return {
      id: f.id,
      label: f.label,
      bytes: sizes.get(f.dir) ?? 0,
      items: items.slice(0, STORAGE_ITEMS),
      more: Math.max(0, items.length - STORAGE_ITEMS),
    };
  });
  const totalBytes = fs.blocks * fs.bsize;
  const downloads = categories.find((c) => c.id === 'downloads');
  return {
    mount: MEDIA_ROOT,
    totalBytes,
    usedBytes: totalBytes - fs.bfree * fs.bsize,
    availableBytes: fs.bavail * fs.bsize,
    categories,
    // Downloads that are hardlinked into the library and so take no extra room.
    sharedDownloadBytes: downloads ? Math.max(0, (downloadsAlone.get('Downloads') ?? 0) - downloads.bytes) : 0,
    at: Date.now(),
  };
}

async function status() {
  const [mem, temps, gpu, diskList, serviceList] = await Promise.all([
    memory(),
    temperatures(),
    gpuBusy(),
    disks(),
    services(),
  ]);
  return {
    host: {
      name: os.hostname(),
      uptimeSec: Math.round(os.uptime()),
      kernel: os.release(),
    },
    cpu: { usage: rates.cpu, load: os.loadavg(), cores: os.availableParallelism() },
    gpu: { usage: gpu },
    memory: mem,
    network: { rxPerSec: rates.rxPerSec, txPerSec: rates.txPerSec },
    temperatures: temps,
    disks: diskList,
    services: serviceList,
    gameMode: gameModeState(),
    at: Date.now(),
  };
}

// ---------------------------------------------------------------------------------------------
// History: a reading every 15 seconds, kept for a day, and averages of them kept longer: every
// 10 minutes for a week, every hour for a month and every 6 hours for a year. Each tier is a file
// with one JSON line per entry, appended as it's made and rewritten without the entries too old
// to keep every few hours, so the disk isn't rewritten all the time.
//
// An entry is { t, n, a, m }: when it starts, how many readings it stands for (1 for a reading,
// left out), the average of each key over them, and the peak of each machine-wide key (left out
// for a reading, whose peak is its value). A key that's missing had no reading, like a service
// that wasn't running. Keys:
//   cpu gpu (share busy), mem cache swap vram (bytes), rx tx (bytes/s), temp gtemp (°C),
//   cpow gpow (watts), clock (average core MHz), pcpu pmem pio (share of time stalled),
//   conv (files Tdarr is converting),
//   d:<drive>:r|w (bytes/s), d:<drive>:busy (share), d:<drive>:temp (°C),
//   s:<service>:mem (bytes), s:<service>:cpu (share), s:<service>:r|w|rx|tx (bytes/s),
//   t:<device>:rx|tx (bytes/s, as the server sees it: rx came from the device).

const HISTORY_INTERVAL = 15_000;
const HISTORY_COMPACT_INTERVAL = 6 * 3600_000;
const HISTORY_POINTS = 120;
const HISTORY_MAX_MS = 366 * DAY_MS;
/** Before the tiers, the last day was kept in one file, rewritten every few minutes. */
const OLD_HISTORY_PATH = path.join(ROOT, 'history.json');

const TIERS = [
  { name: 'raw', step: HISTORY_INTERVAL, keep: DAY_MS },
  { name: '10m', step: 10 * 60_000, keep: 7 * DAY_MS },
  { name: '1h', step: 3600_000, keep: 31 * DAY_MS },
  { name: '6h', step: 6 * 3600_000, keep: HISTORY_MAX_MS },
].map((t) => ({ ...t, path: path.join(ROOT, `history-${t.name}.jsonl`), entries: [], pending: undefined }));

/** Peaks are kept for these, not for every service, drive and device, to keep the files small. */
const isMachineKey = (key) => !key.includes(':');

/** Whole numbers from 100 up, three decimals below. */
const trim = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 1000) / 1000);

async function readJsonLines(file) {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return []; // A line cut short when the server stopped.
      }
    });
}

async function writeJsonLines(file, entries) {
  await writeFile(`${file}.tmp`, entries.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

function appendEntry(tier, entry) {
  tier.entries.push(entry);
  appendFile(tier.path, JSON.stringify(entry) + '\n', { mode: 0o600 }).catch((e) => console.error(`Couldn't save ${tier.name} history:`, e.message));
}

/**
 * Adds an entry of the tier below to tier `i`'s average in the making. When the entry belongs to
 * a later step, the finished average is saved and, with `cascade`, passed up a tier in turn.
 */
function feedTier(i, entry, cascade = true) {
  const tier = TIERS[i];
  const start = Math.floor(entry.t / tier.step) * tier.step;
  if (tier.pending && tier.pending.t !== start) {
    const done = finishPending(tier.pending);
    tier.pending = undefined;
    appendEntry(tier, done);
    if (cascade && TIERS[i + 1]) feedTier(i + 1, done);
  }
  tier.pending ??= { t: start, n: 0, sum: {}, weight: {}, peak: {} };
  const p = tier.pending;
  const n = entry.n ?? 1;
  p.n += n;
  for (const [k, v] of Object.entries(entry.a)) {
    p.sum[k] = (p.sum[k] ?? 0) + v * n;
    p.weight[k] = (p.weight[k] ?? 0) + n;
    if (isMachineKey(k)) {
      const peak = entry.m?.[k] ?? v;
      if (!(p.peak[k] >= peak)) p.peak[k] = peak;
    }
  }
}

function finishPending(p) {
  const a = {};
  for (const k of Object.keys(p.sum)) a[k] = trim(p.sum[k] / p.weight[k]);
  const m = {};
  for (const [k, v] of Object.entries(p.peak)) m[k] = trim(v);
  return { t: p.t, n: p.n, a, m };
}

/** An entry from the single file kept before the tiers. */
function fromOldEntry(h) {
  const a = {};
  for (const k of ['cpu', 'gpu', 'mem', 'cache', 'swap', 'rx', 'tx', 'temp', 'gtemp', 'gpow', 'vram']) {
    if (typeof h[k] === 'number') a[k] = h[k];
  }
  for (const [id, [mem, cpu]] of Object.entries(h.s ?? {})) {
    a[`s:${id}:mem`] = mem;
    if (typeof cpu === 'number') a[`s:${id}:cpu`] = cpu;
  }
  return { t: h.t, a };
}

async function loadHistory() {
  const now = Date.now();
  for (const tier of TIERS) {
    const all = await readJsonLines(tier.path);
    tier.entries = all.filter((e) => e.t > now - tier.keep);
    if (tier.entries.length < all.length) await writeJsonLines(tier.path, tier.entries);
  }
  const raw = TIERS[0];
  const old = await readFile(OLD_HISTORY_PATH, 'utf8').then(JSON.parse, () => undefined);
  if (Array.isArray(old)) {
    const first = raw.entries[0]?.t ?? Infinity;
    raw.entries = [...old.filter((h) => h.t > now - raw.keep && h.t < first).map(fromOldEntry), ...raw.entries];
    await writeJsonLines(raw.path, raw.entries);
    await rename(OLD_HISTORY_PATH, `${OLD_HISTORY_PATH}.old`);
  }
  // The averages being made when the server last stopped, from the readings since the last one saved.
  for (let i = 1; i < TIERS.length; i++) {
    const last = TIERS[i].entries.at(-1);
    const after = last ? last.t + TIERS[i].step : 0;
    for (const e of TIERS[i - 1].entries) if (e.t >= after) feedTier(i, e, false);
  }
}

async function compactHistory() {
  const now = Date.now();
  for (const tier of TIERS) {
    const keep = tier.entries.filter((e) => e.t > now - tier.keep);
    if (keep.length === tier.entries.length) continue;
    tier.entries = keep;
    await writeJsonLines(tier.path, keep).catch((e) => console.error(`Couldn't compact ${tier.name} history:`, e.message));
  }
  events = events.filter((e) => e.t > now - HISTORY_MAX_MS);
  await writeJsonLines(EVENTS_PATH, events).catch((e) => console.error("Couldn't compact events:", e.message));
}

async function recordHistory() {
  try {
    const card = await gpuCard();
    const [info, temps, gpu, list, gpuSense, vram, press, clocks] = await Promise.all([
      meminfo(),
      temperatures(),
      gpuBusy(),
      services(),
      card ? gpuSensors(card) : undefined,
      card ? readNumber(`${card}/mem_info_vram_used`) : undefined,
      pressure(10),
      cpuClocks(),
    ]);
    const nets = await sampleContainerNet(lastPods);
    // Files Tdarr is converting; nothing while it's stopped.
    const tdarrRunning = list.some((x) => x.id === 'container:tdarr' && x.state === 'running');
    const converting = tdarrRunning
      ? await tdarr('get-nodes').then((nodes) => Object.values(nodes ?? {}).reduce((n, node) => n + Object.keys(node.workers ?? {}).length, 0), () => undefined)
      : undefined;
    noteServiceChanges(list);
    lastServices = list;

    const mem = memoryBreakdown(info);
    const a = {};
    const put = (key, v) => {
      if (typeof v === 'number' && Number.isFinite(v)) a[key] = trim(v);
    };
    put('cpu', rates.cpu);
    put('gpu', gpu);
    put('mem', mem.totalBytes - mem.availableBytes);
    put('cache', mem.cacheBytes);
    put('swap', mem.swapUsedBytes);
    put('rx', rates.rxPerSec);
    put('tx', rates.txPerSec);
    put('temp', temps.find((t) => t.label === 'CPU')?.celsius);
    put('gtemp', gpuSense?.temperatures.find((t) => t.label === 'Hotspot')?.celsius ?? gpuSense?.temperatures[0]?.celsius);
    put('gpow', gpuSense?.power?.watts);
    put('vram', vram);
    put('cpow', rates.cpuWatts);
    put('clock', clocks.length ? clocks.reduce((sum, c) => sum + c, 0) / clocks.length / 1000 : undefined);
    put('pcpu', press.cpu);
    put('pmem', press.memory);
    put('pio', press.io);
    put('conv', converting);
    for (const d of driveInfo) {
      const r = d.device && diskRates.get(d.device);
      if (r) {
        put(`d:${d.id}:r`, r.readPerSec);
        put(`d:${d.id}:w`, r.writePerSec);
        put(`d:${d.id}:busy`, r.busy);
      }
      put(`d:${d.id}:temp`, d.temperature);
    }
    for (const s of list) {
      if (!s.usage) continue;
      put(`s:${s.id}:mem`, s.usage.usedBytes);
      put(`s:${s.id}:cpu`, s.usage.cpu);
      put(`s:${s.id}:r`, s.usage.readPerSec);
      put(`s:${s.id}:w`, s.usage.writePerSec);
      const net = nets.get(s.id);
      if (net) {
        put(`s:${s.id}:rx`, net.rxPerSec);
        put(`s:${s.id}:tx`, net.txPerSec);
      }
    }
    for (const [name, r] of peerRates) {
      put(`t:${name}:rx`, r.rxPerSec);
      put(`t:${name}:tx`, r.txPerSec);
    }

    const entry = { t: Date.now(), a };
    const raw = TIERS[0];
    appendEntry(raw, entry);
    feedTier(1, entry);
    while (raw.entries.length && raw.entries[0].t < entry.t - raw.keep) raw.entries.shift();
  } catch (e) {
    console.error('Recording history failed:', e);
  }
}

/**
 * The entries covering `start` until now: from the finest tier that reaches back that far, then
 * the readings newer than its last average.
 */
function historyEntries(start) {
  const tier = TIERS.find((t) => t.keep >= Date.now() - start) ?? TIERS.at(-1);
  const raw = TIERS[0];
  if (tier === raw) return raw.entries.filter((e) => e.t >= start);
  const last = tier.entries.at(-1);
  const after = Math.max(start, last ? last.t + tier.step : 0);
  return [...tier.entries.filter((e) => e.t >= start), ...raw.entries.filter((e) => e.t >= after)];
}

/**
 * Each of `keys` (name → key) over the entries, averaged into `HISTORY_POINTS` evenly spaced
 * buckets so the app gets as many points for an hour as for a year. A bucket without readings is
 * null. Each also gets its average and peak over the whole range, and its total (value ×
 * seconds), which makes bytes of a rate and joules of watts.
 */
function summarize(entries, keys, start, end, points = HISTORY_POINTS) {
  const step = (end - start) / points;
  const acc = Object.entries(keys).map(([name, key]) => ({
    name,
    key,
    sums: new Array(points).fill(0),
    weights: new Array(points).fill(0),
    sum: 0,
    weight: 0,
    peak: undefined,
  }));
  for (const e of entries) {
    const n = e.n ?? 1;
    const i = Math.min(points - 1, Math.max(0, Math.floor((e.t - start) / step)));
    for (const s of acc) {
      const v = e.a[s.key];
      if (typeof v !== 'number') continue;
      s.sums[i] += v * n;
      s.weights[i] += n;
      s.sum += v * n;
      s.weight += n;
      const peak = e.m?.[s.key] ?? v;
      if (s.peak === undefined || peak > s.peak) s.peak = peak;
    }
  }
  return Object.fromEntries(
    acc.map((s) => [
      s.name,
      {
        values: s.sums.map((sum, i) => (s.weights[i] ? sum / s.weights[i] : null)),
        average: s.weight ? s.sum / s.weight : undefined,
        peak: s.peak,
        total: (s.sum * HISTORY_INTERVAL) / 1000,
      },
    ]),
  );
}

/** Totals and averages of every key matching `pattern` (its first group names it), without buckets. */
function totals(entries, pattern) {
  const out = new Map();
  for (const e of entries) {
    const n = e.n ?? 1;
    for (const [k, v] of Object.entries(e.a)) {
      const name = pattern.exec(k)?.[1];
      if (name === undefined) continue;
      const t = out.get(name) ?? { sum: 0, weight: 0 };
      t.sum += v * n;
      t.weight += n;
      out.set(name, t);
    }
  }
  return new Map([...out].map(([k, t]) => [k, { total: (t.sum * HISTORY_INTERVAL) / 1000, average: t.sum / t.weight, readings: t.weight }]));
}

/** How many readings the entries stand for, which `totals` readings can be compared with. */
const readingCount = (entries) => entries.reduce((sum, e) => sum + (e.n ?? 1), 0);

const SYSTEM_SERIES = {
  cpu: 'cpu',
  gpu: 'gpu',
  memory: 'mem',
  cache: 'cache',
  swap: 'swap',
  rx: 'rx',
  tx: 'tx',
  temp: 'temp',
  gpuTemp: 'gtemp',
  gpuPower: 'gpow',
  vram: 'vram',
  cpuPower: 'cpow',
  cpuClock: 'clock',
  pressureCpu: 'pcpu',
  pressureMemory: 'pmem',
  pressureIo: 'pio',
  converting: 'conv',
};

/** The series for the whole machine, a service, a drive or a Tailscale device, with what happened meanwhile. */
function historyFor(rangeSec, { service, drive, device } = {}) {
  const end = Date.now();
  const start = end - rangeSec * 1000;
  let keys = SYSTEM_SERIES;
  let related = (e) => e.kind !== 'problem' && e.kind !== 'resolved';
  if (service) {
    keys = { memory: 'mem', cpu: 'cpu', read: 'r', write: 'w', rx: 'rx', tx: 'tx' };
    keys = Object.fromEntries(Object.entries(keys).map(([name, k]) => [name, `s:${service}:${k}`]));
    related = (e) => e.id === service || e.kind === 'boot';
  } else if (drive) {
    keys = { read: `d:${drive}:r`, write: `d:${drive}:w`, busy: `d:${drive}:busy`, temp: `d:${drive}:temp` };
    related = (e) => e.kind === 'boot' || e.drive === drive;
  } else if (device) {
    keys = { rx: `t:${device}:rx`, tx: `t:${device}:tx` };
    related = () => false;
  }
  const entries = historyEntries(start);
  return {
    start,
    end,
    step: (end - start) / HISTORY_POINTS,
    series: summarize(entries, keys, start, end),
    events: events.filter((e) => e.t >= start && related(e)),
    oldest: TIERS.map((t) => t.entries[0]?.t).filter(Boolean).reduce((a, b) => Math.min(a, b), end),
    memoryTotalBytes: os.totalmem(),
  };
}

// ---------------------------------------------------------------------------------------------
// Events: what happened to the services and the machine, kept a year in `events.jsonl`. Starts,
// stops and restarts are noticed by comparing each reading's services with the last; who caused
// them is worked out from what this server itself did around then.

const EVENTS_PATH = path.join(ROOT, 'events.jsonl');
/** How long after an action its effects are put down to it. */
const INTENT_MS = 3 * 60_000;

/** { t, kind, id?, name?, by?, detail?, drive? }, oldest first. */
let events = [];
/** Service id → { by, at } for actions taken from the app. */
const intents = new Map();
/** Each service's last settled state, to compare the next reading with. */
let lastStates;
/** The services as of the last reading, for their names. */
let lastServices;

function addEvent(kind, fields = {}, t = Date.now()) {
  const e = { t, kind, ...fields };
  events.push(e);
  appendFile(EVENTS_PATH, JSON.stringify(e) + '\n', { mode: 0o600 }).catch((err) => console.error("Couldn't save event:", err.message));
  return e;
}

async function loadEvents() {
  const now = Date.now();
  events = (await readJsonLines(EVENTS_PATH)).filter((e) => e.t > now - HISTORY_MAX_MS);
  // Boots the journal remembers, and this one. The boot time worked out from the uptime moves by
  // a second or so between starts, and the journal's first entry comes a little after it.
  const { stdout } = await run('journalctl', ['--list-boots', '-o', 'json', '--no-pager']).catch((e) => e);
  let boots = [];
  try {
    boots = JSON.parse(stdout || '[]').map((b) => Math.round(b.first_entry / 1000));
  } catch {}
  boots.push(Math.round(now - os.uptime() * 1000));
  for (const boot of boots) {
    if (boot > now - HISTORY_MAX_MS && !events.some((e) => e.kind === 'boot' && Math.abs(e.t - boot) < 5 * 60_000)) {
      addEvent('boot', {}, boot);
    }
  }
  events.sort((a, b) => a.t - b.t);
  // Memory kills since the last one logged, including any while this server was down.
  const lastOom = events.findLast((e) => e.kind === 'oom')?.t ?? 0;
  journalCheckedAt = Math.max(lastOom + 1, now - 31 * DAY_MS);
}

/** Why a service started or stopped just now, when this server knows. */
function causeOf(s, now) {
  const intent = intents.get(s.id);
  if (intent && now - intent.at < INTENT_MS) return intent.by;
  const name = s.id.slice(s.id.indexOf(':') + 1);
  if (gameMode.since && now - gameMode.since < INTENT_MS && GAME_MODE_UNITS.includes(name)) return 'game mode';
  if (onDemandUnit(`${name}.service`)) return 'on demand';
  return undefined;
}

function noteServiceChanges(list) {
  const now = Date.now();
  const next = new Map(lastStates);
  for (const s of list) {
    // Mid-change states settle by the next reading or two; compare settled ones.
    if (s.state === 'changing') continue;
    next.set(s.id, { state: s.state, since: s.since, restarts: s.restarts ?? 0 });
    const prev = lastStates?.get(s.id);
    if (!prev) continue;
    const base = { id: s.id, name: s.name };
    if (s.restarts > prev.restarts) {
      addEvent('crashed', { ...base, detail: 'Restarted by systemd' });
      notify(`${s.name} crashed`, 'It stopped unexpectedly and systemd restarted it.', 'boom', `homebase://server/service/${encodeURIComponent(s.id)}`);
    } else if (s.state === 'failed' && prev.state !== 'failed') {
      addEvent('failed', { ...base, detail: s.detail });
    } else if (s.state === 'stopped' && prev.state === 'running') {
      addEvent('stopped', { ...base, by: causeOf(s, now) });
    } else if (s.state === 'running' && prev.state !== 'running') {
      addEvent('started', { ...base, by: causeOf(s, now) });
    } else if (s.state === 'running' && s.since && prev.since && s.since !== prev.since) {
      addEvent('restarted', { ...base, by: causeOf(s, now) });
    }
  }
  lastStates = next;
}

// Memory kills: the kernel's OOM killer when memory runs out, and systemd-oomd, which kills a
// cgroup earlier when memory pressure stays high. Both are read from the journal.

const OOM_PATTERN = 'oom-kill:|^Killed .* due to memory';
let journalCheckedAt = Date.now();
/** Kills found looking back on the first start are logged without a notification. */
const startedAt = Date.now();

/** The service a cgroup path belongs to, or a readable name for it. */
function serviceOfCgroup(cgroup) {
  const units = new Map();
  for (const p of lastPods) {
    const name = p.Names?.[0];
    if (!name) continue;
    if (p.Labels?.PODMAN_SYSTEMD_UNIT) units.set(p.Labels.PODMAN_SYSTEMD_UNIT, { id: `container:${name}`, name });
    units.set(`libpod-${p.Id}.scope`, { id: `container:${name}`, name });
  }
  for (const u of UNITS) units.set(u.runs ?? u.unit, { id: `unit:${u.id}`, name: u.name });
  const parts = cgroup.split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const found = units.get(parts[i]);
    if (found) return found;
  }
  // The outermost unit, so a terminal's tab counts as the terminal.
  const unit = parts.find((p) => /\.(service|scope)$/.test(p) && !p.startsWith('user@'));
  return { name: unit ? groupLabel(unit) : cgroup };
}

async function checkJournal() {
  const since = journalCheckedAt;
  journalCheckedAt = Date.now();
  const args = ['-o', 'json', '--no-pager', '-q', '--since', `@${Math.floor(since / 1000)}`, '-g', OOM_PATTERN];
  // Exits with 1 when nothing matches.
  const { stdout } = await run('journalctl', [...args, '_TRANSPORT=kernel', '+', '_SYSTEMD_UNIT=systemd-oomd.service'], {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  }).catch((e) => e);
  for (const line of (stdout ?? '').split('\n').filter(Boolean)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const t = Math.round(Number(entry.__REALTIME_TIMESTAMP) / 1000);
    if (t < since || events.some((e) => e.kind === 'oom' && e.t === t)) continue;
    const message = String(entry.MESSAGE ?? '');
    const kernel = /task_memcg=([^,\s]+),task=([^,\s]+)/.exec(message);
    const oomd = /^Killed (\S+) due to memory (\w+)/.exec(message);
    if (!kernel && !oomd) continue;
    const owner = serviceOfCgroup(kernel ? kernel[1] : oomd[1]);
    const detail = kernel ? `Ran out of memory; the kernel killed ${kernel[2]}` : 'Killed by systemd-oomd under memory pressure';
    addEvent('oom', { id: owner.id, name: owner.name, detail }, t);
    if (t < startedAt - 5 * 60_000) continue;
    notify(`${owner.name} was killed for memory`, detail, 'skull', owner.id ? `homebase://server/service/${encodeURIComponent(owner.id)}` : undefined);
  }
}

/** Crashes, restarts and memory kills per service, running time, and the events, over the range. */
function reliability(rangeSec) {
  const end = Date.now();
  const start = end - rangeSec * 1000;
  const inRange = events.filter((e) => e.t >= start);
  const entries = historyEntries(start);
  const readings = readingCount(entries);
  const running = totals(entries, /^s:(.+):mem$/);
  const byId = new Map();
  const names = new Map((lastServices ?? []).map((s) => [s.id, s.name]));
  const row = (id, name) => {
    if (!byId.has(id)) byId.set(id, { id, name: names.get(id) ?? name ?? id, crashes: 0, failures: 0, oomKills: 0, restarts: 0, stops: 0 });
    return byId.get(id);
  };
  for (const s of lastServices ?? []) row(s.id, s.name);
  for (const e of inRange) {
    if (!e.id) continue;
    const r = row(e.id, e.name);
    if (e.kind === 'crashed') r.crashes++;
    else if (e.kind === 'failed') r.failures++;
    else if (e.kind === 'oom') r.oomKills++;
    else if (e.kind === 'restarted') r.restarts++;
    else if (e.kind === 'stopped' && !e.by) r.stops++;
  }
  for (const r of byId.values()) {
    // Share of the readings it was running for, of those the server took in the range.
    r.running = readings ? Math.min(1, (running.get(r.id)?.readings ?? 0) / readings) : undefined;
    r.lastTrouble = inRange.findLast((e) => e.id === r.id && ['crashed', 'failed', 'oom'].includes(e.kind))?.t;
  }
  return {
    start,
    end,
    oldest: TIERS.map((t) => t.entries[0]?.t).filter(Boolean).reduce((a, b) => Math.min(a, b), end),
    boots: inRange.filter((e) => e.kind === 'boot').map((e) => e.t),
    services: [...byId.values()].sort((a, b) => b.crashes + b.failures + b.oomKills - (a.crashes + a.failures + a.oomKills) || a.name.localeCompare(b.name)),
    events: inRange.slice(-300).reverse(),
    at: end,
  };
}

// ---------------------------------------------------------------------------------------------
// Drives: model, health and temperature from udisks, which reads the drives' SMART data every
// ten minutes and lets any user see it, and traffic from /proc/diskstats.

const DRIVE_REFRESH_INTERVAL = 10 * 60_000;
const DRIVE_HOT = { hdd: 55, ssd: 70, nvme: 75 };
/** Normalized SMART values for an SSD's remaining life, by attribute id. */
const LIFE_ATTRIBUTES = [177, 231, 202, 233];

/** [{ id, model, kind, sizeBytes, device, mounts, temperature, smart, health, issues }] */
let driveInfo = [];
let driveError;

async function udisksCall(objectPath, iface, method, signature, ...args) {
  const { stdout } = await run(
    'busctl',
    ['--json=short', 'call', 'org.freedesktop.UDisks2', objectPath, iface, method, ...(signature ? [signature, ...args] : [])],
    { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout).data;
}

/** D-Bus byte strings end in a NUL. */
const byteString = (bytes = []) => Buffer.from(bytes.filter(Boolean)).toString();

function ataAttributes(rows) {
  // [id, name, flags, value, worst, threshold, pretty, prettyUnit, expansion]
  return new Map(rows.map(([id, name, , value, worst, threshold, pretty, unit]) => [id, { name, value, worst, threshold, pretty, unit }]));
}

async function readDrive(objectPath, o, blocks) {
  const prop = (obj, iface, name) => obj[`org.freedesktop.UDisks2.${iface}`]?.[name]?.data;
  const mine = blocks.filter(([, b]) => prop(b, 'Block', 'Drive') === objectPath);
  // Encrypted volumes sit on a partition of the drive rather than on the drive itself.
  const backed = blocks.filter(([, b]) => mine.some(([p]) => p === prop(b, 'Block', 'CryptoBackingDevice')));
  const whole = mine.find(([, b]) => !b['org.freedesktop.UDisks2.Partition']);
  const mounts = [...mine, ...backed].flatMap(([, b]) => (prop(b, 'Filesystem', 'MountPoints') ?? []).map(byteString));
  const rotation = prop(o, 'Drive', 'RotationRate');
  const nvme = o['org.freedesktop.UDisks2.NVMe.Controller'];
  const ata = o['org.freedesktop.UDisks2.Drive.Ata'];
  const drive = {
    id: prop(o, 'Drive', 'Serial') || path.basename(objectPath),
    model: prop(o, 'Drive', 'Model') || 'Drive',
    kind: nvme ? 'nvme' : rotation === 0 ? 'ssd' : 'hdd',
    rpm: rotation > 0 ? rotation : undefined,
    sizeBytes: prop(o, 'Drive', 'Size'),
    device: whole ? path.basename(byteString(prop(whole[1], 'Block', 'Device'))) : undefined,
    mounts: [...new Set(mounts)].sort(),
    smart: undefined,
    issues: [],
  };
  const kelvin = (k) => (k > 0 ? Math.round((k - 273.15) * 10) / 10 : undefined);

  if (nvme) {
    const [attrs] = await udisksCall(objectPath, 'org.freedesktop.UDisks2.NVMe.Controller', 'SmartGetAttributes', 'a{sv}', '0').catch(() => [{}]);
    const a = (k) => attrs[k]?.data;
    const warnings = prop(o, 'NVMe.Controller', 'SmartCriticalWarning') ?? [];
    drive.temperature = kelvin(prop(o, 'NVMe.Controller', 'SmartTemperature'));
    drive.smart = {
      updated: (prop(o, 'NVMe.Controller', 'SmartUpdated') ?? 0) * 1000 || undefined,
      powerOnHours: prop(o, 'NVMe.Controller', 'SmartPowerOnHours'),
      lifeLeft: a('percent_used') !== undefined ? Math.max(0, 1 - a('percent_used') / 100) : undefined,
      spare: a('avail_spare') !== undefined ? a('avail_spare') / 100 : undefined,
      spareThreshold: a('spare_thresh') !== undefined ? a('spare_thresh') / 100 : undefined,
      readBytes: a('total_data_read'),
      writtenBytes: a('total_data_written'),
      powerCycles: a('power_cycles'),
      unsafeShutdowns: a('unsafe_shutdowns'),
      mediaErrors: a('media_errors'),
      hotMinutes: (a('warning_temp_time') ?? 0) + (a('critical_temp_time') ?? 0),
      selfTest: prop(o, 'NVMe.Controller', 'SmartSelftestStatus') || undefined,
      warnings,
    };
    for (const w of warnings) drive.issues.push({ level: 'failing', text: `The drive reports a critical warning: ${w.replace(/_/g, ' ')}` });
    const s = drive.smart;
    if (s.spare !== undefined && s.spareThreshold !== undefined && s.spare <= s.spareThreshold) {
      drive.issues.push({ level: 'failing', text: 'Spare blocks are used up' });
    }
    if (s.mediaErrors) drive.issues.push({ level: 'warning', text: `${s.mediaErrors} data errors` });
  } else if (ata && prop(o, 'Drive.Ata', 'SmartSupported')) {
    const rows = await udisksCall(objectPath, 'org.freedesktop.UDisks2.Drive.Ata', 'SmartGetAttributes', 'a{sv}', '0').catch(() => [[]]);
    const attrs = ataAttributes(rows[0] ?? []);
    const raw = (id) => attrs.get(id)?.pretty;
    const life = LIFE_ATTRIBUTES.map((id) => attrs.get(id)).find((x) => x && x.value > 0 && x.value <= 100);
    const written = attrs.get(241);
    drive.temperature = kelvin(prop(o, 'Drive.Ata', 'SmartTemperature'));
    drive.smart = {
      updated: (prop(o, 'Drive.Ata', 'SmartUpdated') ?? 0) * 1000 || undefined,
      powerOnHours: Math.round((prop(o, 'Drive.Ata', 'SmartPowerOnSeconds') ?? 0) / 3600) || undefined,
      failing: !!prop(o, 'Drive.Ata', 'SmartFailing'),
      failingAttributes: prop(o, 'Drive.Ata', 'SmartNumAttributesFailing') ?? 0,
      failedInPast: prop(o, 'Drive.Ata', 'SmartNumAttributesFailedInThePast') ?? 0,
      badSectors: prop(o, 'Drive.Ata', 'SmartNumBadSectors') ?? 0,
      reallocated: raw(5),
      pending: raw(197),
      uncorrectable: raw(198),
      cableErrors: raw(199),
      powerCycles: raw(12),
      loadCycles: drive.kind === 'hdd' ? raw(193) : undefined,
      lifeLeft: drive.kind === 'ssd' && life ? life.value / 100 : undefined,
      // Total LBAs written counts 512-byte sectors on most drives.
      writtenBytes: written && (written.unit === 1 || written.unit === 3) ? written.pretty * 512 : undefined,
      selfTest: prop(o, 'Drive.Ata', 'SmartSelftestStatus') || undefined,
    };
    const s = drive.smart;
    if (s.failing) drive.issues.push({ level: 'failing', text: 'The drive says it is about to fail' });
    else if (s.failingAttributes) drive.issues.push({ level: 'failing', text: `${s.failingAttributes} health checks are failing` });
    if (s.badSectors) drive.issues.push({ level: 'warning', text: `${s.badSectors} bad sectors` });
    if (s.pending) drive.issues.push({ level: 'warning', text: `${s.pending} sectors waiting to be remapped` });
  }
  const s = drive.smart;
  if (s?.lifeLeft !== undefined && s.lifeLeft <= 0.1) drive.issues.push({ level: 'warning', text: `${Math.round(s.lifeLeft * 100)}% of its life left` });
  if (s?.selfTest && /^(fatal|error)/.test(s.selfTest)) drive.issues.push({ level: 'warning', text: 'The last self-test failed' });
  if (drive.temperature >= DRIVE_HOT[drive.kind]) drive.issues.push({ level: 'warning', text: `Running hot at ${Math.round(drive.temperature)}°C` });
  drive.health = drive.issues.some((i) => i.level === 'failing') ? 'failing' : drive.issues.length ? 'warning' : s ? 'good' : 'unknown';
  return drive;
}

async function refreshDrives() {
  try {
    const [objects] = await udisksCall('/org/freedesktop/UDisks2', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects');
    const list = Object.entries(objects);
    const blocks = list.filter(([, o]) => o['org.freedesktop.UDisks2.Block']);
    const drives = await Promise.all(list.filter(([, o]) => o['org.freedesktop.UDisks2.Drive']).map(([p, o]) => readDrive(p, o, blocks)));
    // The system drive first, then by where they're mounted.
    const rank = (d) => (d.mounts.includes('/') ? 0 : d.mounts.length ? 1 : 2);
    driveInfo = drives.sort((a, b) => rank(a) - rank(b) || (a.mounts[0] ?? a.model).localeCompare(b.mounts[0] ?? b.model));
    driveError = undefined;
  } catch (e) {
    driveError = e.stderr?.trim() || e.message;
    console.error("Couldn't read the drives:", driveError);
  }
}

/** Each drive with its health, what it's doing now and which services are using it most. */
async function drives() {
  const groups = await groupUsage();
  const pods = lastPods.length ? lastPods : await containers().catch(() => []);
  const services = serviceGroups(groups, pods);
  const names = new Map(pods.map((p) => [`container:${p.Names?.[0]}`, p.Names?.[0]]));
  for (const u of UNITS) names.set(`unit:${u.id}`, u.name);
  const serviceByDir = new Map([...services].map(([id, g]) => [g.dir, id]));
  const devNumbers = new Map(
    await Promise.all(driveInfo.filter((d) => d.device).map(async (d) => [d.device, await readText(`/sys/block/${d.device}/dev`)])),
  );
  return {
    drives: driveInfo.map((d) => {
      const dev = devNumbers.get(d.device);
      const users = groups
        .map((g) => {
          const [r, w] = g.deviceRates?.[dev] ?? [0, 0];
          const id = serviceByDir.get(g.dir);
          return { id, name: id ? names.get(id) : groupLabel(path.basename(g.dir)), readPerSec: r, writePerSec: w };
        })
        .filter((u) => u.readPerSec + u.writePerSec > 0)
        .sort((a, b) => b.readPerSec + b.writePerSec - (a.readPerSec + a.writePerSec))
        .slice(0, 6);
      return { ...d, activity: diskRates.get(d.device), users };
    }),
    error: driveError,
    at: Date.now(),
  };
}

// ---------------------------------------------------------------------------------------------
// CPU: each core's load and clock speed, and the package's power draw.

let cpuModel;

async function cpuClocks() {
  const cpus = (await readdir('/sys/devices/system/cpu').catch(() => [])).filter((c) => /^cpu\d+$/.test(c));
  cpus.sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
  const khz = await Promise.all(cpus.map((c) => readNumber(`/sys/devices/system/cpu/${c}/cpufreq/scaling_cur_freq`)));
  return khz.filter((k) => k !== undefined);
}

async function cpu() {
  cpuModel ??= /^model name\s*:\s*(.+)$/m.exec(await readFile('/proc/cpuinfo', 'utf8'))?.[1]?.trim();
  const [clocks, temps, press, maxKhz, governor, preference] = await Promise.all([
    cpuClocks(),
    temperatures(),
    pressure(10),
    readNumber('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq'),
    readText('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'),
    readText('/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference'),
  ]);
  return {
    model: cpuModel,
    usage: rates.cpu,
    load: os.loadavg(),
    cores: rates.cores.map((usage, i) => ({ usage, mhz: clocks[i] !== undefined ? Math.round(clocks[i] / 1000) : undefined })),
    maxMhz: maxKhz && Math.round(maxKhz / 1000),
    temperature: temps.find((t) => t.label === 'CPU')?.celsius,
    watts: rates.cpuWatts,
    powerError: cpuPowerError,
    pressure: press,
    governor,
    preference,
    at: Date.now(),
  };
}

// ---------------------------------------------------------------------------------------------
// Power: the CPU package's and graphics card's measured draw, and what that costs. The rest of the
// PC (drives, board, fans, the power supply's losses) isn't measured, so it's an estimate set in
// the app, added on top.

const POWER_PATH = path.join(ROOT, 'power.json');
let powerSettings = { pricePerKwh: undefined, currency: '$', otherWatts: 0 };

async function loadPowerSettings() {
  const saved = await readFile(POWER_PATH, 'utf8').then(JSON.parse, () => undefined);
  if (saved) powerSettings = { ...powerSettings, ...saved };
}

async function setPowerSettings(body) {
  const next = { ...powerSettings };
  if ('pricePerKwh' in body) {
    const price = body.pricePerKwh === null ? undefined : Number(body.pricePerKwh);
    if (price !== undefined && !(price >= 0 && price < 100)) throw new HttpError(400, 'Price must be a number per kWh');
    next.pricePerKwh = price;
  }
  if ('currency' in body) {
    if (typeof body.currency !== 'string' || body.currency.length > 4) throw new HttpError(400, 'Currency must be a short symbol');
    next.currency = body.currency;
  }
  if ('otherWatts' in body) {
    const watts = Number(body.otherWatts);
    if (!(watts >= 0 && watts <= 1000)) throw new HttpError(400, 'Other watts must be 0 to 1000');
    next.otherWatts = watts;
  }
  powerSettings = next;
  await writeFile(POWER_PATH, JSON.stringify(next), { mode: 0o600 });
  return powerState();
}

function powerState() {
  return { ...powerSettings, cpuWatts: rates.cpuWatts, cpuPowerError };
}

// ---------------------------------------------------------------------------------------------
// Network per service and per device. A container with a network of its own has its own traffic
// counters, read from inside its network namespace through one of its processes. Containers that
// share one (qBittorrent goes through gluetun's VPN) are counted together. Tailscale counts the
// bytes to and from each device.

let lastContainerNet;
/** Service id → { rxPerSec, txPerSec }. */
let containerNetRates = new Map();
/** Groups of containers sharing a network, as service ids, from the last reading. */
let netGroups = [];

async function sampleContainerNet(pods) {
  const now = Date.now();
  const host = await readlink('/proc/self/ns/net').catch(() => undefined);
  const byNs = new Map();
  for (const p of pods) {
    if (p.State !== 'running' || !p.Pid) continue;
    const ns = await readlink(`/proc/${p.Pid}/ns/net`).catch(() => undefined);
    // Host networking is the machine's own traffic, already counted.
    if (!ns || ns === host) continue;
    const id = `container:${p.Names?.[0] ?? p.Id.slice(0, 12)}`;
    const known = byNs.get(ns);
    if (known) {
      known.ids.push(id);
      continue;
    }
    const lines = (await readFile(`/proc/${p.Pid}/net/dev`, 'utf8').catch(() => '')).split('\n').slice(2);
    const ifaces = lines.map((l) => l.trim().split(':')).filter(([name, data]) => data && name !== 'lo');
    // A VPN's tunnel carries the real traffic; the same data also crosses eth0, encrypted.
    const tunnel = ifaces.filter(([name]) => /^(tun|wg)/.test(name));
    let rx = 0;
    let tx = 0;
    for (const [, data] of tunnel.length ? tunnel : ifaces) {
      const f = data.trim().split(/\s+/).map(Number);
      rx += f[0];
      tx += f[8];
    }
    byNs.set(ns, { ids: [id], rx, tx });
  }
  const next = new Map();
  if (lastContainerNet) {
    const secs = (now - lastContainerNet.at) / 1000;
    for (const [ns, g] of byNs) {
      const p = lastContainerNet.byNs.get(ns);
      if (!p || secs <= 0) continue;
      const r = { rxPerSec: Math.max(0, (g.rx - p.rx) / secs), txPerSec: Math.max(0, (g.tx - p.tx) / secs) };
      for (const id of g.ids) next.set(id, r);
    }
  }
  lastContainerNet = { at: now, byNs };
  containerNetRates = next;
  netGroups = [...byNs.values()].map((g) => g.ids);
  return next;
}

const PEER_INTERVAL = 60_000;
let lastPeers;
/** Device name → { rxPerSec, txPerSec, os, online }. */
let peerRates = new Map();

async function samplePeers() {
  try {
    const { devices } = await tailscale();
    const now = Date.now();
    const peers = new Map(devices.filter((d) => !d.self).map((d) => [d.name, d]));
    const next = new Map();
    for (const [name, d] of peers) {
      const p = lastPeers?.peers.get(name);
      const secs = lastPeers ? (now - lastPeers.at) / 1000 : 0;
      // The counters start over when tailscaled restarts.
      const rate = (a, b) => (p && secs > 0 && a >= b ? (a - b) / secs : undefined);
      next.set(name, { rxPerSec: rate(d.rxBytes, p?.rxBytes), txPerSec: rate(d.txBytes, p?.txBytes), os: d.os, online: d.online });
    }
    lastPeers = { at: now, peers };
    peerRates = next;
  } catch (e) {
    console.error("Couldn't read Tailscale's traffic:", e.message);
  }
}

/** Traffic over the range: the machine's, each service's and each Tailscale device's. */
function network(rangeSec) {
  const end = Date.now();
  const start = end - rangeSec * 1000;
  const entries = historyEntries(start);
  const machine = summarize(entries, { rx: 'rx', tx: 'tx' }, start, end);
  const rx = totals(entries, /^s:(.+):rx$/);
  const tx = totals(entries, /^s:(.+):tx$/);
  const names = new Map((lastServices ?? []).map((s) => [s.id, s.name]));
  const nameOf = (id) => names.get(id) ?? id.slice(id.indexOf(':') + 1);

  // Containers sharing a network have the same numbers; show them once.
  const seen = new Set();
  const services = [];
  for (const ids of [...netGroups, ...[...rx.keys()].map((id) => [id])]) {
    if (ids.some((id) => seen.has(id))) continue;
    ids.forEach((id) => seen.add(id));
    const id = ids.find((x) => rx.has(x)) ?? ids[0];
    const live = containerNetRates.get(id);
    services.push({
      id,
      ids,
      name: ids.map(nameOf).join(' + '),
      rxPerSec: live?.rxPerSec,
      txPerSec: live?.txPerSec,
      rxBytes: rx.get(id)?.total ?? 0,
      txBytes: tx.get(id)?.total ?? 0,
    });
  }
  services.sort((a, b) => b.rxBytes + b.txBytes - (a.rxBytes + a.txBytes));

  const peerRx = totals(entries, /^t:(.+):rx$/);
  const peerTx = totals(entries, /^t:(.+):tx$/);
  const deviceNames = new Set([...peerRates.keys(), ...peerRx.keys()]);
  const devices = [...deviceNames]
    .map((name) => {
      const live = peerRates.get(name);
      return {
        name,
        os: live?.os,
        online: !!live?.online,
        rxPerSec: live?.rxPerSec,
        txPerSec: live?.txPerSec,
        rxBytes: peerRx.get(name)?.total ?? 0,
        txBytes: peerTx.get(name)?.total ?? 0,
      };
    })
    .sort((a, b) => b.rxBytes + b.txBytes - (a.rxBytes + a.txBytes) || a.name.localeCompare(b.name));

  return {
    start,
    end,
    oldest: TIERS.map((t) => t.entries[0]?.t).filter(Boolean).reduce((a, b) => Math.min(a, b), end),
    rxPerSec: rates.rxPerSec,
    txPerSec: rates.txPerSec,
    rxBytes: machine.rx.total,
    txBytes: machine.tx.total,
    services,
    devices,
    at: end,
  };
}

// ---------------------------------------------------------------------------------------------
// Watching: send ntfy messages when a problem starts and when it clears.

async function notify(title, message, tags, click = 'homebase://server') {
  try {
    const res = await fetch(NTFY_URL, {
      method: 'POST',
      headers: { Title: title, Tags: tags, Click: click },
      body: message,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.warn(`Couldn't send ntfy notification: ${e.message}`);
  }
}

function problems(s) {
  const out = new Map();
  for (const d of s.disks) {
    const used = d.usedBytes / d.totalBytes;
    if (used >= DISK_WARN) out.set(`disk:${d.mount}`, `${d.mount} is ${Math.round(used * 100)}% full`);
  }
  for (const t of s.temperatures) {
    if (t.celsius >= TEMP_WARN) out.set(`temp:${t.label}`, `${t.label} is at ${Math.round(t.celsius)}°C`);
  }
  for (const svc of s.services) {
    if (svc.state === 'failed') out.set(`svc:${svc.id}`, `${svc.name} has failed${svc.detail ? ` (${svc.detail})` : ''}`);
    if (svc.health === 'unhealthy') out.set(`health:${svc.id}`, `${svc.name} is unhealthy`);
  }
  for (const d of driveInfo) {
    for (const issue of d.issues) {
      // The temperature is in the text, so key hot drives on the fact rather than the reading.
      const key = issue.text.startsWith('Running hot') ? 'hot' : issue.text;
      out.set(`drive:${d.id}:${key}`, `${d.model}: ${issue.text}`);
    }
  }
  return out;
}

let known = new Map();
async function watch() {
  try {
    const current = problems(await status());
    const started = [...current].filter(([k]) => !known.has(k)).map(([, v]) => v);
    const cleared = [...known].filter(([k]) => !current.has(k)).map(([, v]) => v);
    // Logged once per problem, though a restart of this server forgets what it already knew.
    const driveOf = (k) => /^drive:([^:]+):/.exec(k)?.[1];
    const open = (v) => events.findLast((e) => (e.kind === 'problem' || e.kind === 'resolved') && e.detail === v)?.kind === 'problem';
    for (const [k, v] of current) if (!known.has(k) && !open(v)) addEvent('problem', { detail: v, drive: driveOf(k) });
    for (const [k, v] of known) if (!current.has(k) && open(v)) addEvent('resolved', { detail: v, drive: driveOf(k) });
    if (started.length) await notify('Server problem', started.join('\n'), 'warning');
    if (cleared.length) await notify('Server back to normal', cleared.map((m) => `Resolved: ${m}`).join('\n'), 'white_check_mark');
    known = current;
  } catch (e) {
    console.error('Watch failed:', e);
  }
}

// ---------------------------------------------------------------------------------------------
// Game mode: stops the download stack to leave its memory to a game. It turns on by itself while
// a Steam game or Starsector runs and off half a minute after the game closes, or can be switched
// from the app. Turned on from the app, it stays on until turned off there. Turned off while a
// game runs, it stays off until that game closes. Jellyfin keeps running so the TV still works.

/** In start order; systemd works out the rest from the units' own dependencies. */
// The assistant's models hold several GB of video memory, so they stop too (see ASSISTANT_MODELS).
const GAME_MODE_UNITS = ['gluetun', 'qbittorrent', 'flaresolverr', 'prowlarr', 'sonarr', 'radarr', 'recyclarr', 'bazarr', 'cleanuparr', 'tdarr', 'seerr', 'llama'];
const GAME_MODE_PATH = path.join(ROOT, 'game-mode.json');
const GAME_CHECK_INTERVAL = 10_000;
/** How long after a game closes before the services come back, so restarting a game doesn't bounce them. */
const GAME_GRACE_MS = 30_000;
const STEAM_DIR = path.join(os.homedir(), '.local/share/Steam');

/**
 * `manual` is true or false when set from the app, undefined when following games. `game` is the
 * last game seen and `lastSeen` when, kept through the grace period.
 */
let gameMode = { manual: undefined, active: false, game: undefined, lastSeen: undefined, since: undefined };
let gameModeBusy = Promise.resolve();
const GAME_MODE_UNIT_FILES = GAME_MODE_UNITS.map((u) => `${u}.service`);

async function stopGameModeUnits() {
  await run('systemctl', ['--user', 'stop', ...GAME_MODE_UNIT_FILES], { timeout: 180_000 }).finally(expireServices);
  // Some exit with an error when stopped (gluetun with 1); that's not a failure worth showing.
  await run('systemctl', ['--user', 'reset-failed', ...GAME_MODE_UNIT_FILES]).catch(() => {});
}

async function steamGameName(appId) {
  const vdf = await readFile(path.join(STEAM_DIR, 'steamapps/libraryfolders.vdf'), 'utf8').catch(() => '');
  const libraries = [...vdf.matchAll(/"path"\s+"([^"]+)"/g)].map((m) => m[1]);
  for (const lib of libraries.length ? libraries : [STEAM_DIR]) {
    const manifest = await readFile(path.join(lib, `steamapps/appmanifest_${appId}.acf`), 'utf8').catch(() => '');
    const name = /"name"\s+"([^"]+)"/.exec(manifest)?.[1];
    if (name) return name;
  }
  return 'A Steam game';
}

/** Name of a game that's running, or undefined. */
async function runningGame() {
  const pids = (await readdir('/proc')).filter((p) => /^\d+$/.test(p));
  for (const pid of pids) {
    const args = await readFile(`/proc/${pid}/cmdline`, 'utf8').then((t) => t.split('\0'), () => []);
    if (args.includes('com.fs.starfarer.StarfarerLauncher')) return 'Starsector';
    // Steam starts every game, native or Proton, under `reaper SteamLaunch AppId=<id> -- ...`.
    if (args.includes('SteamLaunch')) {
      const appId = args.map((a) => /^AppId=(\d+)$/.exec(a)?.[1]).find(Boolean);
      if (appId) return steamGameName(appId);
    }
  }
  return undefined;
}

async function saveGameMode() {
  const { manual, active, game } = gameMode;
  await writeFile(GAME_MODE_PATH, JSON.stringify({ manual, active, game })).catch((e) =>
    console.error("Couldn't save game mode:", e.message),
  );
}

/** Starts or stops the services if game mode should change. One change at a time. */
function updateGameMode() {
  gameModeBusy = gameModeBusy.then(async () => {
    const want = gameMode.manual ?? !!gameMode.game;
    if (want === gameMode.active) return;
    console.log(`Game mode ${want ? 'on' : 'off'}${gameMode.game ? ` (${gameMode.game})` : ''}`);
    gameMode.active = want;
    gameMode.since = Date.now();
    addEvent('game', { on: want, detail: gameMode.game });
    await saveGameMode();
    await (want ? stopGameModeUnits() : run('systemctl', ['--user', 'start', ...GAME_MODE_UNIT_FILES.filter((u) => !onDemandUnit(u))], { timeout: 180_000 })).catch(
      (e) => console.error(`Couldn't ${want ? 'stop' : 'start'} the game mode services:`, e.stderr?.trim() || e.message),
    );
  });
  return gameModeBusy;
}

async function checkGame() {
  try {
    const game = await runningGame();
    const now = Date.now();
    if (game) Object.assign(gameMode, { game, lastSeen: now });
    else if (gameMode.game && now - gameMode.lastSeen >= GAME_GRACE_MS) {
      gameMode.game = undefined;
      // Turning it off only lasted for that game.
      if (gameMode.manual === false) gameMode.manual = undefined;
    }
    await updateGameMode();
  } catch (e) {
    console.error('Checking for games failed:', e);
  }
}

async function setGameMode(on) {
  if (typeof on !== 'boolean') throw new HttpError(400, 'Expected { "on": true | false }');
  gameMode.manual = on ? true : gameMode.game ? false : undefined;
  await updateGameMode();
  return gameModeState();
}

function gameModeState() {
  const { active, manual, game, lastSeen, since } = gameMode;
  const closing = game && lastSeen && Date.now() - lastSeen > GAME_CHECK_INTERVAL * 2;
  return {
    on: active,
    manual: manual !== undefined,
    game,
    since,
    /** When it turns off by itself, once the game has closed. */
    endsAt: active && manual === undefined && closing ? lastSeen + GAME_GRACE_MS : undefined,
    services: GAME_MODE_UNITS.map((u) => `container:${u}`),
  };
}

async function loadGameMode() {
  const saved = await readFile(GAME_MODE_PATH, 'utf8').then(JSON.parse, () => undefined);
  if (!saved?.active) return;
  // On while a game ran: give it the grace period from now, in case the game is still going.
  Object.assign(gameMode, { ...saved, lastSeen: Date.now(), since: Date.now() });
  // After a reboot the services started with everything else, so stop them again.
  await stopGameModeUnits().catch((e) => console.error("Couldn't stop the game mode services:", e.message));
}

/** Units that only run while something uses them, so game mode doesn't start them again. */
const onDemandUnit = (unit) => unit === SEERR_UNIT || ASSISTANT_MODELS.some((m) => m.unit === unit);

function gameModeError(service) {
  if (gameMode.active) {
    throw new HttpError(503, `Game mode is on, so ${service} is stopped. Turn it off in the Server app to use it.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Media requests: the Requests mini-app talks to Seerr, Sonarr and Radarr through here, so their
// API keys stay on this machine. Keys are read from each app's own config on every call, so a
// rotated key just works. Only the calls the app makes are let through.

const ARR_DIR = process.env.ARR_DIR ?? path.join(os.homedir(), '.local/share/arr');
const xmlApiKey = async (app) =>
  /<ApiKey>([^<]+)<\/ApiKey>/.exec(await readFile(path.join(ARR_DIR, app, 'config.xml'), 'utf8'))?.[1];

/** The only Sonarr/Radarr commands the phone may start: fixing downloads stuck on import. */
const ARR_COMMANDS = new Set(['ManualImport', 'RefreshMonitoredDownloads']);

const ARR_APPS = {
  seerr: {
    label: 'Seerr',
    base: 'http://localhost:5055/api/v1',
    key: async () => JSON.parse(await readFile(path.join(ARR_DIR, 'seerr', 'settings.json'), 'utf8')).main?.apiKey,
    routes: { GET: /^(search|movie\/\d+|tv\/\d+|request)$/, POST: /^request$/, DELETE: /^media\/\d+$/ },
  },
  sonarr: {
    label: 'Sonarr',
    base: 'http://localhost:8989/api/v3',
    key: () => xmlApiKey('sonarr'),
    routes: {
      GET: /^(queue|calendar|release|series|series\/\d+|episodefile|qualityprofile|diskspace|manualimport)$/,
      POST: /^(release|command)$/,
      PUT: /^series\/\d+$/,
      DELETE: /^(queue\/\d+|series\/\d+|episodefile\/bulk)$/,
    },
  },
  radarr: {
    label: 'Radarr',
    base: 'http://localhost:7878/api/v3',
    key: () => xmlApiKey('radarr'),
    routes: {
      GET: /^(queue|calendar|release|movie|movie\/\d+|qualityprofile|manualimport)$/,
      POST: /^(release|command)$/,
      DELETE: /^(queue\/\d+|movie\/\d+)$/,
    },
  },
};

// Seerr only runs while the Requests app uses it: the first call starts it (a few seconds), and
// it stops after half an hour without calls. Its unit isn't started at boot.

const SEERR_UNIT = 'seerr.service';
const SEERR_IDLE_MS = 30 * 60_000;
const SEERR_START_TIMEOUT_MS = 90_000;
let seerrLastUsed = Date.now();
let seerrStarting;

const seerrAnswers = () =>
  fetch(`${ARR_APPS.seerr.base}/status`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);

async function wakeSeerr() {
  seerrLastUsed = Date.now();
  if (seerrStarting || !(await seerrAnswers())) {
    seerrStarting ??= (async () => {
      console.log('Starting Seerr for the Requests app');
      await run('systemctl', ['--user', 'start', SEERR_UNIT], { timeout: 120_000 });
      const deadline = Date.now() + SEERR_START_TIMEOUT_MS;
      while (!(await seerrAnswers())) {
        if (Date.now() > deadline) throw new HttpError(504, 'Seerr is taking too long to start. Try again in a minute.');
        await new Promise((r) => setTimeout(r, 500));
      }
    })().finally(() => {
      seerrStarting = undefined;
    });
    await seerrStarting;
  }
}

async function stopIdleSeerr() {
  if (seerrStarting || Date.now() - seerrLastUsed < SEERR_IDLE_MS) return;
  const { stdout } = await run('systemctl', ['--user', 'is-active', SEERR_UNIT]).catch((e) => e);
  if (stdout?.trim() !== 'active') return;
  console.log('Stopping Seerr, unused for half an hour');
  await run('systemctl', ['--user', 'stop', SEERR_UNIT], { timeout: 120_000 }).catch((e) =>
    console.error("Couldn't stop Seerr:", e.message),
  );
}

/** A release search asks every indexer, some through FlareSolverr, so it can take a while. */
const ARR_TIMEOUT_MS = 180_000;
const MAX_BODY = 64 * 1024;

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function proxyArr(req, res, appName, apiPath, search) {
  const app = ARR_APPS[appName];
  if (!app?.routes[req.method]?.test(apiPath)) throw new HttpError(404, 'Not found');
  gameModeError(app.label);
  if (appName === 'seerr') await wakeSeerr();
  const key = await app.key().catch(() => undefined);
  if (!key) throw new HttpError(503, `${appName} isn't set up on the server`);
  if (req.method !== 'GET') log(req, `${req.method} ${appName}/${apiPath}`);
  const body = req.method === 'GET' ? undefined : await readBody(req);
  if (apiPath === 'command') {
    let name;
    try {
      name = JSON.parse(body?.toString() ?? '').name;
    } catch {}
    if (!ARR_COMMANDS.has(name)) throw new HttpError(403, `The ${name ?? 'unnamed'} command isn't allowed`);
  }

  let upstream;
  try {
    upstream = await fetch(`${app.base}/${apiPath}${search}`, {
      method: req.method,
      headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(ARR_TIMEOUT_MS),
    });
  } catch (e) {
    throw new HttpError(502, `${appName} didn't answer (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
  }
  const text = await upstream.text();
  if (!upstream.ok) {
    // Seerr and the *arrs put the reason in `message`, or in a list of validation failures.
    let message;
    try {
      const body = JSON.parse(text);
      message = body.message ?? (Array.isArray(body) ? body.map((f) => f.errorMessage).filter(Boolean).join(' ') : undefined);
    } catch {}
    throw new HttpError(upstream.status, message || `${appName} answered ${upstream.status}`);
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(text || 'null');
}

// qBittorrent's Web API wants a login cookie rather than a key, and form bodies, so it gets its
// own small client instead of going through the proxy above. It only exposes the speed limit and
// seeding.

const QBIT_URL = process.env.QBIT_URL ?? 'http://localhost:8090';
let qbitCookie;

async function qbitLogin() {
  // The shared password from the credentials file; qBittorrent's user is always "admin".
  const password = /^password=(.*)$/m.exec(await readFile(path.join(ARR_DIR, 'credentials'), 'utf8').catch(() => ''))?.[1];
  if (!password) throw new HttpError(503, "qBittorrent's login isn't set up on the server");
  const res = await fetch(`${QBIT_URL}/api/v2/auth/login`, {
    method: 'POST',
    headers: { Referer: QBIT_URL },
    body: new URLSearchParams({ username: 'admin', password: password.trim() }),
    signal: AbortSignal.timeout(10_000),
  });
  // Older versions answer a wrong password with 200 "Fails." and no cookie.
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  if (!res.ok || !cookie) throw new HttpError(502, "qBittorrent didn't accept the login");
  qbitCookie = cookie;
}

async function qbit(apiPath, form) {
  gameModeError('qBittorrent');
  for (let attempt = 0; ; attempt++) {
    if (!qbitCookie) await qbitLogin();
    let res;
    try {
      res = await fetch(`${QBIT_URL}/api/v2/${apiPath}`, {
        method: form ? 'POST' : 'GET',
        headers: { Cookie: qbitCookie, Referer: QBIT_URL },
        body: form && new URLSearchParams(form),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new HttpError(502, `qBittorrent didn't answer (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
    }
    // The session expired or qBittorrent restarted: log in again once.
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      qbitCookie = undefined;
      continue;
    }
    if (!res.ok) throw new HttpError(502, `qBittorrent answered ${res.status}`);
    const text = await res.text();
    return text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  }
}

/** Current download speed and the global limit, both in bytes per second; a limit of 0 is none. */
async function speedLimit() {
  const info = await qbit('transfer/info');
  return { speed: info.dl_info_speed, limit: info.dl_rate_limit };
}

async function setSpeedLimit(limit) {
  if (!Number.isInteger(limit) || limit < 0) throw new HttpError(400, 'The limit must be a whole number of bytes per second');
  // The alternative ("turtle") limits replace the global ones while they're on, so turn them off
  // or the new limit wouldn't apply.
  if ((await qbit('transfer/speedLimitsMode')) === '1') await qbit('transfer/toggleSpeedLimitsMode', {});
  await qbit('transfer/setDownloadLimit', { limit: String(limit) });
  return speedLimit();
}

// Tdarr converts the library to HEVC MP4s. It has its own login (the shared credentials) that
// hands out a bearer token. The phone sees what's converting, what's done and what was saved,
// and can pause the node; everything else stays in Tdarr's web UI.

const TDARR_URL = process.env.TDARR_URL ?? 'http://localhost:8265';
const GIB = 1024 ** 3;
let tdarrToken;

async function tdarrLogin() {
  const creds = await readFile(path.join(ARR_DIR, 'credentials'), 'utf8').catch(() => '');
  const username = /^username=(.*)$/m.exec(creds)?.[1]?.trim();
  const password = /^password=(.*)$/m.exec(creds)?.[1]?.trim();
  if (!username || !password) throw new HttpError(503, "Tdarr's login isn't set up on the server");
  const res = await fetch(`${TDARR_URL}/api/v2/public/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(10_000),
  }).catch((e) => {
    throw new HttpError(502, `Tdarr didn't answer (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
  });
  tdarrToken = res.ok ? (await res.json()).token : undefined;
  if (!tdarrToken) throw new HttpError(502, "Tdarr didn't accept the login");
}

async function tdarr(apiPath, body) {
  gameModeError('Tdarr');
  for (let attempt = 0; ; attempt++) {
    if (!tdarrToken) await tdarrLogin();
    let res;
    try {
      res = await fetch(`${TDARR_URL}/api/v2/${apiPath}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${tdarrToken}`, 'Content-Type': 'application/json' },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new HttpError(502, `Tdarr didn't answer (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
    }
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      tdarrToken = undefined;
      continue;
    }
    if (!res.ok) throw new HttpError(502, `Tdarr answered ${res.status}`);
    // Updates answer a plain "OK".
    const text = await res.text();
    return text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  }
}

const tdarrFile = (file) => ({ file: path.basename(file, path.extname(file)), show: file.startsWith('/data/Shows/') });

/**
 * The file list carries every file's full probe and takes ~180 ms, so it's fetched at most every
 * 15 s, in the background while the last one is under 5 minutes old.
 */
const TDARR_FILES_TTL_MS = 15_000;
const TDARR_FILES_MAX_AGE_MS = 5 * 60_000;
const tdarrFiles = backgroundRefreshed(() => tdarr('cruddb', { data: { collection: 'FileJSONDB', mode: 'getAll' } }), {
  staleMs: TDARR_FILES_TTL_MS,
  maxAgeMs: TDARR_FILES_MAX_AGE_MS,
  label: "Listing Tdarr's files",
});

async function conversions() {
  // First, so game mode and an unreachable Tdarr fail here rather than in the background.
  const nodes = Object.values((await tdarr('get-nodes')) ?? {});
  const files = await tdarrFiles.get();

  const counts = { queued: 0, done: 0, skipped: 0, failed: 0 };
  const done = [];
  const failed = [];
  let savedBytes = 0;
  for (const f of files) {
    const state = f.TranscodeDecisionMaker;
    if (state === 'Queued') counts.queued++;
    else if (state === 'Not required') counts.skipped++;
    else if (state === 'Transcode success') {
      counts.done++;
      const oldSize = (f.oldSize ?? 0) * GIB;
      const newSize = (f.newSize ?? 0) * GIB;
      if (oldSize && newSize) savedBytes += oldSize - newSize;
      done.push({ ...tdarrFile(f.file), oldSize, newSize, at: f.lastTranscodeDate });
    } else if (state === 'Transcode error') {
      counts.failed++;
      failed.push({ ...tdarrFile(f.file), at: f.lastTranscodeDate });
    }
  }
  const latest = (a, b) => (b.at ?? 0) - (a.at ?? 0);

  const workers = nodes.flatMap((n) =>
    Object.values(n.workers ?? {}).map((w) => ({
      ...tdarrFile(w.file),
      percent: w.percentage,
      eta: w.ETA,
      fps: w.fps,
      startedAt: w.job?.start,
      oldSize: (w.originalfileSizeInGbytes ?? 0) * GIB,
      estSize: (w.estSize ?? 0) * GIB,
    })),
  );
  return {
    paused: nodes.length > 0 && nodes.every((n) => n.nodePaused),
    workers,
    counts,
    savedBytes,
    recent: done.sort(latest).slice(0, 30),
    errors: failed.sort(latest).slice(0, 30),
  };
}

/** A paused node finishes the file it's on, then waits. */
async function setConversionsPaused(paused) {
  if (typeof paused !== 'boolean') throw new HttpError(400, 'Expected { paused: true | false }');
  const nodes = (await tdarr('get-nodes')) ?? {};
  for (const nodeID of Object.keys(nodes)) {
    await tdarr('update-node', { data: { nodeID, nodeUpdates: { nodePaused: paused } } });
  }
  return conversions();
}

// States of finished torrents that are uploading or waiting to, and of ones stopped after
// finishing. qBittorrent 5 renamed "paused" to "stopped".
const SEEDING_STATES = new Set(['uploading', 'stalledUP', 'forcedUP', 'queuedUP', 'checkingUP']);
const STOPPED_STATES = new Set(['stoppedUP', 'pausedUP']);

/**
 * How many finished torrents are seeding and how many are stopped, the upload speed in bytes per
 * second, and whether torrents stop by themselves as soon as they finish.
 */
async function seeding() {
  const [torrents, info, prefs] = await Promise.all([qbit('torrents/info'), qbit('transfer/info'), qbit('app/preferences')]);
  return {
    seeding: torrents.filter((t) => SEEDING_STATES.has(t.state)).length,
    stopped: torrents.filter((t) => STOPPED_STATES.has(t.state)).length,
    speed: info.up_info_speed,
    stopWhenDone: prefs.max_ratio_enabled && prefs.max_ratio === 0 && prefs.max_ratio_act === 0,
  };
}

async function setSeeding({ seed, stopWhenDone }) {
  if (typeof stopWhenDone === 'boolean') {
    // A share ratio limit of 0 is reached the moment a torrent finishes, and action 0 stops it.
    // Turning it off goes back to seeding with no limit.
    await qbit('app/setPreferences', {
      json: JSON.stringify(stopWhenDone ? { max_ratio_enabled: true, max_ratio: 0, max_ratio_act: 0 } : { max_ratio_enabled: false }),
    });
  }
  if (typeof seed === 'boolean') {
    // Only finished torrents: stopping everything would also stop downloads.
    const states = seed ? STOPPED_STATES : SEEDING_STATES;
    const hashes = (await qbit('torrents/info')).filter((t) => states.has(t.state)).map((t) => t.hash);
    if (hashes.length) await qbit(seed ? 'torrents/start' : 'torrents/stop', { hashes: hashes.join('|') });
  }
  return seeding();
}

/**
 * Keep queued TV torrents in episode order, so a show grabbed one episode at a time comes in from
 * the first episode on. Shows go in the order they were first added; movies keep their places.
 * Sonarr also asks for sequential download, which does the same for the files in a season pack.
 */
async function sortTvQueue() {
  if (gameMode.active) return;
  // Queue positions start at 1; finished torrents have none.
  const queue = (await qbit('torrents/info?sort=priority')).filter((t) => t.priority > 0);
  const episode = (t) => {
    const m = /^(.*?)[ ._-]*S(\d{1,2})(?:E(\d{1,3}))?(?!\d)/i.exec(t.name);
    return m && { show: m[1].toLowerCase().replace(/[^a-z0-9]/g, ''), season: +m[2], episode: +(m[3] ?? 0) };
  };
  const tv = queue.filter((t) => t.category === 'tv').map((t) => ({ t, e: episode(t) }));
  if (!tv.every((x) => x.e)) return;
  const firstAdded = new Map();
  for (const { t, e } of tv) firstAdded.set(e.show, Math.min(firstAdded.get(e.show) ?? Infinity, t.added_on));
  const sorted = tv
    .toSorted((a, b) => firstAdded.get(a.e.show) - firstAdded.get(b.e.show) || a.e.show.localeCompare(b.e.show) || a.e.season - b.e.season || a.e.episode - b.e.episode)
    .map((x) => x.t);
  let i = 0;
  const wanted = queue.map((t) => (t.category === 'tv' ? sorted[i++] : t));
  if (wanted.every((t, j) => t === queue[j])) return;
  // Moving each to the top, last first, leaves them in the wanted order.
  for (const t of wanted.toReversed()) await qbit('torrents/topPrio', { hashes: t.hash });
}

// ---------------------------------------------------------------------------------------------
// Drop: files sent from the phone land in ~/Downloads/Homebase, and the phone can list, fetch and
// delete what's there, so putting a file in that folder sends it the other way. Text sent from
// the phone goes on the clipboard, and a lone link opens in the browser instead.

const DROP_DIR = process.env.DROP_DIR ?? path.join(os.homedir(), 'Downloads', 'Homebase');
const DROP_MAX_BYTES = 8 * 1024 ** 3;
const DROP_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  pdf: 'application/pdf', txt: 'text/plain', zip: 'application/zip',
};

/** A plain file name in the drop folder. Hidden names are left out so uploads in progress stay out of the way. */
function dropName(raw) {
  let name;
  try {
    name = decodeURIComponent(raw).normalize('NFC').trim();
  } catch {}
  if (!name || name.length > 255 || name.startsWith('.') || /[/\\\0]/.test(name)) throw new HttpError(400, 'Bad file name');
  return name;
}

async function dropFiles() {
  await mkdir(DROP_DIR, { recursive: true });
  const files = [];
  for (const entry of await readdir(DROP_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const info = await stat(path.join(DROP_DIR, entry.name)).catch(() => undefined);
    if (info) files.push({ name: entry.name, size: info.size, modified: info.mtimeMs });
  }
  files.sort((a, b) => b.modified - a.modified);
  return { folder: DROP_DIR.replace(os.homedir(), '~'), files };
}

function notifyDesktop(title, body) {
  run('notify-send', ['--app-name=Homebase', '--icon=smartphone', title, body], { timeout: 5000 }).catch((e) =>
    console.error("Couldn't show a desktop notification:", e.message),
  );
}

/** Writes the upload to a hidden file first, then gives it the name, or "name (2).ext" when that's taken. */
async function receiveDropFile(req, name) {
  if (Number(req.headers['content-length']) > DROP_MAX_BYTES) throw new HttpError(413, 'Files can be up to 8 GB');
  await mkdir(DROP_DIR, { recursive: true });
  const part = path.join(DROP_DIR, `.${randomBytes(6).toString('hex')}.part`);
  try {
    let size = 0;
    await pipeline(
      req,
      async function* (chunks) {
        for await (const chunk of chunks) {
          size += chunk.length;
          if (size > DROP_MAX_BYTES) throw new HttpError(413, 'Files can be up to 8 GB');
          yield chunk;
        }
      },
      createWriteStream(part, { flags: 'wx' }),
    );
    const { name: stem, ext } = path.parse(name);
    for (let n = 1; ; n++) {
      const saved = n === 1 ? name : `${stem} (${n})${ext}`;
      try {
        // Unlike rename, link won't replace a file that's already there.
        await link(part, path.join(DROP_DIR, saved));
      } catch (e) {
        if (e.code === 'EEXIST') continue;
        throw e;
      }
      notifyDesktop('Received from your phone', saved);
      return { name: saved, size };
    }
  } finally {
    await unlink(part).catch(() => {});
  }
}

async function sendDropFile(res, name) {
  let handle;
  try {
    handle = await open(path.join(DROP_DIR, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ELOOP') throw new HttpError(404, 'That file is gone');
    throw e;
  }
  const info = await handle.stat();
  if (!info.isFile()) {
    await handle.close();
    throw new HttpError(404, 'That file is gone');
  }
  res.writeHead(200, {
    'content-type': DROP_TYPES[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'cache-control': 'no-store',
  });
  await pipeline(handle.createReadStream(), res);
}

async function deleteDropFile(name) {
  await unlink(path.join(DROP_DIR, name)).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
  return { ok: true };
}

/** Runs a desktop program that might stay open, and resolves once it has started or failed. */
function startDesktop(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} failed (${code})`))));
    child.stdin?.end(input);
  });
}

async function receiveDropText(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) throw new HttpError(400, 'Nothing to send');
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    await startDesktop('xdg-open', [trimmed]);
    return { action: 'opened' };
  }
  // wl-copy stays behind in the background to hand the text to whoever pastes it.
  await startDesktop('wl-copy', [], text);
  notifyDesktop('Copied from your phone', trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed);
  return { action: 'copied' };
}

// ---------------------------------------------------------------------------------------------
// Videos: links from the Videos mini-app are saved by yt-dlp into Jellyfin's YouTube library,
// one folder per channel, one download at a time. Jellyfin watches the folder, and reads the
// title, description and thumbnail that yt-dlp embeds in the file. h264 and AAC in mp4 play on
// the phone without transcoding.

const YTDLP = process.env.YTDLP ?? path.join(os.homedir(), '.local', 'bin', 'yt-dlp');
const VIDEO_DIR = process.env.VIDEO_DIR ?? '/mnt/media/YouTube';
/** Outside the library so Jellyfin doesn't pick up half-downloaded pieces, but on the same drive. */
const VIDEO_PARTIAL_DIR = path.join(path.dirname(VIDEO_DIR), '.youtube-partial');
const VIDEO_JOBS_PATH = path.join(ROOT, 'videos.json');
/** Jellyfin runs in a container that sees the media drive somewhere else. */
const JELLYFIN_URL = 'http://127.0.0.1:8096';
const JELLYFIN_MEDIA = { host: '/mnt/media', container: '/media/drive' };
const VIDEO_KEEP = 50;
const VIDEO_QUALITIES = new Set([1080, 720, 480]);
/** YouTube changes often enough that yt-dlp needs updating every few weeks to keep working. */
const YTDLP_UPDATE_EVERY_MS = 24 * 3600_000;

let videoJobs = [];
let videoRunning; // { job, child }
let ytdlpUpdatedAt = 0;

async function loadVideoJobs() {
  videoJobs = await readFile(VIDEO_JOBS_PATH, 'utf8').then(JSON.parse, () => []);
  // Downloads cut short by a restart start over; yt-dlp picks up the pieces it already has.
  for (const job of videoJobs) if (job.state === 'downloading') Object.assign(job, { state: 'queued', progress: undefined });
  nextVideo();
}

function saveVideoJobs() {
  const keep = videoJobs.slice(0, VIDEO_KEEP);
  videoJobs = keep;
  writeFile(VIDEO_JOBS_PATH, JSON.stringify(keep)).catch((e) => console.error("Couldn't save video jobs:", e.message));
}

function videoJobsState() {
  return { jobs: videoJobs, folder: VIDEO_DIR };
}

function addVideo({ url, quality = 1080 } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url).trim());
  } catch {}
  if (!parsed || !/^https?:$/.test(parsed.protocol)) throw new HttpError(400, 'That isn’t a link');
  if (!VIDEO_QUALITIES.has(quality)) throw new HttpError(400, 'Quality must be 1080, 720 or 480');
  const job = { id: randomBytes(6).toString('hex'), url: parsed.href, quality, state: 'queued', createdAt: Date.now(), files: [] };
  videoJobs.unshift(job);
  saveVideoJobs();
  nextVideo();
  return job;
}

function findVideo(id) {
  const job = videoJobs.find((j) => j.id === id);
  if (!job) throw new HttpError(404, 'No such download');
  return job;
}

function retryVideo(id) {
  const job = findVideo(id);
  if (job.state !== 'failed' && job.state !== 'cancelled') throw new HttpError(409, 'Only failed or cancelled downloads can be retried');
  Object.assign(job, { state: 'queued', error: undefined, note: undefined, progress: undefined, files: [] });
  saveVideoJobs();
  nextVideo();
  return job;
}

/** Cancels it if it's running, and takes it off the list. The saved video stays in Jellyfin. */
function removeVideo(id) {
  const job = findVideo(id);
  if (videoRunning?.job === job) {
    job.state = 'cancelled';
    videoRunning.child.kill('SIGTERM');
  }
  videoJobs = videoJobs.filter((j) => j !== job);
  saveVideoJobs();
  return { ok: true };
}

function cancelVideo(id) {
  const job = findVideo(id);
  if (job.state === 'queued') job.state = 'cancelled';
  else if (videoRunning?.job === job) {
    job.state = 'cancelled';
    videoRunning.child.kill('SIGTERM');
  }
  saveVideoJobs();
  return job;
}

async function updateYtdlp() {
  if (videoRunning || Date.now() - ytdlpUpdatedAt < YTDLP_UPDATE_EVERY_MS) return;
  ytdlpUpdatedAt = Date.now();
  try {
    const { stdout } = await run(YTDLP, ['-U'], { timeout: 120_000 });
    const line = stdout.trim().split('\n').at(-1);
    if (line) console.log(`yt-dlp: ${line}`);
  } catch (e) {
    console.error("Couldn't update yt-dlp:", e.stderr?.trim() || e.message);
  }
}

/**
 * Tells Jellyfin about new files rather than waiting for its folder watcher, which can take
 * minutes. Borrows Seerr's API key for Jellyfin.
 */
async function announceToJellyfin(files) {
  try {
    const settings = JSON.parse(await readFile(path.join(ARR_DIR, 'seerr', 'settings.json'), 'utf8'));
    const key = settings.jellyfin?.apiKey;
    if (!key) throw new Error('no API key in Seerr settings');
    const Updates = files.map((f) => ({
      Path: path.join(VIDEO_DIR, f).replace(JELLYFIN_MEDIA.host, JELLYFIN_MEDIA.container),
      UpdateType: 'Created',
    }));
    const res = await fetch(`${JELLYFIN_URL}/Library/Media/Updated`, {
      method: 'POST',
      headers: { Authorization: `MediaBrowser Token="${key}"`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ Updates }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.warn(`Couldn't tell Jellyfin about new videos: ${e.message}`);
  }
}

function nextVideo() {
  if (videoRunning) return;
  const job = videoJobs.findLast((j) => j.state === 'queued');
  if (job) downloadVideo(job);
}

/** Lines yt-dlp prints for the app to follow along, as JSON so titles with spaces survive. */
const VIDEO_PRINTS = [
  '--progress-template',
  'download:PROGRESS %(progress.{downloaded_bytes,total_bytes,total_bytes_estimate,speed,eta})j',
  '--print',
  'before_dl:VIDEO %(.{id,title,uploader,channel,thumbnail,playlist_index,n_entries,playlist_title})j',
  '--print',
  'after_move:SAVED %(filepath)j',
];

function downloadVideo(job) {
  const partial = path.join(VIDEO_PARTIAL_DIR, job.id);
  const args = [
    '--js-runtimes', 'node',
    '-S', `res:${job.quality},vcodec:h264,acodec:aac`,
    '--merge-output-format', 'mp4',
    '--embed-metadata', '--embed-thumbnail', '--embed-chapters',
    '--download-archive', path.join(VIDEO_DIR, '.downloaded.txt'),
    '--no-overwrites', '--newline', '--no-colors', '--progress',
    '-P', VIDEO_DIR, '-P', `temp:${partial}`,
    '-o', '%(uploader,channel|Unknown channel)s/%(title).180B [%(id)s].%(ext)s',
    ...VIDEO_PRINTS,
    '--', job.url,
  ];
  Object.assign(job, { state: 'downloading', startedAt: Date.now(), error: undefined });
  console.log(`Saving video ${job.url}`);
  // The service's umask keeps files private, but Jellyfin's container reads them as another user.
  const child = spawn('sh', ['-c', 'umask 022 && exec "$0" "$@"', YTDLP, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  videoRunning = { job, child };
  saveVideoJobs();

  const errors = [];
  const onLine = (line) => {
    const space = line.indexOf(' ');
    const kind = line.slice(0, space);
    let value;
    if (kind === 'PROGRESS' || kind === 'VIDEO' || kind === 'SAVED') {
      try {
        value = JSON.parse(line.slice(space + 1));
      } catch {
        return;
      }
    }
    if (kind === 'PROGRESS') {
      job.progress = {
        bytes: value.downloaded_bytes ?? 0,
        total: value.total_bytes ?? value.total_bytes_estimate ?? undefined,
        speed: value.speed ?? undefined,
        eta: value.eta ?? undefined,
      };
    } else if (kind === 'VIDEO') {
      job.title = value.n_entries > 1 && value.playlist_title ? value.playlist_title : value.title;
      job.channel = value.uploader ?? value.channel;
      job.thumbnail ??= value.thumbnail;
      job.item = value.n_entries > 1 ? { index: value.playlist_index, count: value.n_entries, title: value.title } : undefined;
      job.progress = undefined;
    } else if (kind === 'SAVED') {
      job.files.push(path.relative(VIDEO_DIR, value));
    } else if (line.startsWith('ERROR:')) {
      errors.push(line.slice(6).trim());
    }
  };
  for (const stream of [child.stdout, child.stderr]) {
    let buffered = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) onLine(line.trim());
    });
  }

  const finish = async (code, failure) => {
    videoRunning = undefined;
    job.finishedAt = Date.now();
    job.progress = undefined;
    if (job.state === 'cancelled') {
      // Leave nothing behind but whole videos.
    } else if (code === 0) {
      job.state = 'done';
      const what = job.files.length > 1 ? `${job.files.length} videos from ${job.title}` : (job.title ?? job.url);
      // A video that was already saved is skipped, so nothing new turns up in Jellyfin.
      if (job.files.length) {
        announceToJellyfin(job.files);
        notify('Saved to Jellyfin', what, 'tv', 'homebase://videos');
      }
      else job.note = 'Already saved';
    } else {
      job.state = 'failed';
      job.error = failure ?? errors.at(-1) ?? `yt-dlp stopped (${code})`;
      notify('Video download failed', `${job.title ?? job.url}: ${job.error}`, 'warning', 'homebase://videos');
    }
    console.log(`Video ${job.state}: ${job.url}${job.error ? ` (${job.error})` : ''}`);
    saveVideoJobs();
    await rm(partial, { recursive: true, force: true }).catch(() => {});
    await updateYtdlp();
    nextVideo();
  };
  child.on('error', (e) => finish(-1, e.code === 'ENOENT' ? `yt-dlp isn't installed at ${YTDLP}` : e.message));
  child.on('exit', (code) => finish(code));
}

// ---------------------------------------------------------------------------------------------
// Assistant: chats for the Assistant mini-app, answered by a model running on this machine. Each
// model is its own systemd unit serving llama.cpp's OpenAI-style API. Only one fits in video
// memory, so starting one stops the others, and the one in use stops after a quarter of an hour
// without questions. To add a model: give it a quadlet on its own port with no [Install], add its
// container to GAME_MODE_UNITS, and add an entry below. The first entry is the default.
// An answer keeps being written when the phone disconnects, so leaving the app doesn't lose it.
// Each chat is a JSON file in `assistant/`.

const ASSISTANT_MODELS = [
  {
    id: 'qwen3.5-9b',
    name: 'Qwen3.5 9B',
    unit: 'llama.service',
    url: 'http://localhost:8080',
    /** Can think before answering, switched with the chat template's enable_thinking. */
    thinking: true,
    /** Can look at photos (llama.cpp loads the mmproj file that -hf finds next to the model). */
    vision: true,
    /** Can call ASSISTANT_TOOLS to look at the server. */
    tools: true,
    /** Qwen's recommended settings for each mode. */
    sampling: {
      think: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 },
      quick: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5 },
    },
  },
];
const ASSISTANT_DIR = path.join(ROOT, 'assistant');
const ASSISTANT_IDLE_MS = 15 * 60_000;
const ASSISTANT_START_TIMEOUT_MS = 5 * 60_000;
/** Longest answer, thinking included. Thinking takes far more room than the answer. */
const ASSISTANT_REPLY_TOKENS = { think: 8192, quick: 4096 };
const ASSISTANT_MAX_TEXT = 32_000;
/** A rough count, for keeping a long chat inside the model's context. */
const CHARS_PER_TOKEN = 3;
const CHAT_ID = /^[\w-]{8,64}$/;
/**
 * Photos are made a JPEG of at most this many pixels on the long side, which keeps one to
 * roughly 1,600 tokens of context and reads fine for text in a screenshot.
 */
const IMAGE_MAX_SIDE = 1280;
const IMAGE_TOKENS = 1600;
const IMAGE_MAX_BYTES = 50 * 1024 * 1024;
const IMAGES_PER_MESSAGE = 4;
const IMAGE_DIR = path.join(ASSISTANT_DIR, 'images');
const IMAGE_ID = /^[0-9a-f]{24}$/;
/** Photos sent without a question after them are deleted once they're this old. */
const IMAGE_ORPHAN_MS = 3600_000;

let assistantLastUsed = 0;
let assistantStarting; // { model, promise }
/** Context per request (tokens), read from each model once it's up. */
const assistantContext = new Map();
/** Answers being written, by chat id: { chat, message, controller }. */
const generations = new Map();

const modelAnswers = (model) =>
  fetch(`${model.url}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);

async function unitActive(unit) {
  const { stdout } = await run('systemctl', ['--user', 'is-active', unit]).catch((e) => e);
  return stdout?.trim() === 'active';
}

function findModel(id) {
  const model = id === undefined ? ASSISTANT_MODELS[0] : ASSISTANT_MODELS.find((m) => m.id === id);
  if (!model) throw new HttpError(400, `No model called ${id}`);
  return model;
}

async function assistantState() {
  const models = await Promise.all(
    ASSISTANT_MODELS.map(async (m) => {
      const state =
        assistantStarting?.model === m ? 'starting'
        : (await modelAnswers(m)) ? 'running'
        : (await unitActive(m.unit)) ? 'starting'
        : 'stopped';
      return { id: m.id, name: m.name, thinking: !!m.thinking, vision: !!m.vision, state };
    }),
  );
  return { models, gameMode: gameMode.active };
}

/** Starts the model if it isn't running, stopping any other one first. */
async function wakeModel(model) {
  gameModeError('the assistant');
  assistantLastUsed = Date.now();
  while (assistantStarting && assistantStarting.model !== model) await assistantStarting.promise.catch(() => {});
  if (!assistantStarting && (await modelAnswers(model))) return;
  if (!assistantStarting) {
    const promise = (async () => {
      for (const other of ASSISTANT_MODELS) {
        if (other !== model && (await unitActive(other.unit))) {
          console.log(`Stopping ${other.name} to make room for ${model.name}`);
          await run('systemctl', ['--user', 'stop', other.unit], { timeout: 120_000 });
        }
      }
      console.log(`Starting ${model.name} for the Assistant app`);
      await run('systemctl', ['--user', 'start', model.unit], { timeout: 120_000 });
      const deadline = Date.now() + ASSISTANT_START_TIMEOUT_MS;
      while (!(await modelAnswers(model))) {
        if (Date.now() > deadline) throw new HttpError(504, `${model.name} is taking too long to start. Try again in a minute.`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    })().finally(() => {
      assistantStarting = undefined;
    });
    assistantStarting = { model, promise };
  }
  await assistantStarting?.promise;
}

async function contextTokens(model) {
  if (!assistantContext.has(model.id)) {
    const props = await fetch(`${model.url}/props`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json(), () => undefined);
    const n = props?.default_generation_settings?.n_ctx;
    if (!n) return 8192;
    assistantContext.set(model.id, n);
  }
  return assistantContext.get(model.id);
}

async function stopIdleAssistant() {
  const idle = () => !assistantStarting && !generations.size && Date.now() - assistantLastUsed >= ASSISTANT_IDLE_MS;
  if (!idle()) return;
  for (const model of ASSISTANT_MODELS) {
    // Checked again after the wait, in case a question came in meanwhile.
    if (!(await unitActive(model.unit)) || !idle()) continue;
    console.log(`Stopping ${model.name}, unused for a quarter of an hour`);
    await run('systemctl', ['--user', 'stop', model.unit], { timeout: 120_000 }).catch((e) =>
      console.error(`Couldn't stop ${model.name}:`, e.message),
    );
  }
}

function chatPath(id) {
  if (!CHAT_ID.test(id)) throw new HttpError(400, 'Bad chat id');
  return path.join(ASSISTANT_DIR, `${id}.json`);
}

async function loadChat(id) {
  if (generations.has(id)) return generations.get(id).chat;
  const chat = await readFile(chatPath(id), 'utf8').then(JSON.parse, () => undefined);
  // An answer the server was writing when it restarted.
  for (const m of chat?.messages ?? []) {
    if (m.pending) Object.assign(m, { pending: undefined, stopped: true });
  }
  return chat;
}

async function saveChat(chat) {
  await mkdir(ASSISTANT_DIR, { recursive: true });
  const file = chatPath(chat.id);
  await writeFile(`${file}.tmp`, JSON.stringify(chat));
  await rename(`${file}.tmp`, file);
}

async function listChats() {
  const names = await readdir(ASSISTANT_DIR).catch(() => []);
  const chats = await Promise.all(
    names.filter((n) => n.endsWith('.json')).map((n) => loadChat(n.slice(0, -'.json'.length)).catch(() => undefined)),
  );
  return chats
    .filter(Boolean)
    .map((c) => {
      const last = c.messages.at(-1);
      return {
        id: c.id,
        title: c.title,
        model: c.model,
        updatedAt: c.updatedAt,
        preview: (last?.content || last?.error || '').slice(0, 200),
        answering: generations.has(c.id),
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

async function getChat(id) {
  const chat = await loadChat(id);
  if (!chat) throw new HttpError(404, 'No such chat');
  return chat;
}

async function deleteChat(id) {
  generations.get(id)?.controller.abort();
  const chat = await loadChat(id).catch(() => undefined);
  for (const image of (chat?.messages ?? []).flatMap((m) => m.images ?? [])) {
    await rm(imagePath(image), { force: true });
  }
  await rm(chatPath(id), { force: true });
  return { ok: true };
}

function imagePath(id) {
  if (!IMAGE_ID.test(id)) throw new HttpError(400, 'Bad photo id');
  return path.join(IMAGE_DIR, `${id}.jpg`);
}

/** Takes a photo from the phone and keeps a smaller JPEG of it, upright and without its metadata. */
async function receiveImage(req) {
  if (Number(req.headers['content-length']) > IMAGE_MAX_BYTES) throw new HttpError(413, 'Photos can be up to 50 MB');
  await mkdir(IMAGE_DIR, { recursive: true });
  const id = randomBytes(12).toString('hex');
  const part = path.join(IMAGE_DIR, `.${id}.part`);
  try {
    let size = 0;
    await pipeline(
      req,
      async function* (chunks) {
        for await (const chunk of chunks) {
          size += chunk.length;
          if (size > IMAGE_MAX_BYTES) throw new HttpError(413, 'Photos can be up to 50 MB');
          yield chunk;
        }
      },
      createWriteStream(part, { flags: 'wx' }),
    );
    // [0]: the first frame of a GIF or the like.
    await run('magick', [`${part}[0]`, '-auto-orient', '-resize', `${IMAGE_MAX_SIDE}x${IMAGE_MAX_SIDE}>`, '-strip', '-quality', '85', `jpg:${imagePath(id)}`], {
      timeout: 60_000,
    }).catch((e) => {
      console.error(`Assistant: couldn't read a photo: ${e.stderr?.trim() || e.message}`);
      throw new HttpError(415, 'Couldn’t read that photo. JPEG, PNG and WebP work.');
    });
    return { id };
  } finally {
    await unlink(part).catch(() => {});
  }
}

async function sendImage(res, id) {
  const data = await readFile(imagePath(id)).catch(() => {
    throw new HttpError(404, 'That photo is gone');
  });
  // A photo never changes once saved, so the phone can keep it.
  res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': data.length, 'cache-control': 'private, max-age=31536000, immutable' });
  res.end(data);
}

/** Deletes photos that were sent but never asked about, such as ones removed before sending. */
async function sweepImages() {
  const names = await readdir(IMAGE_DIR).catch(() => []);
  if (!names.length) return;
  const used = new Set();
  for (const name of await readdir(ASSISTANT_DIR).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    const chat = await loadChat(name.slice(0, -'.json'.length)).catch(() => undefined);
    for (const m of chat?.messages ?? []) for (const image of m.images ?? []) used.add(image);
  }
  for (const name of names) {
    const file = path.join(IMAGE_DIR, name);
    const info = await stat(file).catch(() => undefined);
    if (!info || used.has(path.parse(name).name) || Date.now() - info.mtimeMs < IMAGE_ORPHAN_MS) continue;
    await rm(file, { force: true });
  }
}

function stopAnswer(id) {
  const generation = generations.get(id);
  if (!generation) throw new HttpError(409, 'Nothing is being answered');
  generation.message.stopped = true;
  generation.controller.abort();
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Assistant tools: what a model with `tools` can look at to answer questions about the server.
// All of them only read. Each returns plain text, short enough for a small model's context.

/** Rounds of tool calls before the model has to answer with what it has. */
const TOOL_ROUNDS = 4;
/** Room for everything the tools return in one answer (characters). */
const TOOL_RESULTS_CHARS = 14_000;
const TOOL_RESULT_CHARS = 5000;
const TOOL_LOG_LINES = 60;
const TOOL_LOG_LINE_CHARS = 300;
const TOOL_HISTORY_POINTS = 12;

const when = { type: 'string', description: 'Local time, like 2026-10-22 23:00' };
const tool = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const ASSISTANT_TOOLS = [
  tool('server_now', 'What the server is doing right now: CPU, memory, temperatures, disk space, and each service with its state and usage.'),
  tool(
    'server_history',
    'How busy the server was over a stretch of time: CPU, GPU, memory, swap, stalls, temperatures, network and power, with the services using the most CPU and memory. Give a service to see just that one.',
    { from: when, to: when, service: { type: 'string', description: 'A service name, like sonarr or jellyfin' } },
    ['from', 'to'],
  ),
  tool(
    'server_events',
    'What happened over a stretch of time: boots, services starting, stopping, crashing or failing, memory kills, problems like full disks or hot drives, and game mode.',
    { from: when, to: when },
    ['from', 'to'],
  ),
  tool(
    'service_logs',
    "What a service wrote to its log, newest last. Defaults to its last lines; give a stretch of time to look at when something happened.",
    {
      service: { type: 'string', description: 'A service name, like sonarr or jellyfin' },
      from: when,
      to: when,
      problems_only: { type: 'boolean', description: 'Only lines mentioning errors, failures or warnings' },
    },
    ['service'],
  ),
  tool(
    'reliability',
    'How each service held up over the last days: crashes, failures, memory kills, restarts, and how much of the time it was running.',
    { days: { type: 'number', description: 'How many days back, 1 to 365' } },
    ['days'],
  ),
  tool('drives', 'Each drive with its SMART health, temperature, age, wear and what is reading or writing it now.'),
];

const pct = (v) => `${Math.round(v * 100)}%`;
const gb = (v) => `${(v / GIB).toFixed(1)} GB`;
const mbits = (v) => `${((v * 8) / 1e6).toFixed(1)} Mb/s`;
const mbytes = (v) => `${(v / 1e6).toFixed(1)} MB/s`;

/** HH:MM, 24-hour, in the server's time zone. */
const clockTime = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
/** The form tools take times in. */
const toolTime = (t) => {
  const d = new Date(t);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
const dayTime = (t) => `${new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} ${clockTime(t)}`;
/** A stretch of time for a step's label, without the day twice. */
const span = (from, to) =>
  `${dayTime(from)}–${new Date(from).toDateString() === new Date(to).toDateString() ? clockTime(to) : dayTime(to)}`;

/** A time a model gave, as ms. Throws a message the model can act on. */
function parseToolTime(value, name) {
  const t = typeof value === 'string' ? Date.parse(value.trim().replace(' ', 'T')) : NaN;
  if (Number.isNaN(t)) throw new Error(`${name} should be a local time like ${toolTime(Date.now())}`);
  return t;
}

function toolRange(args) {
  const from = parseToolTime(args.from, 'from');
  const to = Math.min(Date.now(), parseToolTime(args.to, 'to'));
  if (from >= to) throw new Error('from must be before to, and in the past');
  return [from, to];
}

/** The service a model named: by id, name, or part of the name. */
async function findService(name) {
  const list = lastServices ?? (await services());
  const want = String(name ?? '').trim().toLowerCase();
  const found =
    list.find((s) => s.id.toLowerCase() === want || s.name.toLowerCase() === want) ??
    list.find((s) => s.name.toLowerCase().includes(want) || s.id.toLowerCase().includes(want));
  if (!want || !found) throw new Error(`No service called "${name}". There are: ${list.map((s) => s.name).join(', ')}`);
  return found;
}

/** System series the history tool reports, with how to show their values. */
const TOOL_SERIES = [
  ['CPU', 'cpu', pct],
  ['GPU', 'gpu', pct],
  ['Memory used', 'mem', gb],
  ['Swap used', 'swap', gb],
  ['Time stalled waiting for CPU', 'pcpu', pct],
  ['Time stalled waiting for memory', 'pmem', pct],
  ['Time stalled waiting for disk', 'pio', pct],
  ['CPU temperature', 'temp', (v) => `${Math.round(v)}°C`],
  ['GPU temperature', 'gtemp', (v) => `${Math.round(v)}°C`],
  ['Download', 'rx', mbits],
  ['Upload', 'tx', mbits],
  ['CPU power', 'cpow', (v) => `${Math.round(v)} W`],
  ['GPU power', 'gpow', (v) => `${Math.round(v)} W`],
  ['Files Tdarr is converting', 'conv', (v) => v.toFixed(1)],
];
const TOOL_SERVICE_SERIES = [
  ['CPU (share of the whole machine)', 'cpu', pct],
  ['Memory', 'mem', gb],
  ['Disk read', 'r', mbytes],
  ['Disk write', 'w', mbytes],
  ['Download', 'rx', mbits],
  ['Upload', 'tx', mbits],
];

function historyText(from, to, service) {
  const entries = historyEntries(from).filter((e) => e.t < to);
  if (!entries.length) return 'No readings in that stretch; the server may have been off.';
  const series = service
    ? TOOL_SERVICE_SERIES.map(([label, k, format]) => [label, `s:${service.id}:${k}`, format])
    : TOOL_SERIES;
  const summary = summarize(entries, Object.fromEntries(series.map(([label, key]) => [label, key])), from, to, TOOL_HISTORY_POINTS);
  const step = (to - from) / TOOL_HISTORY_POINTS;
  const stamp = to - from > DAY_MS ? dayTime : clockTime;
  const out = [`${service ? service.name : 'Whole server'}, ${dayTime(from)} to ${dayTime(to)}, in ${TOOL_HISTORY_POINTS} steps from ${stamp(from)}, ${Math.round(step / 60_000)} min each (- = no reading):`];
  for (const [label, , format] of series) {
    const s = summary[label];
    if (s.average === undefined) continue;
    out.push(`${label}: average ${format(s.average)}, peak ${format(s.peak)}; ${s.values.map((v) => (v === null ? '-' : format(v))).join(', ')}`);
  }
  if (!service) {
    const names = new Map((lastServices ?? []).map((x) => [x.id, x.name]));
    for (const [label, pattern, format] of [
      ['Most CPU', /^s:(.+):cpu$/, pct],
      ['Most memory', /^s:(.+):mem$/, gb],
    ]) {
      const top = [...totals(entries, pattern)].sort((a, b) => b[1].average - a[1].average).slice(0, 5);
      out.push(`${label} (average while running): ${top.map(([id, t]) => `${names.get(id) ?? id} ${format(t.average)}`).join(', ')}`);
    }
  }
  return out.join('\n');
}

function eventText(e) {
  const what =
    e.kind === 'game' ? `Game mode ${e.on ? 'on' : 'off'}${e.detail ? ` (${e.detail})` : ''}`
    : e.kind === 'problem' ? `Problem: ${e.detail}`
    : e.kind === 'resolved' ? `Resolved: ${e.detail}`
    : e.kind === 'boot' ? 'Server booted'
    : e.kind === 'oom' ? `${e.name} killed for running out of memory${e.detail ? ` (${e.detail})` : ''}`
    : `${e.name ?? e.id} ${e.kind}${e.by ? ` by ${e.by}` : ''}${e.detail ? ` (${e.detail})` : ''}`;
  return `${dayTime(e.t)} ${what}`;
}

async function runTool(name, args) {
  if (name === 'server_now') {
    const s = await status();
    const lines = [
      `Up ${Math.round(s.host.uptimeSec / 3600)} h. CPU ${pct(s.cpu.usage)} (load ${s.cpu.load.map((l) => l.toFixed(1)).join(' ')} on ${s.cpu.cores} threads), GPU ${pct(s.gpu.usage)}.`,
      `Memory ${gb(s.memory.totalBytes - s.memory.availableBytes)} used of ${gb(s.memory.totalBytes)}, swap ${gb(s.memory.swapTotalBytes - s.memory.swapFreeBytes)} used.`,
      `Network: down ${mbits(s.network.rxPerSec)}, up ${mbits(s.network.txPerSec)}.`,
      `Temperatures: ${s.temperatures.map((t) => `${t.label} ${Math.round(t.celsius)}°C`).join(', ')}.`,
      `Disks: ${s.disks.map((d) => `${d.mount} ${pct(d.usedBytes / d.totalBytes)} full, ${gb(d.availableBytes)} free`).join('; ')}.`,
      `Game mode ${s.gameMode.active ? 'on: the download stack is stopped' : 'off'}.`,
      'Services:',
      ...s.services.map(
        (x) =>
          `- ${x.name}: ${x.state}${x.health ? ` (${x.health})` : ''}${x.detail && x.state === 'failed' ? `, ${x.detail}` : ''}` +
          (x.usage ? `, ${gb(x.usage.usedBytes)} memory, ${pct(x.usage.cpu)} CPU` : '') +
          (x.since && x.state === 'running' ? `, since ${dayTime(x.since)}` : '') +
          (x.restarts ? `, restarted ${x.restarts}×` : ''),
      ),
    ];
    return { label: 'Checked the server now', text: lines.join('\n') };
  }
  if (name === 'server_history') {
    const [from, to] = toolRange(args);
    const service = args.service ? await findService(args.service) : undefined;
    return { label: `${service ? `${service.name}’s` : 'Server'} usage, ${span(from, to)}`, text: historyText(from, to, service) };
  }
  if (name === 'server_events') {
    const [from, to] = toolRange(args);
    const list = events.filter((e) => e.t >= from && e.t <= to);
    const shown = list.slice(-80);
    const text = list.length
      ? [...(list.length > shown.length ? [`${list.length - shown.length} earlier events left out.`] : []), ...shown.map(eventText)].join('\n')
      : 'Nothing happened in that stretch.';
    return { label: `Events, ${span(from, to)}`, text };
  }
  if (name === 'service_logs') {
    const service = await findService(args.service);
    const [from, to] = args.from || args.to ? toolRange({ from: args.from ?? toolTime(Date.now() - DAY_MS), to: args.to ?? toolTime(Date.now()) }) : [];
    const { lines } = await serviceLogs(service.id, { errors: !!args.problems_only, since: from, until: to, lines: TOOL_LOG_LINES });
    const stamp = from && to - from <= DAY_MS ? clockTime : dayTime;
    const text = lines.length
      ? lines.map((l) => `${stamp(l.at)} ${l.text.length > TOOL_LOG_LINE_CHARS ? `${l.text.slice(0, TOOL_LOG_LINE_CHARS)}…` : l.text}`).join('\n')
      : `${service.name} logged nothing${args.problems_only ? ' about problems' : ''}${from ? ' then' : ''}.`;
    return { label: `${service.name}’s ${args.problems_only ? 'problems' : 'log'}${from ? `, ${span(from, to)}` : ''}`, text };
  }
  if (name === 'reliability') {
    const days = Math.min(365, Math.max(1, Number(args.days) || 7));
    const r = reliability(days * 86400);
    const covered = (Date.now() - Math.max(r.start, r.oldest)) / DAY_MS;
    const lines = [
      ...(covered < days - 0.5 ? [`Records only go back ${covered.toFixed(1)} days.`] : []),
      r.boots.length ? `The server booted ${r.boots.length} times: ${r.boots.map(dayTime).join(', ')}.` : 'The server didn’t reboot.',
      ...r.services.map((x) => {
        const trouble = [
          x.crashes && `${x.crashes} crashes`,
          x.failures && `${x.failures} failures`,
          x.oomKills && `${x.oomKills} memory kills`,
          x.restarts && `${x.restarts} restarts`,
          x.stops && `${x.stops} unexplained stops`,
        ].filter(Boolean);
        return `- ${x.name}: running ${x.running === undefined ? '?' : pct(x.running)} of the time${trouble.length ? `, ${trouble.join(', ')}` : ''}${x.lastTrouble ? `, last trouble ${dayTime(x.lastTrouble)}` : ''}`;
      }),
      'Services that only start on demand (llama, seerr) or stop in game mode run less than all the time by design.',
    ];
    return { label: `Reliability over ${days} days`, text: lines.join('\n') };
  }
  if (name === 'drives') {
    const { drives: list, error } = await drives();
    const lines = list.map((d) => {
      const m = d.smart ?? {};
      const facts = [
        `${d.kind}, ${gb(d.sizeBytes)}`,
        d.mounts.length ? `mounted at ${d.mounts.join(', ')}` : 'not mounted',
        `health ${d.health}`,
        d.temperature !== undefined && `${Math.round(d.temperature)}°C`,
        m.powerOnHours !== undefined && `${(m.powerOnHours / 8766).toFixed(1)} years powered on`,
        m.lifeLeft !== undefined && `${pct(m.lifeLeft)} life left`,
        m.badSectors && `${m.badSectors} bad sectors`,
        m.reallocated && `${m.reallocated} reallocated`,
        m.pending && `${m.pending} pending sectors`,
        m.cableErrors && `${m.cableErrors} cable errors`,
        m.selfTest && `last self-test ${m.selfTest}`,
        d.activity && `now reading ${mbytes(d.activity.readPerSec)}, writing ${mbytes(d.activity.writePerSec)}, ${pct(d.activity.busy)} busy`,
      ].filter(Boolean);
      const issues = d.issues.map((i) => i.text);
      return `- ${d.model}: ${facts.join(', ')}${issues.length ? `. Issues: ${issues.join('; ')}` : ''}${d.users.length ? `. Using it most: ${d.users.map((u) => u.name).join(', ')}` : ''}`;
    });
    return { label: 'Checked the drives', text: [...(error ? [`Couldn't read SMART data: ${error}`] : []), ...lines].join('\n') };
  }
  throw new Error(`There's no tool called ${name}`);
}

/** Runs one tool call; failures go back to the model as text, so it can try again or say so. */
async function useTool(call, room) {
  const name = call.function.name;
  let args;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return { label: `Tried ${name}`, result: 'Error: the arguments weren’t valid JSON.' };
  }
  try {
    const { label, text } = await runTool(name, args ?? {});
    const max = Math.max(500, Math.min(TOOL_RESULT_CHARS, room));
    return { label, result: text.length > max ? `${text.slice(0, max)}\n… (cut short)` : text };
  } catch (e) {
    console.error(`Assistant tool ${name} failed: ${e.message}`);
    return { label: `Tried ${name.replace(/_/g, ' ')}`, result: `Error: ${e.message}` };
  }
}

function systemPrompt(model) {
  const now = new Date();
  const today = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return [
    `You are the assistant in Homebase, the user's personal iPhone app. You are ${model.name}, running on their home PC.`,
    `Today is ${today}, and the time is ${clockTime(now.getTime())}.`,
    ...(model.tools
      ? [
          'The PC is also the home server: Jellyfin, the Sonarr/Radarr/qBittorrent download stack, Tdarr and more, as Podman containers.',
          'For questions about it (slowness, crashes, what happened when, drives, what a service logged), look with the tools rather than guessing, then answer from what they show.',
          'Say what the data shows. When it doesn’t show why something happened, say so rather than guessing a cause.',
          `Times you pass to tools are the PC's local time, like ${toolTime(now.getTime())}. Don't use tools for questions that aren't about the server.`,
        ]
      : []),
    'Answers are read on a phone, so get to the point and keep them short unless asked for detail.',
    'Markdown is shown: headings, lists, bold, italics, inline code and code blocks. Avoid tables, which display poorly.',
  ].join(' ');
}

/**
 * The newest messages that fit in the model's context, leaving room for the answer. Photos go
 * in as data URLs, for a model that can see them.
 */
async function chatHistory(chat, model, budgetChars) {
  const history = [];
  let used = 0;
  for (const m of chat.messages.slice(0, -1).reverse()) {
    const images = model.vision ? (m.images ?? []) : [];
    if (!m.content && !images.length) continue;
    used += m.content.length + images.length * IMAGE_TOKENS * CHARS_PER_TOKEN;
    if (used > budgetChars && history.length) break;
    if (!images.length) {
      history.unshift({ role: m.role, content: m.content });
      continue;
    }
    const parts = [];
    for (const image of images) {
      const data = await readFile(imagePath(image)).catch(() => undefined);
      if (data) parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data.toString('base64')}` } });
    }
    // A photo sent on its own gets a plain question, rather than a guess at what's wanted.
    parts.push({ type: 'text', text: m.content || (images.length > 1 ? 'What’s in these photos?' : 'What’s in this photo?') });
    history.unshift({ role: m.role, content: parts });
  }
  return history;
}

/**
 * Adds the question to the chat (making the chat if it's new) and streams the answer back as
 * newline-separated JSON: `status` while the model starts, then `reasoning` and `content` pieces,
 * and `done` with the finished message, or `error`.
 */
async function ask(req, res, id) {
  chatPath(id);
  let body;
  try {
    body = JSON.parse((await readBody(req))?.toString() ?? '{}');
  } catch {
    throw new HttpError(400, 'Expected JSON');
  }
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  const images = Array.isArray(body?.images) ? body.images : [];
  if (!text && !images.length) throw new HttpError(400, 'Nothing to ask');
  if (images.length > IMAGES_PER_MESSAGE) throw new HttpError(400, `Up to ${IMAGES_PER_MESSAGE} photos at a time`);
  for (const image of images) {
    if (typeof image !== 'string' || !(await stat(imagePath(image)).catch(() => undefined))) {
      throw new HttpError(400, 'One of the photos is gone. Add it again.');
    }
  }
  if (text.length > ASSISTANT_MAX_TEXT) throw new HttpError(413, 'That message is too long');
  if (generations.has(id)) throw new HttpError(409, 'Still answering the last message');
  gameModeError('the assistant');

  const now = Date.now();
  const title = text.split('\n')[0].slice(0, 80) || (images.length > 1 ? 'Photos' : 'Photo');
  const chat = (await loadChat(id)) ?? { id, title, createdAt: now, messages: [] };
  const model = findModel(body.model ?? chat.model);
  if (images.length && !model.vision) throw new HttpError(400, `${model.name} can’t look at photos`);
  const think = !!body.think && !!model.thinking;
  chat.model = model.id;
  chat.updatedAt = now;
  chat.messages.push({ role: 'user', content: text, ...(images.length ? { images } : {}), at: now });
  const message = { role: 'assistant', content: '', reasoning: '', model: model.id, at: now, pending: true };
  chat.messages.push(message);
  const controller = new AbortController();
  generations.set(id, { chat, message, controller });
  await saveChat(chat);

  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  // The phone may go away mid-answer (the app was left); the answer is still finished and saved.
  const send = (event) => {
    if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  await answer({ chat, message, model, think, controller, send });
  if (!res.writableEnded) res.end();
}

/**
 * Writes the answer to the chat's last question into `message`, calling `send` with each piece,
 * and saves the chat. A model with tools may look at the server first, a few rounds at most.
 */
async function answer({ chat, message, model, think, controller, send }) {
  const id = chat.id;
  try {
    if (!(await modelAnswers(model))) send({ type: 'status', text: `Starting ${model.name}…` });
    await wakeModel(model);
    const reply = ASSISTANT_REPLY_TOKENS[think ? 'think' : 'quick'];
    const system = systemPrompt(model);
    const tools = model.tools ? JSON.stringify(ASSISTANT_TOOLS) : '';
    const budget = ((await contextTokens(model)) - reply) * CHARS_PER_TOKEN - system.length - tools.length;
    // What the tools return needs room too, so a long chat gives up some of its oldest messages.
    const messages = [
      { role: 'system', content: system },
      ...(await chatHistory(chat, model, model.tools ? budget - TOOL_RESULTS_CHARS : budget)),
    ];
    let toolChars = 0;
    for (let round = 0; ; round++) {
      // The last round has no tools, so it has to answer with what it found.
      const offerTools = model.tools && round < TOOL_ROUNDS;
      const upstream = await fetch(`${model.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stream: true,
          max_tokens: reply,
          messages,
          ...(offerTools ? { tools: ASSISTANT_TOOLS } : {}),
          ...(model.thinking ? { chat_template_kwargs: { enable_thinking: think } } : {}),
          ...model.sampling?.[think ? 'think' : 'quick'],
        }),
        signal: controller.signal,
      });
      if (!upstream.ok) {
        const detail = await upstream.json().then((b) => b?.error?.message, () => undefined);
        throw new Error(`${model.name} answered ${upstream.status}${detail ? `: ${detail}` : ''}`);
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let said = '';
      // Tool calls come in pieces, by index: the id and name first, then the arguments bit by bit.
      const calls = [];
      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          const choice = JSON.parse(line.slice(6)).choices?.[0];
          const { reasoning_content: reasoning, tool_calls: callParts } = choice?.delta ?? {};
          let content = choice?.delta?.content;
          if (reasoning) {
            message.reasoning += reasoning;
            send({ type: 'reasoning', text: reasoning });
          }
          if (content) {
            // Text from before a look at the server, then the answer after it: keep them apart.
            if (!said && message.content && !message.content.endsWith('\n')) content = `\n\n${content}`;
            said += content;
            message.content += content;
            send({ type: 'content', text: content });
          }
          for (const part of callParts ?? []) {
            const call = (calls[part.index ?? 0] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
            if (part.id) call.id = part.id;
            if (part.function?.name) call.function.name += part.function.name;
            if (part.function?.arguments) call.function.arguments += part.function.arguments;
          }
          if (choice?.finish_reason === 'length') message.cutOff = true;
        }
        assistantLastUsed = Date.now();
      }
      const made = calls.filter((c) => c?.function.name);
      if (!offerTools || !made.length) break;
      messages.push({ role: 'assistant', content: said || null, tool_calls: made });
      for (const call of made) {
        const { label, result } = await useTool(call, TOOL_RESULTS_CHARS - toolChars);
        toolChars += result.length;
        (message.steps ??= []).push({ label });
        send({ type: 'step', label });
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      assistantLastUsed = Date.now();
    }
  } catch (e) {
    if (!message.stopped) {
      message.error = e.name === 'TimeoutError' ? `${model.name} didn't answer` : e.message;
      console.error(`Assistant: ${message.error}`);
    }
  } finally {
    message.pending = undefined;
    if (!message.reasoning) message.reasoning = undefined;
    chat.updatedAt = Date.now();
    assistantLastUsed = Date.now();
    generations.delete(id);
    // A chat deleted while it was being answered stays deleted.
    if (!controller.signal.aborted || message.stopped) await saveChat(chat).catch((e) => console.error("Couldn't save a chat:", e.message));
    send(message.error ? { type: 'error', error: message.error } : { type: 'done', message });
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

function log(req, message) {
  console.log(`${new Date().toISOString()} ${req.socket.remoteAddress} ${message}`);
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!allowedPeer(req.socket.remoteAddress)) {
    log(req, 'refused: not a Tailscale or local address');
    return sendJson(res, 403, { error: 'Only reachable over Tailscale' });
  }
  if (url.pathname === '/health') return sendJson(res, 200, { ok: true });
  if (req.method === 'POST' && url.pathname === '/api/pair') return sendJson(res, 200, await redeemPairing(req));
  if (!authorized(req, await getToken())) return sendJson(res, 401, { error: 'Wrong or missing token' });

  if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, 200, await status());
  if (req.method === 'GET' && url.pathname === '/api/usage') return sendJson(res, 200, await usage());
  if (req.method === 'GET' && url.pathname === '/api/processes') return sendJson(res, 200, await processes());
  if (req.method === 'GET' && url.pathname === '/api/gpu') return sendJson(res, 200, await gpu());
  if (req.method === 'GET' && /^\/api\/(history|network|reliability)$/.test(url.pathname)) {
    const range = Number(url.searchParams.get('range') ?? 3600);
    if (!(range >= 60 && range <= HISTORY_MAX_MS / 1000)) throw new HttpError(400, 'Range must be 60 seconds to a year');
    if (url.pathname === '/api/network') return sendJson(res, 200, network(range));
    if (url.pathname === '/api/reliability') return sendJson(res, 200, reliability(range));
    const [service, drive, device] = ['service', 'drive', 'device'].map((k) => url.searchParams.get(k) ?? undefined);
    return sendJson(res, 200, historyFor(range, { service, drive, device }));
  }
  if (req.method === 'GET' && url.pathname === '/api/drives') return sendJson(res, 200, await drives());
  if (req.method === 'GET' && url.pathname === '/api/cpu') return sendJson(res, 200, await cpu());
  if (url.pathname === '/api/power') {
    if (req.method === 'GET') return sendJson(res, 200, powerState());
    if (req.method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req))?.toString() ?? '{}');
      } catch {
        throw new HttpError(400, 'Expected JSON');
      }
      log(req, `power settings ${JSON.stringify(body)}`);
      return sendJson(res, 200, await setPowerSettings(body ?? {}));
    }
  }

  if (url.pathname === '/api/game-mode') {
    if (req.method === 'GET') return sendJson(res, 200, gameModeState());
    if (req.method === 'POST') {
      let on;
      try {
        on = JSON.parse((await readBody(req))?.toString() ?? '{}').on;
      } catch {
        throw new HttpError(400, 'Expected JSON');
      }
      log(req, `game mode ${on}`);
      return sendJson(res, 200, await setGameMode(on));
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/tailscale') return sendJson(res, 200, await tailscale());
  if (req.method === 'GET' && url.pathname === '/api/storage') return sendJson(res, 200, await storage());
  const logs = /^\/api\/services\/([^/]+)\/logs$/.exec(url.pathname);
  if (req.method === 'GET' && logs) {
    const after = url.searchParams.get('after') ?? undefined;
    if (after && !/^[\w=;-]+$/.test(after)) throw new HttpError(400, 'Bad cursor');
    return sendJson(res, 200, await serviceLogs(decodeURIComponent(logs[1]), { after, errors: url.searchParams.get('errors') === '1' }));
  }

  const match = /^\/api\/services\/([^/]+)\/(start|stop|restart|run)$/.exec(url.pathname);
  if (req.method === 'POST' && match) {
    const id = decodeURIComponent(match[1]);
    log(req, `${match[2]} ${id}`);
    await performAction(id, match[2]);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/qbittorrent/limit') {
    if (req.method === 'GET') return sendJson(res, 200, await speedLimit());
    if (req.method === 'POST') {
      let limit;
      try {
        limit = JSON.parse((await readBody(req))?.toString() ?? '{}').limit;
      } catch {
        throw new HttpError(400, 'Expected JSON');
      }
      log(req, `download limit ${limit}`);
      return sendJson(res, 200, await setSpeedLimit(limit));
    }
  }

  if (url.pathname === '/api/tdarr') {
    if (req.method === 'GET') return sendJson(res, 200, await conversions());
    if (req.method === 'POST') {
      let paused;
      try {
        paused = JSON.parse((await readBody(req))?.toString() ?? '{}').paused;
      } catch {
        throw new HttpError(400, 'Expected JSON');
      }
      log(req, `conversions paused ${paused}`);
      return sendJson(res, 200, await setConversionsPaused(paused));
    }
  }

  if (url.pathname === '/api/qbittorrent/seeding') {
    if (req.method === 'GET') return sendJson(res, 200, await seeding());
    if (req.method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req))?.toString() ?? '{}');
      } catch {
        throw new HttpError(400, 'Expected JSON');
      }
      log(req, `seeding ${JSON.stringify(body)}`);
      return sendJson(res, 200, await setSeeding(body ?? {}));
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/crash') {
    // The JS error behind the app's last crash, which iOS's own report leaves out.
    let report;
    try {
      report = JSON.parse((await readBody(req))?.toString() ?? '{}').report;
    } catch {
      throw new HttpError(400, 'Expected JSON');
    }
    log(req, `app crash report:\n${String(report).slice(0, 8000)}`);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/drop') return sendJson(res, 200, await dropFiles());
  if (req.method === 'POST' && url.pathname === '/api/drop/text') {
    let text;
    try {
      text = JSON.parse((await readBody(req))?.toString() ?? '{}').text;
    } catch {
      throw new HttpError(400, 'Expected JSON');
    }
    log(req, 'drop text');
    return sendJson(res, 200, await receiveDropText(text));
  }
  const drop = /^\/api\/drop\/files\/([^/]+)$/.exec(url.pathname);
  if (drop) {
    const name = dropName(drop[1]);
    if (req.method === 'GET') return sendDropFile(res, name);
    if (req.method === 'PUT') {
      log(req, `drop ${name}`);
      return sendJson(res, 200, await receiveDropFile(req, name));
    }
    if (req.method === 'DELETE') {
      log(req, `drop delete ${name}`);
      return sendJson(res, 200, await deleteDropFile(name));
    }
  }

  if (url.pathname === '/api/videos') {
    if (req.method === 'GET') return sendJson(res, 200, videoJobsState());
    if (req.method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req))?.toString() ?? '{}');
      } catch {
        throw new HttpError(400, 'Expected JSON');
      }
      log(req, `save video ${body?.url}`);
      return sendJson(res, 200, addVideo(body ?? {}));
    }
  }
  const video = /^\/api\/videos\/(\w+)(?:\/(retry|cancel))?$/.exec(url.pathname);
  if (video) {
    const [, id, action] = video;
    if (req.method === 'POST' && action) {
      log(req, `video ${action} ${id}`);
      return sendJson(res, 200, action === 'retry' ? retryVideo(id) : cancelVideo(id));
    }
    if (req.method === 'DELETE' && !action) {
      log(req, `video remove ${id}`);
      return sendJson(res, 200, removeVideo(id));
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/assistant') return sendJson(res, 200, await assistantState());
  if (req.method === 'GET' && url.pathname === '/api/assistant/chats') return sendJson(res, 200, await listChats());
  if (req.method === 'POST' && url.pathname === '/api/assistant/images') return sendJson(res, 200, await receiveImage(req));
  const image = /^\/api\/assistant\/images\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && image) return sendImage(res, image[1]);
  const chat = /^\/api\/assistant\/chats\/([^/]+)(\/stop)?$/.exec(url.pathname);
  if (chat) {
    const [, id, stop] = chat;
    if (req.method === 'GET' && !stop) return sendJson(res, 200, await getChat(id));
    if (req.method === 'POST' && stop) return sendJson(res, 200, stopAnswer(id));
    if (req.method === 'POST') {
      log(req, `assistant ask ${id}`);
      return ask(req, res, id);
    }
    if (req.method === 'DELETE' && !stop) {
      log(req, `assistant delete ${id}`);
      return sendJson(res, 200, await deleteChat(id));
    }
  }

  const arr = /^\/api\/arr\/(\w+)\/(.+)$/.exec(url.pathname);
  if (arr) return proxyArr(req, res, arr[1], arr[2], url.search);

  sendJson(res, 404, { error: 'Not found' });
}

async function pair() {
  const code = randomBytes(24).toString('base64url');
  await writeFile(PAIRING_PATH, JSON.stringify({ code, expires: Date.now() + PAIRING_TTL_MS }), { mode: 0o600 });
  const link = `homebase://server/connect?${new URLSearchParams({ url: PUBLIC_URL, code })}`;
  console.log(`Pairing link: ${link}`);
  const res = await fetch(NTFY_URL, {
    method: 'POST',
    headers: { Title: 'Connect Homebase to this server', Tags: 'link', Click: link },
    body: 'Tap to fill in the Server mini-app settings. The link works once, within 10 minutes.',
  }).catch((e) => ({ ok: false, statusText: e.message }));
  console.log(res.ok ? 'Sent through ntfy.' : `Couldn't send through ntfy: ${res.statusText}`);
}

/** Trades the code from a pairing link for the token. Each code works once. */
async function redeemPairing(req) {
  let given;
  try {
    given = JSON.parse((await readBody(req))?.toString() ?? '{}').code;
  } catch {
    throw new HttpError(400, 'Expected JSON');
  }
  const pending = await readFile(PAIRING_PATH, 'utf8').then(JSON.parse, () => undefined);
  const ok =
    typeof given === 'string' &&
    pending?.expires > Date.now() &&
    given.length === pending.code.length &&
    timingSafeEqual(Buffer.from(given), Buffer.from(pending.code));
  log(req, `pairing ${ok ? 'accepted' : 'refused'}`);
  if (pending && (ok || pending.expires <= Date.now())) await unlink(PAIRING_PATH).catch(() => {});
  if (!ok) throw new HttpError(403, 'This pairing link has expired or was already used. Run pair again.');
  return { token: await getToken() };
}

if (process.argv[2] === 'pair') {
  await pair();
} else {
  await getToken();
  await sample();
  setInterval(sample, 2000).unref();
  await loadEvents();
  await loadHistory();
  await loadPowerSettings();
  await refreshDrives();
  setInterval(refreshDrives, DRIVE_REFRESH_INTERVAL).unref();
  await samplePeers();
  setInterval(samplePeers, PEER_INTERVAL).unref();
  setInterval(recordHistory, HISTORY_INTERVAL).unref();
  setInterval(compactHistory, HISTORY_COMPACT_INTERVAL).unref();
  setInterval(() => checkJournal().catch((e) => console.error('Checking the journal failed:', e.message)), 60_000).unref();
  await loadGameMode();
  await checkGame();
  setInterval(checkGame, GAME_CHECK_INTERVAL).unref();
  setInterval(stopIdleSeerr, 60_000).unref();
  setInterval(stopIdleAssistant, 60_000).unref();
  setInterval(() => sweepImages().catch((e) => console.error("Couldn't clear old photos:", e.message)), 3600_000).unref();
  setInterval(() => sortTvQueue().catch(() => {}), 60_000).unref();
  await loadVideoJobs();
  setInterval(updateYtdlp, 3600_000).unref();
  setTimeout(watch, 10_000).unref();
  setInterval(watch, WATCH_INTERVAL).unref();

  // Node gives up on a request after 5 minutes by default, too soon for a large file over a slow link.
  createServer({ requestTimeout: 60 * 60_000 }, async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: e.stderr?.trim() || e.message || 'Internal error' });
    }
  }).listen(PORT, () => console.log(`Homebase status server listening on :${PORT}`));
}
