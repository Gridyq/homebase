import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Centered } from '@/components/centered';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';

import { fetchCpu, type CpuReport } from '@/miniapps/server/api';
import { Card, levelColor, Meter, NavRow, Section, StatTile, StatusColors, usePullToRefresh } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { usePolling } from '@/miniapps/server/use-polling';
import { formatPercent } from '@/utils/format';

const POLL_MS = 2000;
/** Above this, with the CPU busy and its clocks well down, heat is likely what's holding it back. */
const HOT_CELSIUS = 85;
const formatGhz = (mhz: number | undefined) => (mhz === undefined ? '–' : `${(mhz / 1000).toFixed(2)} GHz`);

/** Each core's load and clock, the CPU's power draw, and what's waiting on it. */
export default function CpuScreen() {
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const { data, error, refresh } = usePolling(() => fetchCpu(conn), POLL_MS, conn.url);
  const refreshControl = usePullToRefresh(refresh);

  if (!data) return <Centered loading={!error} error={error} onRetry={refresh} />;

  const clocks = data.cores.map((c) => c.mhz).filter((m): m is number => m !== undefined);
  const averageMhz = clocks.length ? clocks.reduce((a, b) => a + b, 0) / clocks.length : undefined;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.content, gutter]}
      refreshControl={refreshControl}>
      <ThemedText type="small" themeColor="textSecondary">
        {[data.model, `${data.cores.length} threads`, data.governor && `${data.governor} mode`].filter(Boolean).join(' · ')}
      </ThemedText>
      {error ? (
        <ThemedText type="small" style={{ color: theme.danger }}>
          {error.message} Showing the last reading.
        </ThemedText>
      ) : null}

      <View style={styles.tiles}>
        <StatTile
          label="Load"
          value={formatPercent(data.usage)}
          fraction={data.usage}
          caption={`Average ${data.load.map((l) => l.toFixed(2)).join(' ')}`}
        />
        <StatTile label="Clock" value={formatGhz(averageMhz)} caption={data.maxMhz ? `Up to ${formatGhz(data.maxMhz)}` : undefined} />
        <StatTile
          label="Temperature"
          value={data.temperature === undefined ? '–' : `${Math.round(data.temperature)}°C`}
          caption="Hottest point (Tctl)"
        />
        <StatTile
          label="Power"
          value={data.watts === undefined ? '–' : `${Math.round(data.watts)} W`}
          caption={data.watts === undefined ? 'Not set up' : 'CPU package'}
          onPress={() => router.push('/server/power')}
        />
      </View>

      <HeatNote data={data} averageMhz={averageMhz} />

      <Section title="Threads">
        <Card>
          <View style={styles.cores}>
            {data.cores.map((c, i) => (
              <View key={i} style={styles.core}>
                <View style={styles.line}>
                  <ThemedText type="small" themeColor="textSecondary" style={styles.flex}>
                    {i}
                  </ThemedText>
                  <ThemedText type="small" style={styles.tabular}>
                    {formatPercent(c.usage)}
                  </ThemedText>
                </View>
                <Meter fraction={c.usage} color={levelColor(c.usage, theme.danger)} />
                <ThemedText type="small" themeColor="textSecondary" style={[styles.caption, styles.tabular]}>
                  {formatGhz(c.mhz)}
                </ThemedText>
              </View>
            ))}
          </View>
        </Card>
      </Section>

      <Section title="Waiting">
        <View style={styles.tiles}>
          <StatTile label="For CPU" value={formatPercent(data.pressure.cpu)} caption="last 10 seconds" />
          <StatTile label="For memory" value={formatPercent(data.pressure.memory)} caption="last 10 seconds" />
          <StatTile label="For drives" value={formatPercent(data.pressure.io)} caption="last 10 seconds" />
        </View>
        <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
          The share of time at least one program had to wait. A busy CPU is fine; waiting is what
          makes things feel slow.
        </ThemedText>
      </Section>

      <Card>
        <NavRow first title="Trends" caption="Load, clock, temperature and power over time" onPress={() => router.push('/server/trends')} />
        <NavRow title="Processes" caption="What's using the CPU" onPress={() => router.push('/server/processes')} />
      </Card>
    </ScrollView>
  );
}

/** Ryzen chips don't report throttling, so this reads it from the clocks, the load and the heat. */
function HeatNote({ data, averageMhz }: { data: CpuReport; averageMhz?: number }) {
  if (data.temperature === undefined || data.temperature < HOT_CELSIUS) return null;
  const slowed = data.maxMhz && averageMhz && (data.usage ?? 0) > 0.7 && averageMhz < data.maxMhz * 0.8;
  return (
    <ThemedText type="small" style={{ color: StatusColors.warn }}>
      {slowed
        ? `The CPU is hot and running at ${Math.round((averageMhz! / data.maxMhz!) * 100)}% of its top clock under load, so heat is likely holding it back.`
        : 'The CPU is running hot. It slows itself down if it gets hotter.'}
    </ThemedText>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.three,
  },
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  cores: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: Spacing.three,
    columnGap: Spacing.three,
    paddingVertical: Spacing.two,
  },
  core: {
    width: '29%',
    flexGrow: 1,
    gap: Spacing.one,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  flex: {
    flex: 1,
  },
  tabular: {
    fontVariant: ['tabular-nums'],
  },
  caption: {
    fontSize: 13,
    lineHeight: 18,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
  },
});
