import { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import { fetchHistory } from '@/miniapps/server/api';
import {
  formatBytes,
  formatPercent,
  formatRate,
  Segmented,
  usePullToRefresh,
  useSeriesColors,
} from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { HistoryNote, RANGES, TrendCard } from '@/miniapps/server/trends';
import { usePolling } from '@/miniapps/server/use-polling';

const POLL_MS = 30_000;
const formatCelsius = (c: number) => `${Math.round(c)}°C`;

export default function TrendsScreen() {
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const colors = useSeriesColors();
  const [range, setRange] = useState(RANGES[0].value);
  const { data, error, stale, refresh } = usePolling(() => fetchHistory(conn, range), POLL_MS, `${conn.url}|${range}`, {
    keepPrevious: true,
  });
  const refreshControl = usePullToRefresh(refresh);

  const picker = <Segmented value={range} onChange={setRange} options={RANGES} />;

  if (!data) {
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={[styles.content, gutter]}>
        {picker}
        <Centered loading={!error} error={error} onRetry={refresh} />
      </ScrollView>
    );
  }

  const { series } = data;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.content, gutter, stale && styles.stale]}
      refreshControl={refreshControl}>
      {picker}
      {error ? (
        <ThemedText type="small" style={{ color: theme.danger }}>
          {error.message} Showing the last reading.
        </ThemedText>
      ) : null}
      <HistoryNote history={data} />

      <TrendCard title="CPU" series={series.cpu} history={data} format={formatPercent} color={colors[0]} max={1} />
      <TrendCard
        title="Memory in use"
        series={series.memory}
        history={data}
        format={formatBytes}
        color={colors[0]}
        max={data.memoryTotalBytes}
      />
      <TrendCard
        title="File cache"
        series={series.cache}
        history={data}
        format={formatBytes}
        color={colors[2]}
        max={data.memoryTotalBytes}
      />
      {series.swap.peak ? (
        <TrendCard title="Swap in use" series={series.swap} history={data} format={formatBytes} color={colors[1]} />
      ) : null}
      <TrendCard title="Download" series={series.rx} history={data} format={formatRate} color={colors[0]} />
      <TrendCard title="Upload" series={series.tx} history={data} format={formatRate} color={colors[1]} />
      {series.gpu.average !== undefined ? (
        <TrendCard title="GPU" series={series.gpu} history={data} format={formatPercent} color={colors[0]} max={1} />
      ) : null}
      {series.temp.average !== undefined ? (
        <TrendCard
          title="CPU temperature"
          series={series.temp}
          history={data}
          format={formatCelsius}
          color={colors[1]}
          max={100}
        />
      ) : null}
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
