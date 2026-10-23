/** How numbers, sizes and times read on screen. */

export function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatRate(bytesPerSec: number | undefined) {
  if (bytesPerSec === undefined) return '–';
  // Network speeds read more naturally in bits.
  const bits = bytesPerSec * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)} Gb/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`;
  return `${Math.round(bits / 1e3)} kb/s`;
}

export function formatPercent(fraction: number | undefined) {
  return fraction === undefined ? '–' : `${Math.round(fraction * 100)}%`;
}

/** CPU share with a decimal below 10%, since most services idle well under 1%. */
export function formatCpu(fraction: number | undefined) {
  if (fraction === undefined) return '–';
  const pct = fraction * 100;
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return `${pct.toFixed(1)}%`;
}

/** "3d 4h", "4h 12m", "12m". */
export function formatDuration(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** "4:31 AM" today, "Tomorrow 4:39 AM", or "Oct 20, 4:31 AM". */
export function formatWhen(ms: number) {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((startOfDay(date) - startOfDay(new Date())) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

export function formatTime(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** A point on a chart spanning `span` ms: the time for a day or less, the date and hour for a few weeks, the date beyond. */
export function formatChartTime(ms: number, span: number) {
  const date = new Date(ms);
  if (span <= 36 * 3600_000) return formatTime(ms);
  if (span <= 45 * 86_400_000) {
    return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${date.toLocaleTimeString(undefined, { hour: 'numeric' })}`;
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "350 Wh", "12.4 kWh", from joules. */
export function formatEnergy(joules: number) {
  const wh = joules / 3600;
  return wh >= 1000 ? `${(wh / 1000).toFixed(wh >= 100_000 ? 0 : 1)} kWh` : `${Math.round(wh)} Wh`;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
