import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import type { Service } from './api';

export const StatusColors = {
  good: '#30A46C',
  warn: '#F5A524',
  idle: '#8B8D98',
} as const;

// ---------------------------------------------------------------------------------------------
// Formatting

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

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Green below 70%, amber below 90%, red above. */
export function levelColor(fraction: number | undefined, danger: string) {
  if (fraction === undefined) return StatusColors.idle;
  return fraction >= 0.9 ? danger : fraction >= 0.7 ? StatusColors.warn : StatusColors.good;
}

// ---------------------------------------------------------------------------------------------
// Pieces

export function Card({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>{children}</View>;
}

export function Meter({ fraction, color }: { fraction: number | undefined; color: string }) {
  const theme = useTheme();
  const width = `${Math.min(100, Math.max(0, (fraction ?? 0) * 100))}%` as const;
  return (
    <View style={[styles.track, { backgroundColor: theme.backgroundSelected }]}>
      <View style={[styles.fill, { width, backgroundColor: color }]} />
    </View>
  );
}

export function StatTile({
  label,
  value,
  caption,
  fraction,
}: {
  label: string;
  value: string;
  caption?: string;
  /** Draws a meter when given. */
  fraction?: number;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.tile, { backgroundColor: theme.backgroundElement }]}>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </ThemedText>
      {fraction !== undefined ? <Meter fraction={fraction} color={levelColor(fraction, theme.danger)} /> : null}
      {caption ? (
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.caption}>
          {caption}
        </ThemedText>
      ) : null}
    </View>
  );
}

function serviceColor(service: Service, danger: string) {
  if (service.state === 'failed' || service.health === 'unhealthy') return danger;
  if (service.state === 'changing' || service.health === 'starting') return StatusColors.warn;
  if (service.state === 'running') return StatusColors.good;
  return StatusColors.idle;
}

function serviceSummary(service: Service, now: number) {
  if (service.kind === 'timer') {
    if (service.state === 'changing') return 'Running now';
    const parts = [];
    if (service.lastRun) parts.push(`Last ${formatWhen(service.lastRun)}`);
    if (service.nextRun) parts.push(`next ${formatWhen(service.nextRun)}`);
    return [service.detail, parts.join(', ')].filter(Boolean).join(' · ');
  }
  const state =
    service.state === 'running'
      ? service.since
        ? `Up ${formatDuration(now - service.since)}`
        : 'Running'
      : service.state === 'failed'
        ? 'Failed'
        : service.state === 'changing'
          ? 'Starting or stopping'
          : service.since && service.kind === 'container'
            ? `Stopped ${formatDuration(now - service.since)} ago`
            : 'Stopped';
  const health = service.health === 'unhealthy' ? 'unhealthy' : undefined;
  return [state, health, service.detail].filter(Boolean).join(' · ');
}

export function ServiceRow({
  service,
  now,
  busy,
  first,
  onPress,
}: {
  service: Service;
  now: number;
  busy: boolean;
  first: boolean;
  onPress?: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress || busy}
      style={({ pressed }) => [
        styles.serviceRow,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
        { opacity: pressed ? 0.6 : 1 },
      ]}>
      <View style={[styles.dot, { backgroundColor: serviceColor(service, theme.danger) }]} />
      <View style={styles.serviceText}>
        <ThemedText type="smallBold" numberOfLines={1}>
          {service.name}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.caption}>
          {serviceSummary(service, now)}
        </ThemedText>
      </View>
      {busy ? (
        <ActivityIndicator />
      ) : onPress ? (
        <ThemedText themeColor="textSecondary" style={styles.more}>
          •••
        </ThemedText>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  track: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 3,
  },
  tile: {
    flexGrow: 1,
    flexBasis: '40%',
    borderRadius: 14,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  tileValue: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: 700,
    fontVariant: ['tabular-nums'],
  },
  caption: {
    fontSize: 13,
    lineHeight: 17,
  },
  serviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two + Spacing.one,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  serviceText: {
    flex: 1,
    gap: Spacing.half,
  },
  more: {
    fontSize: 13,
    letterSpacing: 1,
  },
});
