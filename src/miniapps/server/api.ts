/** Talks to the status server (`status-server-rs/`) on the home server. */

export type Connection = {
  url: string;
  token: string;
};

export const DEFAULT_URL = 'http://fedora.tail27f991.ts.net:8788';

export type ServiceState = 'running' | 'stopped' | 'failed' | 'changing';
export type ServiceAction = 'start' | 'stop' | 'restart' | 'run';

/** What a service or cgroup is using right now. */
export type Usage = {
  /** Memory its programs hold, which can't be freed without stopping them. */
  usedBytes: number;
  /** File data cached on its behalf; the kernel takes it back when something needs room. */
  cacheBytes: number;
  /** Share of the whole machine's CPU, 0–1; missing until there are two readings. */
  cpu?: number;
  readPerSec?: number;
  writePerSec?: number;
};

export type Service = {
  id: string;
  name: string;
  kind: 'container' | 'service' | 'timer';
  /** Image for a container, or why a service failed. */
  detail?: string;
  state: ServiceState;
  health?: 'healthy' | 'unhealthy' | 'starting';
  /** When it started, or for a stopped container, when it stopped (ms). */
  since?: number;
  lastRun?: number;
  nextRun?: number;
  /** Times systemd restarted it after it crashed, since the unit was loaded. */
  restarts?: number;
  actions: ServiceAction[];
  /** Missing for stopped services and timers that aren't running. */
  usage?: Usage;
};

export type Disk = {
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
};

/** Game mode stops the download stack while a game runs, or while switched on from the app. */
export type GameMode = {
  on: boolean;
  /** Switched from the app rather than following games. */
  manual: boolean;
  /** The game running, or the last one, until its grace period ends. */
  game?: string;
  since?: number;
  /** When it turns off by itself, once the game has closed. */
  endsAt?: number;
  /** Ids of the services it stops. */
  services: string[];
};

export type Status = {
  host: { name: string; uptimeSec: number; kernel: string };
  /** Usage is 0–1, or missing for the first couple of seconds after the server starts. */
  cpu: { usage?: number; load: [number, number, number]; cores: number };
  gpu: { usage?: number };
  memory: { totalBytes: number; availableBytes: number; swapTotalBytes: number; swapFreeBytes: number };
  network: { rxPerSec?: number; txPerSec?: number };
  temperatures: { label: string; celsius: number }[];
  disks: Disk[];
  services: Service[];
  gameMode: GameMode;
  at: number;
};

export type MemoryBreakdown = {
  totalBytes: number;
  availableBytes: number;
  /** Memory programs asked for, including shared memory. */
  appsBytes: number;
  /** File cache, given back when needed. */
  cacheBytes: number;
  kernelBytes: number;
  freeBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
};

export type GroupCategory = 'container' | 'homebase' | 'system' | 'desktop' | 'login';

/** A systemd unit or container's cgroup. */
export type Group = Usage & {
  id: string;
  name: string;
  category: GroupCategory;
  /** The dashboard service it belongs to, if any. */
  serviceId?: string;
};

export type UsageReport = {
  memory: MemoryBreakdown;
  /** Share of the last minute something waited on CPU, memory or disk, 0–1. */
  pressure: { cpu?: number; memory?: number; io?: number };
  groups: Group[];
  at: number;
};

export type ProcessInfo = {
  pid: number;
  name: string;
  command: string;
  /** Name of the service or cgroup it runs in. */
  service?: string;
  rssBytes: number;
  /** Share of the whole machine's CPU since the previous call; missing on the first. */
  cpu?: number;
};

export type ProcessReport = { processes: ProcessInfo[]; count: number; at: number };

export type GpuEngine = {
  /** The kernel's name: gfx, compute, dec, enc, jpeg, dma… */
  id: string;
  label: string;
  /** Share of the engine's time since the previous call, 0–1. */
  usage: number;
};

/** A program with the graphics card open. */
export type GpuClient = {
  pid: number;
  name: string;
  service?: string;
  vramBytes: number;
  /** System memory the card has mapped for it. */
  gttBytes: number;
  /** Missing on the server's first call, before there's anything to compare with. */
  engines?: GpuEngine[];
};

export type GpuReport = {
  name: string;
  driver?: string;
  /** 0–1, as the driver reports it. */
  usage?: number;
  memoryControllerUsage?: number;
  vram?: { totalBytes: number; usedBytes: number };
  /** System memory the card can borrow. */
  gtt?: { totalBytes: number; usedBytes: number };
  temperatures: { label: string; celsius: number; criticalCelsius?: number }[];
  clocks: { label: string; mhz: number; maxMhz?: number }[];
  power?: { watts: number; capWatts?: number };
  fan?: { rpm: number; maxRpm?: number };
  voltageMv?: number;
  /** PCIe link speed per lane in GT/s, and lanes. */
  link?: { gts: number; width: number; maxGts: number; maxWidth: number };
  /** Added up from every program; missing on the server's first call. */
  engines?: GpuEngine[];
  clients: GpuClient[];
  at: number;
};

export type Series = {
  /** Evenly spaced averages from `start` to `end`; null where the server has no readings. */
  values: (number | null)[];
  average?: number;
  peak?: number;
  /** Value × seconds over the range: bytes for a rate, joules for watts. */
  total: number;
};

export type SystemSeries =
  | 'cpu'
  | 'gpu'
  | 'memory'
  | 'cache'
  | 'swap'
  | 'rx'
  | 'tx'
  | 'temp'
  | 'gpuTemp'
  | 'gpuPower'
  | 'vram'
  | 'cpuPower'
  | 'cpuClock'
  | 'pressureCpu'
  | 'pressureMemory'
  | 'pressureIo'
  | 'converting';
export type ServiceSeries = 'memory' | 'cpu' | 'read' | 'write' | 'rx' | 'tx';
export type DriveSeries = 'read' | 'write' | 'busy' | 'temp';
export type DeviceSeries = 'rx' | 'tx';

/**
 * Something that happened on the server. `by` says who stopped or started a service when the
 * server knows: 'you' from the app, 'game mode', or 'on demand' (Seerr and the assistant's models).
 */
export type ServerEvent = {
  t: number;
  kind: 'boot' | 'started' | 'stopped' | 'restarted' | 'crashed' | 'failed' | 'oom' | 'game' | 'problem' | 'resolved';
  id?: string;
  name?: string;
  by?: 'you' | 'game mode' | 'on demand';
  detail?: string;
  /** For game mode. */
  on?: boolean;
  /** For a drive's problem. */
  drive?: string;
};

export type History<K extends string> = {
  start: number;
  end: number;
  step: number;
  series: Record<K, Series>;
  /** What happened in the range that bears on these series. */
  events: ServerEvent[];
  /** Time of the oldest reading the server has. */
  oldest?: number;
  memoryTotalBytes: number;
};

const TIMEOUT_MS = 8000;

/** Add http:// when missing and drop a trailing slash. */
export function normalizeUrl(input: string) {
  let url = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url;
}

/** Calls the status server. Also used by the Requests mini-app, whose calls go through it. */
export async function request<T>(
  conn: Connection,
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const { timeoutMs = TIMEOUT_MS, ...rest } = init ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${conn.url}${path}`, {
      ...rest,
      headers: { Authorization: `Bearer ${conn.token}`, ...(rest.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: controller.signal,
    });
  } catch (e) {
    const reason = controller.signal.aborted ? 'timed out' : e instanceof Error ? e.message : String(e);
    throw new Error(`Can't reach ${conn.url} (${reason}). Is Tailscale connected?`);
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    if (res.status === 401) throw new Error('The server rejected the token. Pair again under Connection (the gear button).');
    throw new Error(body?.error ?? `The server answered ${res.status}.`);
  }
  return body as T;
}

/** Trades the one-time code from a pairing link for the server's token. */
export async function redeemPairingCode(url: string, code: string) {
  const { token } = await request<{ token: string }>({ url, token: '' }, '/api/pair', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  return token;
}

export function fetchStatus(conn: Connection) {
  return request<Status>(conn, '/api/status');
}

/** The server answers once the service has stopped or started, which can take a while. */
export function runAction(conn: Connection, id: string, action: ServiceAction) {
  return request<{ ok: true }>(conn, `/api/services/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    timeoutMs: 130_000,
  });
}

export function fetchGameMode(conn: Connection) {
  return request<GameMode>(conn, '/api/game-mode');
}

/** Waits for the services to stop or start, which can take a while. */
export function setGameMode(conn: Connection, on: boolean) {
  return request<GameMode>(conn, '/api/game-mode', { method: 'POST', body: JSON.stringify({ on }), timeoutMs: 200_000 });
}

export function fetchUsage(conn: Connection) {
  return request<UsageReport>(conn, '/api/usage');
}

export function fetchProcesses(conn: Connection) {
  return request<ProcessReport>(conn, '/api/processes');
}

export function fetchGpu(conn: Connection) {
  return request<GpuReport>(conn, '/api/gpu');
}

export function fetchHistory(conn: Connection, rangeSec: number) {
  return request<History<SystemSeries>>(conn, `/api/history?range=${rangeSec}`);
}

export function fetchServiceHistory(conn: Connection, rangeSec: number, serviceId: string) {
  return request<History<ServiceSeries>>(
    conn,
    `/api/history?range=${rangeSec}&service=${encodeURIComponent(serviceId)}`,
  );
}

export function fetchDriveHistory(conn: Connection, rangeSec: number, driveId: string) {
  return request<History<DriveSeries>>(conn, `/api/history?range=${rangeSec}&drive=${encodeURIComponent(driveId)}`);
}

export function fetchDeviceHistory(conn: Connection, rangeSec: number, device: string) {
  return request<History<DeviceSeries>>(conn, `/api/history?range=${rangeSec}&device=${encodeURIComponent(device)}`);
}

export type DriveIssue = { level: 'warning' | 'failing'; text: string };

/** From the drive's SMART data, which udisks reads every 10 minutes. Fields a drive doesn't report are missing. */
export type DriveSmart = {
  updated?: number;
  powerOnHours?: number;
  /** Share of its rated life left, for SSDs. */
  lifeLeft?: number;
  readBytes?: number;
  writtenBytes?: number;
  powerCycles?: number;
  selfTest?: string;
  // SATA
  failing?: boolean;
  badSectors?: number;
  reallocated?: number;
  pending?: number;
  uncorrectable?: number;
  /** Data garbled between drive and board, usually a loose or bad cable. Counts up for life. */
  cableErrors?: number;
  /** Times a hard drive parked its heads. */
  loadCycles?: number;
  // NVMe
  spare?: number;
  spareThreshold?: number;
  mediaErrors?: number;
  unsafeShutdowns?: number;
  /** Minutes spent above its warning temperature. */
  hotMinutes?: number;
  warnings?: string[];
};

export type Drive = {
  /** Serial number. */
  id: string;
  model: string;
  kind: 'nvme' | 'ssd' | 'hdd';
  rpm?: number;
  sizeBytes: number;
  /** Kernel name, such as sda. */
  device?: string;
  mounts: string[];
  temperature?: number;
  smart?: DriveSmart;
  health: 'good' | 'warning' | 'failing' | 'unknown';
  issues: DriveIssue[];
  activity?: { readPerSec: number; writePerSec: number; busy: number };
  /** Who's reading and writing it right now, busiest first. */
  users: { id?: string; name: string; readPerSec: number; writePerSec: number }[];
};

export type DriveReport = { drives: Drive[]; error?: string; at: number };

export function fetchDrives(conn: Connection) {
  return request<DriveReport>(conn, '/api/drives', { timeoutMs: 15_000 });
}

export type CpuReport = {
  model?: string;
  usage?: number;
  load: number[];
  /** Each logical core (two per physical core with SMT). */
  cores: { usage?: number; mhz?: number }[];
  maxMhz?: number;
  temperature?: number;
  watts?: number;
  /** Why the power draw can't be read: the counter needs a udev rule, or isn't there. */
  powerError?: 'permission' | 'missing';
  /** Share of the last 10 seconds something waited on CPU, memory or disk. */
  pressure: { cpu?: number; memory?: number; io?: number };
  governor?: string;
  preference?: string;
  at: number;
};

export function fetchCpu(conn: Connection) {
  return request<CpuReport>(conn, '/api/cpu');
}

export type PowerSettings = {
  pricePerKwh?: number;
  currency: string;
  /** Estimate for what isn't measured: drives, board, fans, power supply losses. */
  otherWatts: number;
  cpuWatts?: number;
  cpuPowerError?: 'permission' | 'missing';
};

export function fetchPower(conn: Connection) {
  return request<PowerSettings>(conn, '/api/power');
}

/** A null price clears it. */
export function savePower(conn: Connection, settings: { pricePerKwh?: number | null; currency?: string; otherWatts?: number }) {
  return request<PowerSettings>(conn, '/api/power', { method: 'POST', body: JSON.stringify(settings) });
}

export type NetworkUser = {
  id: string;
  /** Containers that share one network, counted together. */
  ids: string[];
  name: string;
  rxPerSec?: number;
  txPerSec?: number;
  rxBytes: number;
  txBytes: number;
};

/** A Tailscale device. rx is what the server got from it, tx what it sent it. */
export type NetworkDevice = {
  name: string;
  os?: string;
  online: boolean;
  rxPerSec?: number;
  txPerSec?: number;
  rxBytes: number;
  txBytes: number;
};

export type NetworkReport = {
  start: number;
  end: number;
  oldest?: number;
  rxPerSec?: number;
  txPerSec?: number;
  rxBytes: number;
  txBytes: number;
  services: NetworkUser[];
  devices: NetworkDevice[];
  at: number;
};

export function fetchNetwork(conn: Connection, rangeSec: number) {
  return request<NetworkReport>(conn, `/api/network?range=${rangeSec}`);
}

export type ServiceReliability = {
  id: string;
  name: string;
  /** Stopped unexpectedly and restarted by systemd. */
  crashes: number;
  /** Stopped unexpectedly and stayed down. */
  failures: number;
  oomKills: number;
  /** Restarted by something other than systemd's crash handling. */
  restarts: number;
  /** Stopped without the server knowing why. */
  stops: number;
  /** Share of the range it was running, of the time the server was keeping history. */
  running?: number;
  lastTrouble?: number;
};

export type ReliabilityReport = {
  start: number;
  end: number;
  oldest?: number;
  boots: number[];
  services: ServiceReliability[];
  /** Newest first. */
  events: ServerEvent[];
  at: number;
};

export function fetchReliability(conn: Connection, rangeSec: number) {
  return request<ReliabilityReport>(conn, `/api/reliability?range=${rangeSec}`);
}

export type LogLine = {
  at: number;
  /** syslog priority: 3 and below are errors, 4 warnings. */
  priority: number;
  text: string;
};

export type LogReport = {
  lines: LogLine[];
  /** Pass back as `after` to get only what's written since. */
  cursor?: string;
  at: number;
};

/** A service's last few hundred lines, or with `after` only the new ones. `errors` keeps lines that mention a problem. */
export function fetchServiceLogs(conn: Connection, id: string, { after, errors }: { after?: string; errors?: boolean } = {}) {
  const query = [after && `after=${encodeURIComponent(after)}`, errors && 'errors=1'].filter(Boolean).join('&');
  return request<LogReport>(conn, `/api/services/${encodeURIComponent(id)}/logs${query ? `?${query}` : ''}`, {
    timeoutMs: 20_000,
  });
}

export type TailscaleDevice = {
  id: string;
  name: string;
  os: string;
  ips: string[];
  /** This server. */
  self: boolean;
  online: boolean;
  /** Traffic in the last couple of minutes. */
  active: boolean;
  lastSeen?: number;
  /** The address it's reached at directly; missing while traffic goes through a relay. */
  direct?: string;
  relay?: string;
  /** Since Tailscale last started on the server. */
  rxBytes: number;
  txBytes: number;
  keyExpiry?: number;
  exitNode: boolean;
  offersExitNode: boolean;
};

export type TailscaleReport = {
  state: string;
  version?: string;
  tailnet?: string;
  health: string[];
  /** The server first. */
  devices: TailscaleDevice[];
  at: number;
};

export function fetchTailscale(conn: Connection) {
  return request<TailscaleReport>(conn, '/api/tailscale');
}

export type StorageCategory = {
  id: string;
  label: string;
  bytes: number;
  /** The biggest folders in it. */
  items: { name: string; bytes: number }[];
  /** How many smaller ones were left out. */
  more: number;
};

export type StorageReport = {
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  categories: StorageCategory[];
  /** Downloads hardlinked into the library, which take no extra room. */
  sharedDownloadBytes: number;
  at: number;
};

export function fetchStorage(conn: Connection) {
  return request<StorageReport>(conn, '/api/storage', { timeoutMs: 130_000 });
}
