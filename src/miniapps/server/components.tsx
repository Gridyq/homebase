import { memo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, View, type GestureResponderEvent } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';
import { formatBytes, formatCpu, formatDuration, formatWhen, formatChartTime } from '@/utils/format';

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

/** What a disk is called on screen: the root filesystem is the system disk. */
export const diskName = (mount: string) => (mount === '/' ? 'System' : mount);

/**
 * What a polled list shows besides its rows: a spinner before the first answer, the error with
 * a way to try again when there's nothing to show, or a note that what's shown is old.
 */
export function PollStatus({ error, loaded, onRetry }: { error?: Error; loaded: boolean; onRetry: () => void }) {
  const theme = useTheme();
  if (!loaded && !error) return <ActivityIndicator style={styles.pollSpinner} />;
  if (!error) return null;
  if (loaded) {
    return (
      <ThemedText type="small" style={{ color: theme.danger }}>
        {error.message} Showing the last list.
      </ThemedText>
    );
  }
  return (
    <ThemedText themeColor="textSecondary">
      {error.message}{' '}
      <ThemedText style={{ color: theme.accent }} onPress={onRetry}>
        Try again
      </ThemedText>
    </ThemedText>
  );
}

/** Pull-to-refresh that spins until every load it starts has finished. */
export function usePullToRefresh(...refreshes: (() => Promise<unknown>)[]) {
  const [pulled, setPulled] = useState(false);
  return (
    <RefreshControl
      refreshing={pulled}
      onRefresh={async () => {
        setPulled(true);
        await Promise.allSettled(refreshes.map((r) => r()));
        setPulled(false);
      }}
    />
  );
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

/** A moment marked on a chart, such as a crash or a reboot. */
export type ChartMarker = { t: number; color: string; label: string };

/**
 * Values over time, drawn as thin columns with a line along their tops. Touching the chart shows
 * the reading under the finger, and what's marked in that column. `max` fixes the top of the
 * scale, such as 1 for a percentage; otherwise it fits the highest value. `label` names a column
 * when it isn't a span of clock time, with `startLabel` and `endLabel` under the ends.
 */
export function TimeChart({
  values,
  start,
  end,
  format,
  color,
  max,
  height = 110,
  label,
  startLabel,
  endLabel = 'Now',
  markers,
}: {
  values: (number | null)[];
  start: number;
  end: number;
  format: (value: number) => string;
  color: string;
  max?: number;
  height?: number;
  label?: (index: number) => string;
  startLabel?: string;
  endLabel?: string;
  markers?: ChartMarker[];
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
  const span = end - start;
  const marked = markers?.filter((m) => m.t >= start && m.t <= end) ?? [];
  const touchedMarks =
    touched !== undefined ? marked.filter((m) => Math.min(values.length - 1, Math.floor((m.t - start) / step)) === touched) : [];

  return (
    <View style={styles.chart}>
      <View style={styles.chartLabels}>
        <ThemedText type="small" themeColor="textSecondary" style={[styles.caption, styles.flex]} numberOfLines={1}>
          {touched !== undefined
            ? label
              ? label(touched)
              : `${formatChartTime(start + step * touched, span)}–${formatChartTime(start + step * (touched + 1), span)}`
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
        {marked.map((m, i) => (
          <View
            key={`m${i}`}
            pointerEvents="none"
            style={[styles.marker, { left: `${((m.t - start) / span) * 100}%`, backgroundColor: m.color }]}
          />
        ))}
        <ChartColumns values={values} top={top} color={color} />
        {touchedValue != null ? (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              bottom: 0,
              left: `${(touched! / values.length) * 100}%`,
              width: `${100 / values.length}%`,
              height: `${Math.min(1, Math.max(0, touchedValue / top)) * 100}%`,
              minHeight: 2,
              backgroundColor: color,
            }}
          />
        ) : null}
      </View>
      {touchedMarks.length ? (
        <ThemedText type="small" style={[styles.caption, { color: touchedMarks[0].color }]} numberOfLines={2}>
          {touchedMarks.map((m) => m.label).join(' · ')}
        </ThemedText>
      ) : null}
      <View style={styles.chartLabels}>
        <ThemedText type="small" themeColor="textSecondary" style={[styles.caption, styles.flex]}>
          {startLabel ?? formatChartTime(start, span)}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
          {endLabel}
        </ThemedText>
      </View>
    </View>
  );
}

/**
 * The bars, apart from the touched one, which is drawn over them: a finger dragging across a chart
 * then redraws one bar rather than all of them (and Trends has a dozen charts).
 */
const ChartColumns = memo(function ChartColumns({ values, top, color }: { values: (number | null)[]; top: number; color: string }) {
  return values.map((v, i) => (
    <View key={i} style={styles.column}>
      {v != null ? (
        <View
          style={{
            height: `${Math.min(1, Math.max(0, v / top)) * 100}%`,
            minHeight: 2,
            backgroundColor: `${color}40`,
            borderTopWidth: 2,
            borderTopColor: color,
          }}
        />
      ) : null}
    </View>
  ));
});

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
  pollSpinner: {
    paddingVertical: Spacing.two,
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
  marker: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1.5,
    opacity: 0.7,
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
