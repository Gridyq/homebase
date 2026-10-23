import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import {
  fetchServiceHistory,
  fetchStatus,
  runAction,
  type Service,
  type ServiceAction,
} from '@/miniapps/server/api';
import {
  Card,
  formatBytes,
  formatCpu,
  NavRow,
  Section,
  Segmented,
  serviceColor,
  serviceSummary,
  StatTile,
  usePullToRefresh,
  useSeriesColors,
} from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { HistoryNote, RANGES, TrendCard } from '@/miniapps/server/trends';
import { usePolling } from '@/miniapps/server/use-polling';

const POLL_MS = 3000;
const HISTORY_POLL_MS = 30_000;

const ACTION_LABELS: Record<ServiceAction, string> = {
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
  run: 'Run now',
};

export default function ServiceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const colors = useSeriesColors();
  const status = usePolling(() => fetchStatus(conn), POLL_MS, conn.url);
  const [range, setRange] = useState(RANGES[0].value);
  const history = usePolling(
    () => fetchServiceHistory(conn, range, id),
    HISTORY_POLL_MS,
    `${conn.url}|${id}|${range}`,
    { keepPrevious: true },
  );
  const refreshControl = usePullToRefresh(status.refresh, history.refresh);
  const [busy, setBusy] = useState<ServiceAction>();
  // State only updates on the next render, so a quick second tap could still get through.
  const acting = useRef(false);

  // A container being recreated drops out of the list for a moment; keep showing it meanwhile.
  const [lastSeen, setLastSeen] = useState<Service>();
  const current = status.data?.services.find((s) => s.id === id);
  if (current && current !== lastSeen) setLastSeen(current);
  const service = current ?? lastSeen;
  const header = <Stack.Screen options={{ title: service?.name ?? '' }} />;

  if (!status.data) {
    return (
      <>
        {header}
        <Centered loading={!status.error} error={status.error} onRetry={status.refresh} />
      </>
    );
  }
  if (!service) {
    return (
      <>
        {header}
        <Centered error={new Error('This service is no longer on the server.')} onRetry={status.refresh} />
      </>
    );
  }

  const act = async (s: Service, action: ServiceAction) => {
    if (acting.current) return;
    acting.current = true;
    setBusy(action);
    try {
      await runAction(conn, s.id, action);
    } catch (e) {
      Alert.alert(`Couldn't ${ACTION_LABELS[action].toLowerCase()} ${s.name}`, e instanceof Error ? e.message : String(e));
    }
    await status.refresh();
    setBusy(undefined);
    acting.current = false;
  };

  // Stopping or restarting cuts off whatever it's doing, like a stream or a download.
  const confirm = (action: ServiceAction) => {
    if (action !== 'stop' && action !== 'restart') return act(service, action);
    const label = ACTION_LABELS[action];
    Alert.alert(`${label} ${service.name}?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: label, style: 'destructive', onPress: () => act(service, action) },
    ]);
  };

  const { usage } = service;
  const disk = usage && (usage.readPerSec ?? 0) + (usage.writePerSec ?? 0);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.content, gutter]}
      refreshControl={refreshControl}>
      {header}
      <View style={styles.stateLine}>
        <View style={[styles.dot, { backgroundColor: serviceColor(service, theme.danger) }]} />
        <ThemedText type="small" themeColor="textSecondary" style={styles.flex}>
          {serviceSummary(service, status.data.at)}
        </ThemedText>
      </View>
      {status.error ? (
        <ThemedText type="small" style={{ color: theme.danger }}>
          {status.error.message} Showing the last reading.
        </ThemedText>
      ) : null}

      {usage ? (
        <View style={styles.tiles}>
          <StatTile
            label="Memory"
            value={formatBytes(usage.usedBytes)}
            caption={`+${formatBytes(usage.cacheBytes)} cache`}
          />
          <StatTile label="CPU" value={formatCpu(usage.cpu)} caption="of the whole machine" />
          <StatTile
            label="Disk"
            value={disk === undefined ? '–' : `${formatBytes(disk)}/s`}
            caption={`Read ${formatBytes(usage.readPerSec ?? 0)}/s · write ${formatBytes(usage.writePerSec ?? 0)}/s`}
          />
        </View>
      ) : null}

      {service.actions.length ? (
        <View style={styles.actions}>
          {service.actions.map((a) => (
            <View key={a} style={styles.flex}>
              <Button
                title={busy === a ? `${ACTION_LABELS[a]}…` : ACTION_LABELS[a]}
                variant={a === 'stop' ? 'secondary' : 'primary'}
                disabled={!!busy}
                onPress={() => confirm(a)}
              />
            </View>
          ))}
        </View>
      ) : null}

      <Card>
        <NavRow
          first
          title="Logs"
          caption="What it's been writing, live"
          onPress={() => router.push({ pathname: '/server/logs/[id]', params: { id: service.id, name: service.name } })}
        />
      </Card>

      <Section title="History">
        <Segmented value={range} onChange={setRange} options={RANGES} />
        {history.data ? (
          <View style={[styles.trends, history.stale && styles.stale]}>
            <HistoryNote history={history.data} />
            <TrendCard
              title="Memory"
              series={history.data.series.memory}
              history={history.data}
              format={formatBytes}
              color={colors[0]}
            />
            <TrendCard
              title="CPU"
              series={history.data.series.cpu}
              history={history.data}
              format={formatCpu}
              color={colors[1]}
            />
          </View>
        ) : (
          <Centered loading={!history.error} error={history.error} onRetry={history.refresh} />
        )}
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.three,
  },
  stateLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  flex: {
    flex: 1,
  },
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  trends: {
    gap: Spacing.two,
  },
  /** The last range's charts, while the one just picked loads. */
  stale: {
    opacity: 0.5,
  },
});
