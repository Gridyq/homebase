import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type GestureResponderEvent } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';

import type { Service } from './api';

export const StatusColors = {
  good: '#30A46C',
  warn: '#F5A524',
  idle: '#8B8D98',
} as const;

/** Chart colors, in a fixed order that stays distinguishable with color blindness. */
const SeriesColors = {
  light: ['#2a78d6', '#eb6834', '#1baf7a'],
  dark: ['#3987e5', '#d95926', '#199e70'],
} as const;

export function useSeriesColors() {
  return SeriesColors[useColorScheme() === 'dark' ? 'dark' : 'light'];
}

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
  onPress,
}: {
  label: string;
  value: string;
  caption?: string;
  /** Draws a meter when given. */
  fraction?: number;
  onPress?: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.tile, { backgroundColor: theme.backgroundElement, opacity: pressed ? 0.6 : 1 }]}>
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
    </Pressable>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <ThemedText style={styles.sectionTitle}>{title}</ThemedText>
      {children}
    </View>
  );
}

/** A row in a card that leads to another screen. */
export function NavRow({
  title,
  caption,
  first,
  onPress,
}: {
  title: string;
  caption?: string;
  first?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.serviceRow,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
        { opacity: pressed ? 0.6 : 1 },
      ]}>
      <View style={styles.serviceText}>
        <ThemedText type="smallBold">{title}</ThemedText>
        {caption ? (
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.caption}>
            {caption}
          </ThemedText>
        ) : null}
      </View>
      <ThemedText themeColor="textSecondary" style={styles.chevron}>
        ›
      </ThemedText>
    </Pressable>
  );
}

/** A row of pill buttons for picking one option. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.segmented, { backgroundColor: theme.backgroundElement }]}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => onChange(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={[styles.segment, selected && { backgroundColor: theme.backgroundSelected }]}>
            <ThemedText type={selected ? 'smallBold' : 'small'} themeColor={selected ? 'text' : 'textSecondary'}>
              {o.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

/** One bar split into parts, with a 2px gap between them. The track shows what's left. */
export function StackedBar({ parts, total }: { parts: { value: number; color: string }[]; total: number }) {
  const theme = useTheme();
  return (
    <View style={[styles.stack, { backgroundColor: theme.backgroundSelected }]}>
      {parts.map((p, i) => (
        <View
          key={i}
          style={{
            width: `${(Math.max(0, p.value) / total) * 100}%`,
            backgroundColor: p.color,
            borderRightWidth: 2,
            borderRightColor: theme.backgroundElement,
          }}
        />
      ))}
    </View>
  );
}

export function LegendItem({ color, label, value }: { color?: string; label: string; value: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.swatch, { backgroundColor: color ?? 'transparent' }]} />
      <ThemedText type="small" themeColor="textSecondary" style={styles.flex} numberOfLines={1}>
        {label}
      </ThemedText>
      <ThemedText type="smallBold" style={styles.tabular}>
        {value}
      </ThemedText>
    </View>
  );
}

/**
 * Values over time, drawn as thin columns with a line along their tops. Touching the chart shows
 * the reading under the finger. `max` fixes the top of the scale, such as 1 for a percentage;
 * otherwise it fits the highest value.
 */
export function TimeChart({
  values,
  start,
  end,
  format,
  color,
  max,
  height = 110,
}: {
  values: (number | null)[];
  start: number;
  end: number;
  format: (value: number) => string;
  color: string;
  max?: number;
  height?: number;
}) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const [touched, setTouched] = useState<number>();
  const highest = Math.max(0, ...values.map((v) => v ?? 0));
  const top = max ?? (highest || 1);
  const step = (end - start) / values.length;

  const touch = (e: GestureResponderEvent) => {
    if (!width) return;
    const i = Math.floor((e.nativeEvent.locationX / width) * values.length);
    setTouched(Math.min(values.length - 1, Math.max(0, i)));
  };
  const touchedValue = touched !== undefined ? values[touched] : undefined;

  return (
    <View style={styles.chart}>
      <View style={styles.chartLabels}>
        <ThemedText type="small" themeColor="textSecondary" style={[styles.caption, styles.flex]} numberOfLines={1}>
          {touched !== undefined
            ? `${formatTime(start + step * touched)}–${formatTime(start + step * (touched + 1))}`
            : `Scale ${format(top)}`}
        </ThemedText>
        {touched !== undefined ? (
          <ThemedText type="smallBold" style={styles.tabular}>
            {touchedValue == null ? 'No reading' : format(touchedValue)}
          </ThemedText>
        ) : null}
      </View>
      <View
        style={[styles.plot, { height, borderBottomColor: theme.backgroundSelected }]}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onResponderGrant={touch}
        onResponderMove={touch}
        onResponderRelease={() => setTouched(undefined)}
        onResponderTerminate={() => setTouched(undefined)}>
        <View style={[styles.gridLine, { top: '50%', backgroundColor: theme.backgroundSelected }]} />
        {values.map((v, i) => {
          const fraction = v == null ? 0 : Math.min(1, Math.max(0, v / top));
          const active = touched === i;
          return (
            <View key={i} style={styles.column}>
              {v != null ? (
                <View
                  style={{
                    height: `${fraction * 100}%`,
                    minHeight: 2,
                    backgroundColor: active ? color : `${color}40`,
                    borderTopWidth: 2,
                    borderTopColor: color,
                  }}
                />
              ) : null}
            </View>
          );
        })}
      </View>
      <View style={styles.chartLabels}>
        <ThemedText type="small" themeColor="textSecondary" style={[styles.caption, styles.flex]}>
          {formatTime(start)}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
          Now
        </ThemedText>
      </View>
    </View>
  );
}

export function serviceColor(service: Service, danger: string) {
  if (service.state === 'failed' || service.health === 'unhealthy') return danger;
  if (service.state === 'changing' || service.health === 'starting') return StatusColors.warn;
  if (service.state === 'running') return StatusColors.good;
  return StatusColors.idle;
}

export function serviceSummary(service: Service, now: number) {
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
      ) : service.usage ? (
        <View style={styles.usage}>
          <ThemedText type="smallBold" style={styles.tabular}>
            {formatBytes(service.usage.usedBytes)}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={[styles.caption, styles.tabular]}>
            {formatCpu(service.usage.cpu)} CPU
          </ThemedText>
        </View>
      ) : null}
      {onPress ? (
        <ThemedText themeColor="textSecondary" style={styles.chevron}>
          ›
        </ThemedText>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  tabular: {
    fontVariant: ['tabular-nums'],
  },
  section: {
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  sectionTitle: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: 700,
  },
  segmented: {
    flexDirection: 'row',
    borderRadius: 10,
    padding: Spacing.half,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.one + Spacing.half,
    borderRadius: 8,
  },
  stack: {
    flexDirection: 'row',
    height: 14,
    borderRadius: 4,
    overflow: 'hidden',
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  swatch: {
    width: 10,
    height: 10,
    borderRadius: 3,
  },
  chart: {
    gap: Spacing.one,
  },
  chartLabels: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.two,
  },
  plot: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  gridLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
  },
  column: {
    flex: 1,
    height: '100%',
    justifyContent: 'flex-end',
  },
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
  usage: {
    alignItems: 'flex-end',
    gap: Spacing.half,
  },
  chevron: {
    fontSize: 22,
    lineHeight: 24,
  },
});
