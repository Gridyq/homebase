import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatWhen } from '@/utils/format';

import type { ServerEvent } from './api';
import { StatusColors, type ChartMarker } from './components';

const BY: Record<NonNullable<ServerEvent['by']>, string> = {
  you: 'by you',
  'game mode': 'by game mode',
  'on demand': 'on demand',
  update: 'by an update',
};

/** "jellyfin crashed", "Game mode on (Starsector)", with `name` left out when the screen is already about it. */
export function eventText(e: ServerEvent, { withName = true } = {}) {
  const who = withName && e.name ? `${e.name} ` : '';
  const by = e.by ? ` ${BY[e.by]}` : '';
  switch (e.kind) {
    case 'boot':
      return 'Server started up';
    case 'game':
      return `Game mode ${e.on ? 'on' : 'off'}${e.detail ? ` (${e.detail})` : ''}`;
    case 'crashed':
      return `${who}crashed and was restarted`.trimStart();
    case 'failed':
      return `${who}failed${e.detail ? ` (${e.detail})` : ''}`.trimStart();
    case 'oom':
      return `${who}killed for memory`.trimStart();
    case 'started':
      return `${who}started${by}`.trimStart();
    case 'stopped':
      return `${who}stopped${by || ' (unexpected)'}`.trimStart();
    case 'restarted':
      return `${who}restarted${by}`.trimStart();
    case 'problem':
      return e.detail ?? 'Problem';
    case 'resolved':
      return `Resolved: ${e.detail ?? ''}`;
  }
}

/** Upper-case first letter, for a line of its own. */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function eventColor(e: ServerEvent, danger: string, accent: string) {
  if (e.kind === 'crashed' || e.kind === 'failed' || e.kind === 'oom' || e.kind === 'problem') return danger;
  if (e.kind === 'stopped' && !e.by) return StatusColors.warn;
  if (e.kind === 'resolved') return StatusColors.good;
  if (e.kind === 'game') return accent;
  return StatusColors.idle;
}

/** The events worth a line on a chart: trouble, reboots and game mode, or everything for one service. */
export function useEventMarkers(events: ServerEvent[] | undefined, { all = false } = {}): ChartMarker[] {
  const { danger, accent } = useTheme();
  // Kept between renders so the memoized trend cards don't redraw.
  return useMemo(
    () =>
      (events ?? [])
        .filter((e) => all || ['boot', 'crashed', 'failed', 'oom', 'game'].includes(e.kind))
        .map((e) => ({ t: e.t, color: eventColor(e, danger, accent), label: sentence(eventText(e, { withName: !all })) })),
    [events, all, danger, accent],
  );
}

export function EventRow({ event, first, withName = true }: { event: ServerEvent; first?: boolean; withName?: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
      ]}>
      <View style={[styles.dot, { backgroundColor: eventColor(event, theme.danger, theme.accent) }]} />
      <View style={styles.flex}>
        <ThemedText type="small">{sentence(eventText(event, { withName }))}</ThemedText>
        {event.kind === 'oom' && event.detail ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
            {event.detail}
          </ThemedText>
        ) : null}
      </View>
      <ThemedText type="small" themeColor="textSecondary" style={[styles.caption, styles.time]}>
        {formatWhen(event.t)}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  flex: {
    flex: 1,
  },
  caption: {
    fontSize: 13,
    lineHeight: 18,
  },
  time: {
    fontVariant: ['tabular-nums'],
  },
});
