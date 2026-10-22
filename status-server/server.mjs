#!/usr/bin/env node
/**
 * Status server for Homebase's Server mini-app: system stats, services and containers, and
 * start/stop/restart for them. Also watches for problems and reports them through ntfy, since
 * the app can't get push notifications. No dependencies beyond Node.js.
 *
 * Every request needs `Authorization: Bearer <token>`. The token lives in `token` next to this
 * file and is created on first start. `node server.mjs pair` sends a link to the phone through
 * ntfy that fills in the app's connection settings.
 */
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readdir, readFile, statfs, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.join(ROOT, 'token');
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

async function memory() {
  const info = Object.fromEntries(
    (await readFile('/proc/meminfo', 'utf8'))
      .split('\n')
      .map((l) => /^(\w+):\s+(\d+)/.exec(l))
      .filter(Boolean)
      .map(([, k, v]) => [k, Number(v) * 1024]),
  );
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

async function containers() {
  const { stdout } = await run('podman', ['ps', '--all', '--format', 'json']);
  return JSON.parse(stdout || '[]');
}

/** Everything the dashboard lists, with what each one can do. */
async function services() {
  const pods = await containers().catch((e) => {
    console.error('podman ps failed:', e.message);
    return [];
  });
  const quadletUnits = pods.map((p) => p.Labels?.PODMAN_SYSTEMD_UNIT).filter(Boolean);
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
  return list;
}

async function performAction(id, action) {
  const [kind, name] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (kind === 'container') {
    const pod = (await containers()).find((p) => p.Names?.includes(name));
    if (!pod) throw new HttpError(404, `No container named ${name}`);
    if (!['start', 'stop', 'restart'].includes(action)) throw new HttpError(400, `Can't ${action} a container`);
    // Quadlet containers go through systemd, which would otherwise restart or fight a direct
    // podman command.
    const unit = pod.Labels?.PODMAN_SYSTEMD_UNIT;
    if (unit) await run('systemctl', ['--user', action, unit], { timeout: 120_000 });
    else await run('podman', [action, name], { timeout: 120_000 });
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
    at: Date.now(),
  };
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
  if (url.pathname === '/health') return sendJson(res, 200, { ok: true });
  if (!authorized(req, await getToken())) return sendJson(res, 401, { error: 'Wrong or missing token' });

  if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, 200, await status());

  const match = /^\/api\/services\/([^/]+)\/(start|stop|restart|run)$/.exec(url.pathname);
  if (req.method === 'POST' && match) {
    const id = decodeURIComponent(match[1]);
    log(req, `${match[2]} ${id}`);
    await performAction(id, match[2]);
    return sendJson(res, 200, { ok: true });
  }
  sendJson(res, 404, { error: 'Not found' });
}

async function pair() {
  const link = `homebase://server/connect?${new URLSearchParams({ url: PUBLIC_URL, token: await getToken() })}`;
  console.log(`Pairing link: ${link}`);
  const res = await fetch(NTFY_URL, {
    method: 'POST',
    headers: { Title: 'Connect Homebase to this server', Tags: 'link', Click: link },
    body: 'Tap to fill in the Server mini-app settings.',
  }).catch((e) => ({ ok: false, statusText: e.message }));
  console.log(res.ok ? 'Sent through ntfy.' : `Couldn't send through ntfy: ${res.statusText}`);
}

if (process.argv[2] === 'pair') {
  await pair();
} else {
  await getToken();
  await sample();
  setInterval(sample, 2000).unref();
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
