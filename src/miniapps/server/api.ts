import { errorText } from '@/utils/error-text';

/** Talks to the status server (`status-server-rs/`) on the home server. */

export type Connection = {
  url: string;
  token: string;
};

export const DEFAULT_URL = 'http://fedora.tail27f991.ts.net:8788';

const TAILNET_DOMAIN = '.tail27f991.ts.net';

/**
 * Whether a URL's server is on the tailnet: one of its MagicDNS names, or a Tailscale address.
 * Anyone who can post to ntfy can make a pairing link, so a link naming any other server is ignored.
 */
export function isTailnetUrl(url: string): boolean {
  const match = /^https?:\/\/([^/?#@]+)(?:[/?#]|$)/i.exec(url.trim());
  if (!match) return false;
  const authority = match[1].toLowerCase();
  const host = authority.startsWith('[')
    ? authority.slice(1, authority.indexOf(']'))
    : authority.replace(/:\d+$/, '');
  if (host.endsWith(TAILNET_DOMAIN) && host.length > TAILNET_DOMAIN.length) return true;
  const v4 = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4) return Number(v4[1]) >= 64 && Number(v4[1]) <= 127;
  return host.startsWith('fd7a:115c:a1e0:');
}

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

/** Something Jellyfin is playing, as the server reads it from Jellyfin's sessions. */
export type Stream = {
  id: string;
  user: string;
  /** The app, such as "Jellyfin Roku". */
  client?: string;
  device?: string;
  /** The episode's or the movie's. */
  title: string;
  /** Jellyfin's item type: Episode, Movie… */
  kind: string;
  show?: string;
  /** "S1E2". */
  episode?: string;
  year?: number;
  paused: boolean;
  positionMs?: number;
  runtimeMs?: number;
  /** Played as it is, repackaged, or re-encoded on the server. */
  method: 'direct' | 'stream' | 'transcode';
  transcode?: {
    /** Whether the video (the expensive part) or just the audio is re-encoded. */
    video: boolean;
    audio: boolean;
    videoCodec?: string;
    audioCodec?: string;
    container?: string;
    /** "vaapi" when the graphics card does it. */
    hardware?: string;
    bitrate?: number;
    fps?: number;
    progress?: number;
    /** Why, in words: "video codec not supported". */
    reasons: string[];
  };
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
  /** Missing from servers older than 2026-10-23. */
  streams?: Stream[];
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
 * server knows: 'you' from the app, 'game mode', 'on demand' (the assistant's models), or 'update'
 * (restarted on a new image).
 */
export type ServerEvent = {
  t: number;
  kind: 'boot' | 'started' | 'stopped' | 'restarted' | 'crashed' | 'failed' | 'oom' | 'game' | 'problem' | 'resolved';
  id?: string;
  name?: string;
  by?: 'you' | 'game mode' | 'on demand' | 'update';
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

/** What the server refused, with its HTTP status; none when it couldn't be reached at all. */
export class ServerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function unreachable(conn: Connection, reason: string) {
  return new ServerError(`Can't reach ${conn.url} (${reason}). Is Tailscale connected?`);
}

/** The error for a response that wasn't ok, from its status and JSON body. */
export function refused(status: number, body: { error?: string } | undefined) {
  if (status === 401) {
    return new ServerError('The server rejected the token. Pair again under Connection (the gear button).', 401);
  }
  return new ServerError(body?.error ?? `The server answered ${status}.`, status);
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
    throw unreachable(conn, controller.signal.aborted ? 'timed out' : errorText(e));
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw refused(res.status, body);
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

/** One build of a container's image. */
export type ImageBuild = {
  id: string;
  /** From the image's version label, when it has a real one. */
  version?: string;
  /** When the image was built. */
  created?: number;
};

export type ContainerUpdateInfo = {
  id: string;
  name: string;
  image: string;
  running: boolean;
  current: ImageBuild;
  /** The build before the last update, which it can go back to. */
  previous: ImageBuild | null;
  /** The registry has a newer build, as of the last check. */
  available: boolean;
  /** Skipped by the nightly run. */
  held: { at: number; reason: string } | null;
  /** Pulled, but Jellyfin restarts once nobody's watching. */
  waiting: boolean;
  changelog: string | null;
};

export type ContainerChange = {
  at: number;
  name: string;
  from: ImageBuild;
  to: ImageBuild;
  /** `rolledBack`: the new build didn't start, so it went back by itself. `reverted`: gone back from the app. */
  outcome: 'updated' | 'rolledBack' | 'reverted';
  detail?: string;
};

export type ContainerUpdates = {
  running: { what: string; step: string; since: number } | null;
  lastRun: number | null;
  checkedAt: number | null;
  /** The nightly run starts after this hour, server time. */
  runHour: number;
  gameMode: boolean;
  errors: string[];
  containers: ContainerUpdateInfo[];
  history: ContainerChange[];
};

export function fetchContainerUpdates(conn: Connection) {
  return request<ContainerUpdates>(conn, '/api/container-updates');
}

/** Checks, updates and going back run on the server; the answer comes as they start. */
export function changeContainerUpdates(
  conn: Connection,
  body: { check: true } | { update: true; name?: string } | { revert: string } | { hold: string; held: boolean },
) {
  return request<ContainerUpdates>(conn, '/api/container-updates', { method: 'POST', body: JSON.stringify(body) });
}
