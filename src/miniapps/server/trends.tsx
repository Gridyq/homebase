import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

import type { History, Series } from './api';
import { Card, formatWhen, TimeChart } from './components';

export const RANGES = [
  { value: 3600, label: '1 hour' },
  { value: 6 * 3600, label: '6 hours' },
  { value: 24 * 3600, label: '24 hours' },
];

/** A card with a chart of one series, its average and peak, and how to read it. */
export function TrendCard({
  title,
  series,
  history,
  format,
  color,
  max,
}: {
  title: string;
  series: Series;
  history: History<string>;
  format: (value: number) => string;
  color: string;
  max?: number;
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
          />
        )}
      </View>
    </Card>
  );
}

/** How to read the charts, and when the history starts if that's later than the range shown. */
export function HistoryNote({ history }: { history: History<string> }) {
  const partial = history.oldest && history.oldest > history.start;
  return (
    <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
      {partial ? `The server has been keeping history since ${formatWhen(history.oldest!)}. ` : ''}
      Touch and hold a chart to read it.
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
