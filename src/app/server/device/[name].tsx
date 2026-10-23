import { Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Centered } from '@/components/centered';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';

import { fetchDeviceHistory } from '@/miniapps/server/api';
import { Segmented, usePullToRefresh, useSeriesColors } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { HistoryNote, RANGES, rangeName, TrendCard } from '@/miniapps/server/trends';
import { useRangedPolling } from '@/miniapps/server/use-polling';
import { formatBytes, formatRate } from '@/utils/format';

const POLL_MS = 60_000;

/** A Tailscale device's traffic with the server over time. */
export default function DeviceHistoryScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const colors = useSeriesColors();
  const { data, error, stale, refresh, range, setRange } = useRangedPolling(
    RANGES[2].value,
    (range) => fetchDeviceHistory(conn, range, name),
    POLL_MS,
    `${conn.url}|${name}`,
  );
  const refreshControl = usePullToRefresh(refresh);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.content, gutter, stale && styles.stale]}
      refreshControl={refreshControl}>
      <Stack.Screen options={{ title: name }} />
      <Segmented value={range} onChange={setRange} options={RANGES} />
      {!data ? (
        <Centered loading={!error} error={error} onRetry={refresh} />
      ) : (
        <>
          {error ? (
            <ThemedText type="small" style={{ color: theme.danger }}>
              {error.message} Showing the last reading.
            </ThemedText>
          ) : null}
          <HistoryNote history={data} />
          <TrendCard
            title="Sent to it"
            series={data.series.tx}
            history={data}
            format={formatRate}
            color={colors[1]}
            note={`${formatBytes(data.series.tx.total)} in ${rangeName(range)}`}
          />
          <TrendCard
            title="Received from it"
            series={data.series.rx}
            history={data}
            format={formatRate}
            color={colors[0]}
            note={`${formatBytes(data.series.rx.total)} in ${rangeName(range)}`}
          />
          <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
            Read once a minute from Tailscale, so short bursts are averaged out.
          </ThemedText>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.three,
  },
  stale: {
    opacity: 0.5,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
  },
});
