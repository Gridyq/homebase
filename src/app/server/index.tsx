import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import { fetchStatus } from '@/miniapps/server/api';
import {
  Card,
  formatBytes,
  formatDuration,
  formatPercent,
  formatRate,
  levelColor,
  Meter,
  NavRow,
  Section,
  ServiceRow,
  StatTile,
  StatusColors,
} from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { usePolling } from '@/miniapps/server/use-polling';

const POLL_MS = 3000;
const HOT_CELSIUS = 80;

export default function ServerDashboard() {
  const { connection } = useServerConnection();
  const theme = useTheme();
  const gutter = useGutter();

  const header = (
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button icon="gearshape" onPress={() => router.push('/server/connect')}>
        Connection
      </Stack.Toolbar.Button>
    </Stack.Toolbar>
  );

  if (!connection) {
    return (
      <View style={[styles.empty, gutter, { backgroundColor: theme.background }]}>
        {header}
        <ThemedText type="smallBold">Not connected</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
          Run `node status-server/server.mjs pair` on the server and tap the notification, or enter the
          address and token yourself.
        </ThemedText>
        <Button title="Set up connection" onPress={() => router.push('/server/connect')} />
      </View>
    );
  }

  return (
    <>
      {header}
      <Dashboard key={`${connection.url}|${connection.token}`} />
    </>
  );
}

function Dashboard() {
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const { data, error, refresh } = usePolling(() => fetchStatus(conn), POLL_MS, conn.url);
  const [pulled, setPulled] = useState(false);

  if (!data) {
    return <Centered loading={!error} error={error} onRetry={refresh} />;
  }

  const { cpu, gpu, memory, network } = data;
  const memUsed = 1 - memory.availableBytes / memory.totalBytes;
  // The server's clock, so durations don't drift when the phone's clock is off.
  const now = data.at;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.content, gutter]}
      refreshControl={
        <RefreshControl
          refreshing={pulled}
          onRefresh={async () => {
            setPulled(true);
            await refresh();
            setPulled(false);
          }}
        />
      }>
      <View style={styles.hostLine}>
        <View style={[styles.dot, { backgroundColor: error ? theme.danger : StatusColors.good }]} />
        <ThemedText type="small" themeColor="textSecondary" style={styles.flex} numberOfLines={1}>
          {data.host.name} · up {formatDuration(data.host.uptimeSec * 1000)}
        </ThemedText>
      </View>
      {error ? (
        <ThemedText type="small" style={{ color: theme.danger }}>
          {error.message} Showing the last reading.
        </ThemedText>
      ) : null}

      <View style={styles.tiles}>
        <StatTile
          label="CPU"
          value={formatPercent(cpu.usage)}
          fraction={cpu.usage}
          caption={`Load ${cpu.load.map((l) => l.toFixed(2)).join(' ')}`}
          onPress={() => router.push('/server/processes')}
        />
        <StatTile
          label="Memory"
          value={formatPercent(memUsed)}
          fraction={memUsed}
          caption={`${formatBytes(memory.totalBytes - memory.availableBytes)} of ${formatBytes(memory.totalBytes)}`}
          onPress={() => router.push('/server/memory')}
        />
        {gpu.usage !== undefined ? (
          <StatTile label="GPU" value={formatPercent(gpu.usage)} fraction={gpu.usage} caption="Transcoding load" />
        ) : null}
        <StatTile
          label="Network"
          value={`↓ ${formatRate(network.rxPerSec)}`}
          caption={`↑ ${formatRate(network.txPerSec)}`}
          onPress={() => router.push('/server/trends')}
        />
      </View>

      {data.temperatures.length ? (
        <View style={styles.temps}>
          {data.temperatures.map((t) => (
            <View key={t.label} style={[styles.temp, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="small" themeColor="textSecondary">
                {t.label}
              </ThemedText>
              <ThemedText
                type="smallBold"
                style={{ color: t.celsius >= HOT_CELSIUS ? theme.danger : theme.text, fontVariant: ['tabular-nums'] }}>
                {Math.round(t.celsius)}°C
              </ThemedText>
            </View>
          ))}
        </View>
      ) : null}

      <Section title="Analytics">
        <Card>
          <NavRow first title="Memory" caption="What's using it, by service" onPress={() => router.push('/server/memory')} />
          <NavRow title="Processes" caption="Top programs by memory and CPU" onPress={() => router.push('/server/processes')} />
          <NavRow title="Trends" caption="CPU, memory, network and heat over the last day" onPress={() => router.push('/server/trends')} />
        </Card>
      </Section>

      <Section title="Storage">
        <Card>
          {data.disks.map((d, i) => {
            const used = d.usedBytes / d.totalBytes;
            return (
              <View key={d.mount} style={[styles.disk, i > 0 && styles.diskGap]}>
                <View style={styles.diskLine}>
                  <ThemedText type="smallBold" style={styles.flex} numberOfLines={1}>
                    {d.mount === '/' ? 'System' : d.mount}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {formatBytes(d.availableBytes)} free of {formatBytes(d.totalBytes)}
                  </ThemedText>
                </View>
                <Meter fraction={used} color={levelColor(used, theme.danger)} />
              </View>
            );
          })}
        </Card>
      </Section>

      <Section title="Services">
        <Card>
          {data.services.map((s, i) => (
            <ServiceRow
              key={s.id}
              service={s}
              now={now}
              first={i === 0}
              busy={false}
              onPress={() => router.push({ pathname: '/server/service/[id]', params: { id: s.id } })}
            />
          ))}
        </Card>
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.three,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  center: {
    textAlign: 'center',
  },
  flex: {
    flex: 1,
  },
  hostLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
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
  disk: {
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  diskGap: {
    marginTop: Spacing.one,
  },
  diskLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.two,
  },
});
