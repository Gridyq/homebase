import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import { fetchGpu, fetchHistory, type GpuClient, type GpuReport } from '@/miniapps/server/api';
import {
  Card,
  formatBytes,
  formatCpu,
  formatPercent,
  levelColor,
  Meter,
  Section,
  Segmented,
  StatTile,
  StatusColors,
  useSeriesColors,
} from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { HistoryNote, RANGES, TrendCard } from '@/miniapps/server/trends';
import { usePolling } from '@/miniapps/server/use-polling';

const POLL_MS = 3000;
const HISTORY_POLL_MS = 30_000;
/** Show a temperature in amber this close to the card's limit, and red closer still. */
const TEMP_WARN_MARGIN = 20;
const TEMP_HOT_MARGIN = 10;

/** PCIe generation from the per-lane rate. */
const PCIE_GEN: Record<number, string> = { 2.5: '1.0', 5: '2.0', 8: '3.0', 16: '4.0', 32: '5.0', 64: '6.0' };

function formatLink(gts: number, width: number) {
  return `PCIe ${PCIE_GEN[gts] ?? `${gts} GT/s`} ×${width}`;
}

export default function GpuScreen() {
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const colors = useSeriesColors();
  const { data, error, refresh } = usePolling(() => fetchGpu(conn), POLL_MS, conn.url);
  const [range, setRange] = useState(RANGES[0].value);
  const history = usePolling(() => fetchHistory(conn, range), HISTORY_POLL_MS, `${conn.url}|${range}`);

  if (!data) return <Centered loading={!error} error={error} onRetry={refresh} />;

  const { vram, gtt, power, fan, link } = data;
  const vramUsed = vram && vram.usedBytes / vram.totalBytes;
  const powerUsed = power?.capWatts ? power.watts / power.capWatts : undefined;
  const fanUsed = fan?.maxRpm ? fan.rpm / fan.maxRpm : undefined;
  const engines = [
    ...(data.engines ?? []),
    ...(data.memoryControllerUsage !== undefined
      ? [{ id: 'mem', label: 'Memory controller', usage: data.memoryControllerUsage }]
      : []),
  ];

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.content, gutter]}>
      {error ? (
        <ThemedText type="small" style={{ color: theme.danger }}>
          {error.message} Showing the last reading.
        </ThemedText>
      ) : null}

      <View>
        <ThemedText type="smallBold">{data.name}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {[
            data.driver,
            link && formatLink(link.gts, link.width),
            link && (link.gts < link.maxGts || link.width < link.maxWidth)
              ? `can run at ${formatLink(link.maxGts, link.maxWidth)}`
              : undefined,
          ]
            .filter(Boolean)
            .join(' · ')}
        </ThemedText>
      </View>

      <View style={styles.tiles}>
        <StatTile label="Usage" value={formatPercent(data.usage)} fraction={data.usage} caption="Busy share of time" />
        {vram ? (
          <StatTile
            label="Video memory"
            value={formatPercent(vramUsed)}
            fraction={vramUsed}
            caption={`${formatBytes(vram.usedBytes)} of ${formatBytes(vram.totalBytes)}`}
          />
        ) : null}
        {power ? (
          <StatTile
            label="Power"
            value={`${Math.round(power.watts)} W`}
            fraction={powerUsed}
            caption={power.capWatts ? `Limit ${Math.round(power.capWatts)} W` : undefined}
          />
        ) : null}
        {fan ? (
          <StatTile
            label="Fan"
            value={fan.rpm ? `${fan.rpm} rpm` : 'Off'}
            fraction={fanUsed}
            caption={fan.rpm ? (fan.maxRpm ? `Max ${fan.maxRpm} rpm` : undefined) : 'Stops when cool'}
          />
        ) : null}
      </View>

      {engines.length ? (
        <Section title="Engines">
          <Card>
            {engines.map((e, i) => (
              <View key={e.id} style={[styles.meterRow, i > 0 && styles.rowGap]}>
                <View style={styles.line}>
                  <ThemedText type="smallBold" style={styles.flex}>
                    {e.label}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary" style={styles.tabular}>
                    {formatCpu(e.usage)}
                  </ThemedText>
                </View>
                <Meter fraction={e.usage} color={levelColor(e.usage, theme.danger)} />
              </View>
            ))}
          </Card>
          <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
            Video decode and encode are the parts Jellyfin uses to transcode. Engine shares are added up
            from the programs below, so they only count programs the status server can see.
          </ThemedText>
        </Section>
      ) : null}

      {data.temperatures.length ? (
        <Section title="Temperatures">
          <View style={styles.temps}>
            {data.temperatures.map((t) => {
              const margin = t.criticalCelsius !== undefined ? t.criticalCelsius - t.celsius : Infinity;
              const color =
                margin <= TEMP_HOT_MARGIN ? theme.danger : margin <= TEMP_WARN_MARGIN ? StatusColors.warn : theme.text;
              return (
                <View key={t.label} style={[styles.temp, { backgroundColor: theme.backgroundElement }]}>
                  <ThemedText type="small" themeColor="textSecondary">
                    {t.label}
                  </ThemedText>
                  <ThemedText type="smallBold" style={[styles.tabular, { color }]}>
                    {Math.round(t.celsius)}°C
                  </ThemedText>
                  {t.criticalCelsius !== undefined ? (
                    <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
                      limit {Math.round(t.criticalCelsius)}°C
                    </ThemedText>
                  ) : null}
                </View>
              );
            })}
          </View>
        </Section>
      ) : null}

      <Clocks data={data} />

      {data.clients.length ? (
        <Section title="Programs">
          <Card>
            {data.clients.map((c, i) => (
              <ClientRow key={c.pid} client={c} first={i === 0} />
            ))}
          </Card>
          {gtt ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
              Sorted by video memory. Shared is system memory the card borrows: {formatBytes(gtt.usedBytes)} of{' '}
              {formatBytes(gtt.totalBytes)} in use.
            </ThemedText>
          ) : null}
        </Section>
      ) : null}

      <Section title="Trends">
        <Segmented value={range} onChange={setRange} options={RANGES} />
        {history.data ? (
          <>
            <HistoryNote history={history.data} />
            <TrendCard
              title="Usage"
              series={history.data.series.gpu}
              history={history.data}
              format={formatPercent}
              color={colors[0]}
              max={1}
            />
            {vram ? (
              <TrendCard
                title="Video memory"
                series={history.data.series.vram}
                history={history.data}
                format={formatBytes}
                color={colors[2]}
                max={vram?.totalBytes}
              />
            ) : null}
            {data.temperatures.length ? (
              <TrendCard
                title="Hotspot temperature"
                series={history.data.series.gpuTemp}
                history={history.data}
                format={(c) => `${Math.round(c)}°C`}
                color={colors[1]}
                max={110}
              />
            ) : null}
            {power ? (
              <TrendCard
                title="Power"
                series={history.data.series.gpuPower}
                history={history.data}
                format={(w) => `${Math.round(w)} W`}
                color={colors[1]}
                max={power?.capWatts}
              />
            ) : null}
          </>
        ) : (
          <Centered loading={!history.error} error={history.error} onRetry={history.refresh} />
        )}
      </Section>
    </ScrollView>
  );
}

function Clocks({ data }: { data: GpuReport }) {
  const theme = useTheme();
  const colors = useSeriesColors();
  if (!data.clocks.length && data.voltageMv === undefined) return null;
  return (
    <Section title="Clocks">
      <Card>
        {data.clocks.map((c, i) => (
          <View key={c.label} style={[styles.meterRow, i > 0 && styles.rowGap]}>
            <View style={styles.line}>
              <ThemedText type="smallBold" style={styles.flex}>
                {c.label}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.tabular}>
                {c.mhz} MHz{c.maxMhz ? ` of ${c.maxMhz}` : ''}
              </ThemedText>
            </View>
            {c.maxMhz ? <Meter fraction={c.mhz / c.maxMhz} color={colors[0]} /> : null}
          </View>
        ))}
        {data.voltageMv !== undefined ? (
          <View
            style={[
              styles.line,
              styles.meterRow,
              data.clocks.length > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
            ]}>
            <ThemedText type="smallBold" style={styles.flex}>
              Core voltage
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.tabular}>
              {(data.voltageMv / 1000).toFixed(3)} V
            </ThemedText>
          </View>
        ) : null}
      </Card>
      <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
        The card drops its clocks to almost nothing when idle and raises them as work arrives.
      </ThemedText>
    </Section>
  );
}

function ClientRow({ client: c, first }: { client: GpuClient; first: boolean }) {
  const theme = useTheme();
  const busiest = [...(c.engines ?? [])].sort((a, b) => b.usage - a.usage)[0];
  return (
    <View
      style={[
        styles.clientRow,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
      ]}>
      <View style={styles.flex}>
        <ThemedText type="smallBold" numberOfLines={1}>
          {c.name}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.caption}>
          {[c.service, `PID ${c.pid}`].filter(Boolean).join(' · ')}
        </ThemedText>
      </View>
      <View style={styles.values}>
        <ThemedText type="smallBold" style={styles.tabular}>
          {formatBytes(c.vramBytes)}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={[styles.caption, styles.tabular]}>
          {busiest && busiest.usage > 0
            ? `${busiest.label} ${formatCpu(busiest.usage)}`
            : `${formatBytes(c.gttBytes)} shared`}
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.three,
  },
  flex: {
    flex: 1,
  },
  tabular: {
    fontVariant: ['tabular-nums'],
  },
  caption: {
    fontSize: 13,
    lineHeight: 17,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
  },
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.two,
  },
  meterRow: {
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  rowGap: {
    marginTop: Spacing.one,
  },
  temps: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  temp: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: Spacing.two,
    alignItems: 'center',
  },
  clientRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two + Spacing.one,
  },
  values: {
    alignItems: 'flex-end',
  },
});
