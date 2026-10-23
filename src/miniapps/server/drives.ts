import type { Drive } from './api';
import { StatusColors } from './components';

/** "System drive" for the one holding /, "Media drive" for /mnt/media, else its model. */
export function driveName(d: Drive) {
  if (d.mounts.includes('/')) return 'System drive';
  if (d.mounts.includes('/mnt/media')) return 'Media drive';
  return d.model;
}

export function driveKindLabel(d: Drive) {
  if (d.kind === 'nvme') return 'NVMe SSD';
  if (d.kind === 'ssd') return 'SATA SSD';
  return d.rpm ? `Hard drive, ${d.rpm} rpm` : 'Hard drive';
}

export function driveHealthLabel(health: Drive['health']) {
  return { good: 'Healthy', warning: 'Needs attention', failing: 'Failing', unknown: 'No health data' }[health];
}

export function driveHealthColor(health: Drive['health'], danger: string) {
  return { good: StatusColors.good, warning: StatusColors.warn, failing: danger, unknown: StatusColors.idle }[health];
}

/** "6.8 years", "5 months", "12 days". */
export function formatPowerOn(hours: number) {
  const days = hours / 24;
  if (days >= 365) return `${(days / 365).toFixed(1)} years`;
  if (days >= 60) return `${Math.round(days / 30)} months`;
  return `${Math.round(days)} days`;
}
