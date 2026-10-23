import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { formatWhen } from '@/utils/format';

import type { History, Series } from './api';
import { Card, TimeChart, type ChartMarker } from './components';

const DAY = 24 * 3600;

/** The server keeps 15-second readings for a day and coarser averages for up to a year. */
export const RANGES = [
  { value: 3600, label: '1h' },
  { value: 6 * 3600, label: '6h' },
  { value: DAY, label: '24h' },
  { value: 7 * DAY, label: '7d' },
  { value: 30 * DAY, label: '30d' },
  { value: 365 * DAY, label: '1y' },
];

/** For totals: a day and longer only. */
export const LONG_RANGES = RANGES.slice(2);

/** "the last 24 hours", "the last 7 days". */
export function rangeName(rangeSec: number) {
  if (rangeSec < DAY) return `the last ${rangeSec / 3600} hours`.replace('last 1 hours', 'last hour');
  if (rangeSec === DAY) return 'the last 24 hours';
  if (rangeSec >= 365 * DAY) return 'the last year';
  return `the last ${rangeSec / DAY} days`;
}

/**
 * A card with a chart of one series, its average and peak, and how to read it. Memoized: screens
 * poll other things every few seconds, but the history only changes every 30. Pass a `format`
 * that keeps its identity, or it redraws anyway.
 */
export const TrendCard = memo(function TrendCard({
  title,
  series,
  history,
  format,
  color,
  max,
  markers,
  note,
}: {
  title: string;
  series: Series;
  history: History<string>;
  format: (value: number) => string;
  color: string;
  max?: number;
  markers?: ChartMarker[];
  /** A line under the chart, such as a total. */
  note?: string;
}) {
  return (
    <Card>
      <View style={styles.body}>
        <View style={styles.header}>
          <ThemedText type="smallBold" style={styles.flex}>
            {title}
          </ThemedText>
          {series.average !== undefined ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.tabular}>
              avg {format(series.average)} · peak {format(series.peak ?? 0)}
            </ThemedText>
          ) : null}
        </View>
        {series.average === undefined ? (
          <ThemedText type="small" themeColor="textSecondary">
            No readings yet.
          </ThemedText>
        ) : (
          <TimeChart
            values={series.values}
            start={history.start}
            end={history.end}
            format={format}
            color={color}
            max={max}
            markers={markers}
          />
        )}
        {note && series.average !== undefined ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
            {note}
          </ThemedText>
        ) : null}
      </View>
    </Card>
  );
});

/** How to read the charts, and when the history starts if that's later than the range shown. */
export function HistoryNote({ history }: { history: History<string> }) {
  const partial = history.oldest && history.oldest > history.start;
  return (
    <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
      {partial ? `The server has been keeping history since ${formatWhen(history.oldest!)}. ` : ''}
      Touch and hold a chart to read it{history.events.length ? '; a line marks something that happened, like a reboot' : ''}.
    </ThemedText>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.two,
  },
  flex: {
    flex: 1,
  },
  tabular: {
    fontVariant: ['tabular-nums'],
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
  },
});
