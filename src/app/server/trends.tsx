import { ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import { fetchHistory } from '@/miniapps/server/api';
import {
  Card,
  formatBytes,
  formatEnergy,
  formatPercent,
  formatRate,
  Section,
  Segmented,
  usePullToRefresh,
  useSeriesColors,
} from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { EventRow, useEventMarkers } from '@/miniapps/server/events';
import { HistoryNote, RANGES, rangeName, TrendCard } from '@/miniapps/server/trends';
import { useRangedPolling } from '@/miniapps/server/use-polling';

const POLL_MS = 30_000;
/** Events listed under the charts; the Reliability screen has them all. */
const EVENTS_SHOWN = 8;
const formatCelsius = (c: number) => `${Math.round(c)}°C`;
const formatWatts = (w: number) => `${Math.round(w)} W`;
const formatMhz = (mhz: number) => `${(mhz / 1000).toFixed(2)} GHz`;
const formatStall = (f: number) => `${(f * 100).toFixed(f < 0.1 ? 1 : 0)}%`;
const formatCount = (n: number) => `${n.toFixed(n % 1 ? 1 : 0)} files`;

export default function TrendsScreen() {
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const colors = useSeriesColors();
  const { data, error, stale, refresh, range, setRange } = useRangedPolling(
    RANGES[0].value,
    (range) => fetchHistory(conn, range),
    POLL_MS,
    conn.url,
  );
  const refreshControl = usePullToRefresh(refresh);
  const markers = useEventMarkers(data?.events);

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
  const has = (s: { average?: number }) => s.average !== undefined;
  const watts = (has(series.cpuPower) ? series.cpuPower.total : 0) + (has(series.gpuPower) ? series.gpuPower.total : 0);
  const recent = [...data.events].reverse().slice(0, EVENTS_SHOWN);

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

      <TrendCard title="CPU" series={series.cpu} history={data} format={formatPercent} color={colors[0]} max={1} markers={markers} />
      {has(series.cpuClock) ? (
        <TrendCard title="CPU clock" series={series.cpuClock} history={data} format={formatMhz} color={colors[2]} markers={markers} />
      ) : null}
      <TrendCard
        title="Memory in use"
        series={series.memory}
        history={data}
        format={formatBytes}
        color={colors[0]}
        max={data.memoryTotalBytes}
        markers={markers}
      />
      <TrendCard
        title="File cache"
        series={series.cache}
        history={data}
        format={formatBytes}
        color={colors[2]}
        max={data.memoryTotalBytes}
        markers={markers}
      />
      {series.swap.peak ? (
        <TrendCard title="Swap in use" series={series.swap} history={data} format={formatBytes} color={colors[1]} markers={markers} />
      ) : null}
      <TrendCard
        title="Download"
        series={series.rx}
        history={data}
        format={formatRate}
        color={colors[0]}
        markers={markers}
        note={`${formatBytes(series.rx.total)} in ${rangeName(range)}`}
      />
      <TrendCard
        title="Upload"
        series={series.tx}
        history={data}
        format={formatRate}
        color={colors[1]}
        markers={markers}
        note={`${formatBytes(series.tx.total)} in ${rangeName(range)}`}
      />
      {has(series.gpu) ? (
        <TrendCard title="GPU" series={series.gpu} history={data} format={formatPercent} color={colors[0]} max={1} markers={markers} />
      ) : null}
      {series.converting?.peak ? (
        <TrendCard
          title="Conversions"
          series={series.converting}
          history={data}
          format={formatCount}
          color={colors[2]}
          markers={markers}
        />
      ) : null}
      {has(series.temp) ? (
        <TrendCard
          title="CPU temperature"
          series={series.temp}
          history={data}
          format={formatCelsius}
          color={colors[1]}
          max={100}
          markers={markers}
        />
      ) : null}
      {has(series.cpuPower) ? (
        <TrendCard title="CPU power" series={series.cpuPower} history={data} format={formatWatts} color={colors[1]} markers={markers} />
      ) : null}
      {has(series.gpuPower) ? (
        <TrendCard
          title="Graphics card power"
          series={series.gpuPower}
          history={data}
          format={formatWatts}
          color={colors[1]}
          markers={markers}
          note={watts ? `CPU and graphics card used ${formatEnergy(watts)} in ${rangeName(range)}` : undefined}
        />
      ) : null}

      {has(series.pressureCpu) ? (
        <Section title="Slowdowns">
          <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
            How much of the time something had to wait: for a turn on the CPU, for memory to be freed,
            or for a drive. Busy is fine; waiting is what makes things feel slow.
          </ThemedText>
          <TrendCard title="Waiting for CPU" series={series.pressureCpu} history={data} format={formatStall} color={colors[0]} markers={markers} />
          <TrendCard title="Waiting for memory" series={series.pressureMemory} history={data} format={formatStall} color={colors[1]} markers={markers} />
          <TrendCard title="Waiting for drives" series={series.pressureIo} history={data} format={formatStall} color={colors[2]} markers={markers} />
        </Section>
      ) : null}

      {recent.length ? (
        <Section title="What happened">
          <Card>
            {recent.map((e, i) => (
              <EventRow key={`${e.t}-${i}`} event={e} first={i === 0} />
            ))}
          </Card>
        </Section>
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
  note: {
    fontSize: 13,
    lineHeight: 18,
  },
});
