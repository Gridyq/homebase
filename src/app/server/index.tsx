import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import { fetchStatus, setGameMode, type Connection, type Status } from '@/miniapps/server/api';
import {
  Card,
  diskName,
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
/** The drive the storage screen breaks down. */
const MEDIA_MOUNT = '/mnt/media';

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
  const { data, error, stale, refresh } = usePolling(() => fetchStatus(conn), POLL_MS, conn.url);
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
        <View style={[styles.dot, { backgroundColor: error ? theme.danger : stale ? StatusColors.idle : StatusColors.good }]} />
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
          onPress={() => router.push('/server/cpu')}
        />
        <StatTile
          label="Memory"
          value={formatPercent(memUsed)}
          fraction={memUsed}
          caption={`${formatBytes(memory.totalBytes - memory.availableBytes)} of ${formatBytes(memory.totalBytes)}`}
          onPress={() => router.push('/server/memory')}
        />
        {gpu.usage !== undefined ? (
          <StatTile
            label="GPU"
            value={formatPercent(gpu.usage)}
            fraction={gpu.usage}
            caption="Transcoding load"
            onPress={() => router.push('/server/gpu')}
          />
        ) : null}
        <StatTile
          label="Network"
          value={`↓ ${formatRate(network.rxPerSec)}`}
          caption={`↑ ${formatRate(network.txPerSec)}`}
          onPress={() => router.push('/server/network')}
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

      <GameModeCard conn={conn} status={data} onChanged={refresh} />

      <Section title="Analytics">
        <Card>
          <NavRow first title="Trends" caption="CPU, memory, network, heat and power, up to a year back" onPress={() => router.push('/server/trends')} />
          <NavRow title="Reliability" caption="Crashes, memory kills and reboots, per service" onPress={() => router.push('/server/reliability')} />
          <NavRow title="Memory" caption="What's using it, by service" onPress={() => router.push('/server/memory')} />
          <NavRow title="CPU" caption="Each core's load and clock, and what's waiting" onPress={() => router.push('/server/cpu')} />
          <NavRow title="Processes" caption="Top programs by memory and CPU" onPress={() => router.push('/server/processes')} />
          {gpu.usage !== undefined ? (
            <NavRow title="Graphics card" caption="Engines, memory, heat, power and programs" onPress={() => router.push('/server/gpu')} />
          ) : null}
          <NavRow title="Drives" caption="Health, temperature and who's using each drive" onPress={() => router.push('/server/drives')} />
          <NavRow title="Network" caption="Traffic by service and by device" onPress={() => router.push('/server/network')} />
          <NavRow title="Power" caption="What the server draws and what it costs" onPress={() => router.push('/server/power')} />
          <NavRow title="Media drive" caption="What's taking up space, by show and download" onPress={() => router.push('/server/storage')} />
          <NavRow title="Tailscale" caption="Devices on the tailnet and how they connect" onPress={() => router.push('/server/tailscale')} />
        </Card>
      </Section>

      <Section title="Storage">
        <Card>
          {data.disks.map((d, i) => {
            const used = d.usedBytes / d.totalBytes;
            const media = d.mount === MEDIA_MOUNT;
            return (
              <Pressable
                key={d.mount}
                disabled={!media}
                onPress={() => router.push('/server/storage')}
                style={({ pressed }) => [styles.disk, i > 0 && styles.diskGap, { opacity: pressed ? 0.6 : 1 }]}>
                <View style={styles.diskLine}>
                  <ThemedText type="smallBold" style={styles.flex} numberOfLines={1}>
                    {diskName(d.mount)}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {formatBytes(d.availableBytes)} free of {formatBytes(d.totalBytes)}
                    {media ? '  ›' : ''}
                  </ThemedText>
                </View>
                <Meter fraction={used} color={levelColor(used, theme.danger)} />
              </Pressable>
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

function GameModeCard({ conn, status, onChanged }: { conn: Connection; status: Status; onChanged: () => Promise<void> }) {
  const theme = useTheme();
  // The value being switched to while the server stops or starts everything.
  const [pending, setPending] = useState<boolean>();
  const { gameMode } = status;
  const on = pending ?? gameMode.on;

  const toggle = async (next: boolean) => {
    setPending(next);
    try {
      await setGameMode(conn, next);
      await onChanged();
    } catch (e) {
      Alert.alert(`Couldn't turn game mode ${next ? 'on' : 'off'}`, e instanceof Error ? e.message : String(e));
    } finally {
      setPending(undefined);
    }
  };

  let caption: string;
  if (pending !== undefined) caption = pending ? 'Stopping downloads and requests…' : 'Starting downloads and requests…';
  else if (gameMode.on && gameMode.manual) caption = 'Downloads and requests are stopped until you turn it off.';
  else if (gameMode.on && gameMode.endsAt) {
    caption = `${gameMode.game} closed. Downloads come back in ${formatDuration(Math.max(0, gameMode.endsAt - status.at))}.`;
  } else if (gameMode.on) caption = `Downloads and requests are stopped while ${gameMode.game} runs.`;
  else if (gameMode.manual && gameMode.game) caption = `Kept off while ${gameMode.game} runs.`;
  else {
    const ids = new Set(gameMode.services);
    const freed = status.services.reduce((sum, s) => sum + (ids.has(s.id) ? (s.usage?.usedBytes ?? 0) : 0), 0);
    caption = `Stops downloads and requests to free ${freed ? `about ${formatBytes(freed)}` : 'their memory'}. Turns on by itself while a Steam game or Starsector runs.`;
  }

  return (
    <Card>
      <View style={styles.gameRow}>
        <View style={styles.flex}>
          <ThemedText type="smallBold">Game mode</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {caption}
          </ThemedText>
        </View>
        <Switch
          value={on}
          disabled={pending !== undefined}
          onValueChange={toggle}
          trackColor={{ true: theme.accent }}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  gameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two,
  },
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
