import { Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Centered } from '@/components/centered';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';

import { fetchDriveHistory } from '@/miniapps/server/api';
import { Segmented, usePullToRefresh, useSeriesColors } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { useEventMarkers } from '@/miniapps/server/events';
import { HistoryNote, RANGES, rangeName, TrendCard } from '@/miniapps/server/trends';
import { useRangedPolling } from '@/miniapps/server/use-polling';
import { formatBytes, formatPercent } from '@/utils/format';

const POLL_MS = 30_000;
const formatSpeed = (bytesPerSec: number) => `${formatBytes(bytesPerSec)}/s`;
const formatCelsius = (c: number) => `${Math.round(c)}°C`;

/** One drive's traffic, busy time and temperature over time. */
export default function DriveHistoryScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const colors = useSeriesColors();
  const { data, error, stale, refresh, range, setRange } = useRangedPolling(
    RANGES[2].value,
    (range) => fetchDriveHistory(conn, range, id),
    POLL_MS,
    `${conn.url}|${id}`,
  );
  const refreshControl = usePullToRefresh(refresh);
  const markers = useEventMarkers(data?.events);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.content, gutter, stale && styles.stale]}
      refreshControl={refreshControl}>
      <Stack.Screen options={{ title: name ?? 'Drive' }} />
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
            title="Busy"
            series={data.series.busy}
            history={data}
            format={formatPercent}
            color={colors[0]}
            max={1}
            markers={markers}
          />
          <TrendCard
            title="Read"
            series={data.series.read}
            history={data}
            format={formatSpeed}
            color={colors[0]}
            markers={markers}
            note={`${formatBytes(data.series.read.total)} in ${rangeName(range)}`}
          />
          <TrendCard
            title="Write"
            series={data.series.write}
            history={data}
            format={formatSpeed}
            color={colors[1]}
            markers={markers}
            note={`${formatBytes(data.series.write.total)} in ${rangeName(range)}`}
          />
          <TrendCard
            title="Temperature"
            series={data.series.temp}
            history={data}
            format={formatCelsius}
            color={colors[1]}
            markers={markers}
          />
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
});
