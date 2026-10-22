import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { ActionSheetIOS, Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import { fetchStatus, runAction, type Service, type ServiceAction } from '@/miniapps/server/api';
import {
  Card,
  formatBytes,
  formatDuration,
  formatPercent,
  formatRate,
  levelColor,
  Meter,
  ServiceRow,
  StatTile,
  StatusColors,
} from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { usePolling } from '@/miniapps/server/use-polling';

const POLL_MS = 3000;
const HOT_CELSIUS = 80;

const ACTION_LABELS: Record<ServiceAction, string> = {
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
  run: 'Run now',
};

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
  const [busy, setBusy] = useState<string>();
  const [pulled, setPulled] = useState(false);

  if (!data) {
    return <Centered loading={!error} error={error} onRetry={refresh} />;
  }

  const act = async (service: Service, action: ServiceAction) => {
    setBusy(service.id);
    try {
      await runAction(conn, service.id, action);
    } catch (e) {
      Alert.alert(`Couldn't ${ACTION_LABELS[action].toLowerCase()} ${service.name}`, e instanceof Error ? e.message : String(e));
    }
    await refresh();
    setBusy(undefined);
  };

  const showActions = (service: Service) => {
    const options = service.actions.map((a) => ACTION_LABELS[a]);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: service.name,
        options: [...options, 'Cancel'],
        cancelButtonIndex: options.length,
        destructiveButtonIndex: service.actions.flatMap((a, i) => (a === 'stop' ? [i] : [])),
      },
      (index) => {
        const action = service.actions[index];
        if (action) act(service, action);
      },
    );
  };

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
        />
        <StatTile
          label="Memory"
          value={formatPercent(memUsed)}
          fraction={memUsed}
          caption={`${formatBytes(memory.totalBytes - memory.availableBytes)} of ${formatBytes(memory.totalBytes)}`}
        />
        {gpu.usage !== undefined ? (
          <StatTile label="GPU" value={formatPercent(gpu.usage)} fraction={gpu.usage} caption="Transcoding load" />
        ) : null}
        <StatTile
          label="Network"
          value={`↓ ${formatRate(network.rxPerSec)}`}
          caption={`↑ ${formatRate(network.txPerSec)}`}
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

      <View style={styles.section}>
        <ThemedText style={styles.sectionTitle}>Storage</ThemedText>
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
      </View>

      <View style={styles.section}>
        <ThemedText style={styles.sectionTitle}>Services</ThemedText>
        <Card>
          {data.services.map((s, i) => (
            <ServiceRow
              key={s.id}
              service={s}
              now={now}
              first={i === 0}
              busy={busy === s.id}
              onPress={s.actions.length && !busy ? () => showActions(s) : undefined}
            />
          ))}
        </Card>
      </View>
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
  section: {
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  sectionTitle: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: 700,
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
