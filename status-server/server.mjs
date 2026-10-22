#!/usr/bin/env node
/**
 * Status server for Homebase's Server mini-app: system stats, services and containers, and
 * start/stop/restart for them. Also watches for problems and reports them through ntfy, since
 * the app can't get push notifications. Stops the download stack while a game runs (game mode)
 * and runs Seerr only while it's used. Passes the Requests mini-app's calls on to Seerr, Sonarr
 * and Radarr, and qBittorrent's speed limit and seeding. No dependencies beyond Node.js.
 *
 * It also keeps a day of history (CPU, memory, network, and each service's memory and CPU) in
 * `history.json`, and can list the processes and cgroups using the most memory and CPU.
 *
 * Every request needs `Authorization: Bearer <token>`. The token lives in `token` next to this
 * file and is created on first start. `node server.mjs pair` sends a link to the phone through
 * ntfy that fills in the app's connection settings. The link carries a one-time code rather than
 * the token, since ntfy keeps messages for days.
 *
 * Only loopback and Tailscale addresses are answered, in case the firewall ever opens the port to
 * the home network.
 */
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readdir, readFile, readlink, realpath, rename, statfs, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
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

const rates = { cpu: undefined, rxPerSec: undefined, txPerSec: undefined };
let lastCpu;
let lastNet;

async function readCpu() {
  const line = (await readFile('/proc/stat', 'utf8')).split('\n')[0];
  const [user, nice, system, idle, iowait, irq, softirq, steal] = line.split(/\s+/).slice(1).map(Number);
  return { idle: idle + iowait, total: user + nice + system + idle + iowait + irq + softirq + steal };
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
      rates.cpu = 1 - (cpu.idle - lastCpu.idle) / (cpu.total - lastCpu.total);
    }
    lastCpu = cpu;

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

/** Share of the last minute that something was stalled waiting on CPU, memory or disk. */
async function pressure() {
  const out = {};
  for (const kind of ['cpu', 'memory', 'io']) {
    const text = await readFile(`/proc/pressure/${kind}`, 'utf8').catch(() => '');
    const avg60 = Number(/^some .*avg60=([\d.]+)/m.exec(text)?.[1]);
    if (!Number.isNaN(avg60)) out[kind] = avg60 / 100;
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
 * Services and scopes, as paths relative to the cgroup root. A unit's own sub-groups (a
 * terminal's tabs, a container's payload) count toward it; only a user manager, which holds
 * slices of its own, is looked into.
 */
async function leafGroups(dir = '') {
  const entries = await readdir(path.join(CGROUP_ROOT, dir), { withFileTypes: true }).catch(() => []);
  const children = entries.filter((e) => e.isDirectory() && /\.(slice|service|scope)$/.test(e.name));
  const isUnit = /\.(service|scope)$/.test(dir);
  if (isUnit && !children.some((c) => c.name.endsWith('.slice'))) return [dir];
  if (dir && !children.length) return [];
  return (await Promise.all(children.map((c) => leafGroups(path.join(dir, c.name))))).flat();
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

async function readGroup(dir) {
  const base = path.join(CGROUP_ROOT, dir);
  const [current, memStat, cpuStat, ioStat] = await Promise.all([
    readNumber(`${base}/memory.current`),
    readFile(`${base}/memory.stat`, 'utf8').catch(() => ''),
    readFile(`${base}/cpu.stat`, 'utf8').catch(() => ''),
    readFile(`${base}/io.stat`, 'utf8').catch(() => ''),
  ]);
  if (current === undefined) return undefined;
  const mem = statFields(memStat);
  const cpu = statFields(cpuStat);
  let read = 0;
  let written = 0;
  for (const m of ioStat.matchAll(/rbytes=(\d+) wbytes=(\d+)/g)) {
    read += Number(m[1]);
    written += Number(m[2]);
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
  const groups = (await Promise.all((await leafGroups()).map(readGroup))).filter(Boolean);
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
  const pids = (await readdir('/proc')).filter((p) => /^\d+$/.test(p));
  const list = (
    await Promise.all(
      pids.map(async (pid) => {
        try {
          const [stat, cgroup, cmdline] = await Promise.all([
            readFile(`/proc/${pid}/stat`, 'utf8'),
            readFile(`/proc/${pid}/cgroup`, 'utf8'),
            readFile(`/proc/${pid}/cmdline`, 'utf8'),
          ]);
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
        } catch {
          return undefined; // Exited while we looked.
        }
      }),
    )
  ).filter(Boolean);

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
 * Programs with the card open, from the DRM fdinfo the kernel keeps per open file: the memory
 * each holds and the time each engine spent on its work, turned into a share since the previous
 * call. Only our own processes are readable, which covers the containers since they're rootless.
 */
async function gpuClients(slot) {
  const now = Date.now();
  const pids = (await readdir('/proc')).filter((p) => /^\d+$/.test(p));
  const clients = new Map();
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const fds = await readdir(`/proc/${pid}/fd`);
        const links = await Promise.all(fds.map((fd) => readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')));
        for (const [i, link] of links.entries()) {
          if (!link.startsWith('/dev/dri/')) continue;
          const info = await readFile(`/proc/${pid}/fdinfo/${fds[i]}`, 'utf8');
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
      } catch {} // Exited, or someone else's.
    }),
  );

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

const UNIT_PROPS = ['ActiveState', 'SubState', 'Result', 'ActiveEnterTimestamp', 'LastTriggerUSec', 'NextElapseUSecRealtime'];

async function showUnits(units, system) {
  if (!units.length) return {};
  const args = [...(system ? [] : ['--user']), 'show', '--timestamp=unix', `--property=${UNIT_PROPS.join(',')}`, ...units];
  const { stdout } = await run('systemctl', args);
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

async function containers() {
  const { stdout } = await run('podman', ['ps', '--all', '--format', 'json']);
  return JSON.parse(stdout || '[]');
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
  const [kind, name] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (kind === 'container') {
    if (!['start', 'stop', 'restart'].includes(action)) throw new HttpError(400, `Can't ${action} a container`);
    const pod = (await containers()).find((p) => p.Names?.includes(name));
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
// History: a reading every 15 seconds for the last day, kept in memory and saved to
// `history.json` every few minutes so a restart doesn't lose it.

const HISTORY_PATH = path.join(ROOT, 'history.json');
const HISTORY_INTERVAL = 15_000;
const HISTORY_KEEP_MS = 24 * 3600_000;
const HISTORY_SAVE_INTERVAL = 5 * 60_000;
const HISTORY_POINTS = 120;

/** { t, cpu, gpu, mem, cache, swap, rx, tx, temp, gtemp, gpow, vram, s: { serviceId: [usedBytes, cpu] } } */
let history = [];

async function loadHistory() {
  try {
    const saved = JSON.parse(await readFile(HISTORY_PATH, 'utf8'));
    if (Array.isArray(saved)) history = saved.filter((h) => h.t > Date.now() - HISTORY_KEEP_MS);
  } catch {}
}

async function saveHistory() {
  try {
    await writeFile(`${HISTORY_PATH}.tmp`, JSON.stringify(history));
    await rename(`${HISTORY_PATH}.tmp`, HISTORY_PATH);
  } catch (e) {
    console.error("Couldn't save history:", e.message);
  }
}

async function recordHistory() {
  try {
    const card = await gpuCard();
    const [info, temps, gpu, list, gpuSense, vram] = await Promise.all([
      meminfo(),
      temperatures(),
      gpuBusy(),
      services(),
      card ? gpuSensors(card) : undefined,
      card ? readNumber(`${card}/mem_info_vram_used`) : undefined,
    ]);
    const mem = memoryBreakdown(info);
    const round = (n) => (n === undefined ? undefined : Math.round(n * 1000) / 1000);
    history.push({
      t: Date.now(),
      cpu: round(rates.cpu),
      gpu: round(gpu),
      mem: mem.totalBytes - mem.availableBytes,
      cache: mem.cacheBytes,
      swap: mem.swapUsedBytes,
      rx: rates.rxPerSec === undefined ? undefined : Math.round(rates.rxPerSec),
      tx: rates.txPerSec === undefined ? undefined : Math.round(rates.txPerSec),
      temp: temps.find((t) => t.label === 'CPU')?.celsius,
      gtemp: gpuSense?.temperatures.find((t) => t.label === 'Hotspot')?.celsius ?? gpuSense?.temperatures[0]?.celsius,
      gpow: gpuSense?.power && Math.round(gpuSense.power.watts * 10) / 10,
      vram,
      s: Object.fromEntries(list.filter((x) => x.usage).map((x) => [x.id, [x.usage.usedBytes, round(x.usage.cpu)]])),
    });
    const cutoff = Date.now() - HISTORY_KEEP_MS;
    while (history.length && history[0].t < cutoff) history.shift();
  } catch (e) {
    console.error('Recording history failed:', e);
  }
}

const SERIES = {
  cpu: (h) => h.cpu,
  gpu: (h) => h.gpu,
  memory: (h) => h.mem,
  cache: (h) => h.cache,
  swap: (h) => h.swap,
  rx: (h) => h.rx,
  tx: (h) => h.tx,
  temp: (h) => h.temp,
  gpuTemp: (h) => h.gtemp,
  gpuPower: (h) => h.gpow,
  vram: (h) => h.vram,
};

/**
 * The last `rangeSec` seconds, averaged into evenly spaced buckets so the app gets the same
 * number of points for an hour or a day. A bucket with no readings (the server was off) is null.
 * Each series also gets its average and peak over the raw readings, which averaging would hide.
 */
function historyFor(rangeSec, serviceId) {
  const end = Date.now();
  const start = end - rangeSec * 1000;
  const step = (rangeSec * 1000) / HISTORY_POINTS;
  const series = serviceId
    ? { memory: (h) => h.s?.[serviceId]?.[0], cpu: (h) => h.s?.[serviceId]?.[1] }
    : SERIES;

  const out = {};
  for (const [name, pick] of Object.entries(series)) {
    const sums = new Array(HISTORY_POINTS).fill(0);
    const counts = new Array(HISTORY_POINTS).fill(0);
    let total = 0;
    let n = 0;
    let peak;
    for (const h of history) {
      if (h.t < start) continue;
      const v = pick(h);
      if (typeof v !== 'number') continue;
      const i = Math.min(HISTORY_POINTS - 1, Math.floor((h.t - start) / step));
      sums[i] += v;
      counts[i]++;
      total += v;
      n++;
      if (peak === undefined || v > peak) peak = v;
    }
    out[name] = {
      values: sums.map((sum, i) => (counts[i] ? sum / counts[i] : null)),
      average: n ? total / n : undefined,
      peak,
    };
  }
  return { start, end, step, series: out, oldest: history[0]?.t, memoryTotalBytes: os.totalmem() };
}

// ---------------------------------------------------------------------------------------------
// Watching: send ntfy messages when a problem starts and when it clears.

async function notify(title, message, tags) {
  try {
    const res = await fetch(NTFY_URL, {
      method: 'POST',
      headers: { Title: title, Tags: tags, Click: 'homebase://server' },
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
  return out;
}

let known = new Map();
async function watch() {
  try {
    const current = problems(await status());
    const started = [...current].filter(([k]) => !known.has(k)).map(([, v]) => v);
    const cleared = [...known].filter(([k]) => !current.has(k)).map(([, v]) => v);
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
const GAME_MODE_UNITS = ['gluetun', 'qbittorrent', 'flaresolverr', 'prowlarr', 'sonarr', 'radarr', 'recyclarr', 'seerr'];
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
  await run('systemctl', ['--user', 'stop', ...GAME_MODE_UNIT_FILES], { timeout: 180_000 });
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
    await saveGameMode();
    await (want ? stopGameModeUnits() : run('systemctl', ['--user', 'start', ...GAME_MODE_UNIT_FILES.filter((u) => u !== SEERR_UNIT)], { timeout: 180_000 })).catch(
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
      GET: /^(queue|calendar|release|series|series\/\d+|episodefile|qualityprofile|diskspace)$/,
      POST: /^release$/,
      PUT: /^series\/\d+$/,
      DELETE: /^(queue\/\d+|series\/\d+|episodefile\/bulk)$/,
    },
  },
  radarr: {
    label: 'Radarr',
    base: 'http://localhost:7878/api/v3',
    key: () => xmlApiKey('radarr'),
    routes: {
      GET: /^(queue|calendar|release|movie|movie\/\d+|qualityprofile)$/,
      POST: /^release$/,
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

  let upstream;
  try {
    upstream = await fetch(`${app.base}/${apiPath}${search}`, {
      method: req.method,
      headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
      body: req.method === 'GET' ? undefined : await readBody(req),
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
  if (req.method === 'GET' && url.pathname === '/api/history') {
    const range = Number(url.searchParams.get('range') ?? 3600);
    if (!(range >= 60 && range <= HISTORY_KEEP_MS / 1000)) throw new HttpError(400, 'Range must be 60 seconds to a day');
    return sendJson(res, 200, historyFor(range, url.searchParams.get('service') ?? undefined));
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
  await loadHistory();
  setInterval(recordHistory, HISTORY_INTERVAL).unref();
  setInterval(saveHistory, HISTORY_SAVE_INTERVAL).unref();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, async () => {
      await saveHistory();
      process.exit(0);
    });
  }
  await loadGameMode();
  await checkGame();
  setInterval(checkGame, GAME_CHECK_INTERVAL).unref();
  setInterval(stopIdleSeerr, 60_000).unref();
  setTimeout(watch, 10_000).unref();
  setInterval(watch, WATCH_INTERVAL).unref();

  createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: e.stderr?.trim() || e.message || 'Internal error' });
    }
  }).listen(PORT, () => console.log(`Homebase status server listening on :${PORT}`));
}
