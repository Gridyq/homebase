/** Talks to `status-server/server.mjs` on the home server. */

export type Connection = {
  url: string;
  token: string;
};

export const DEFAULT_URL = 'http://fedora.tail27f991.ts.net:8788';

export type ServiceState = 'running' | 'stopped' | 'failed' | 'changing';
export type ServiceAction = 'start' | 'stop' | 'restart' | 'run';

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
  actions: ServiceAction[];
};

export type Disk = {
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
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
  at: number;
};

const TIMEOUT_MS = 8000;

/** Add http:// when missing and drop a trailing slash. */
export function normalizeUrl(input: string) {
  let url = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url;
}

async function request<T>(conn: Connection, path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${conn.url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${conn.token}` },
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
    if (res.status === 401) throw new Error('The server rejected the token. Check it in Settings.');
    throw new Error(body?.error ?? `The server answered ${res.status}.`);
  }
  return body as T;
}

export function fetchStatus(conn: Connection) {
  return request<Status>(conn, '/api/status');
}

export function runAction(conn: Connection, id: string, action: ServiceAction) {
  return request<{ ok: true }>(conn, `/api/services/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
}
