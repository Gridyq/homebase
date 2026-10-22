import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
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
  formatBytes,
  formatCpu,
  Section,
  Segmented,
  serviceColor,
  serviceSummary,
  StatTile,
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
  );
  const [busy, setBusy] = useState<ServiceAction>();

  const service = status.data?.services.find((s) => s.id === id);
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
        <Centered error={new Error('This service is no longer on the server.')} />
      </>
    );
  }

  const act = async (s: Service, action: ServiceAction) => {
    setBusy(action);
    try {
      await runAction(conn, s.id, action);
    } catch (e) {
      Alert.alert(`Couldn't ${ACTION_LABELS[action].toLowerCase()} ${s.name}`, e instanceof Error ? e.message : String(e));
    }
    await status.refresh();
    setBusy(undefined);
  };

  const confirm = (action: ServiceAction) => {
    if (action !== 'stop') return act(service, action);
    Alert.alert(`Stop ${service.name}?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Stop', style: 'destructive', onPress: () => act(service, action) },
    ]);
  };

  const { usage } = service;
  const disk = usage && (usage.readPerSec ?? 0) + (usage.writePerSec ?? 0);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.content, gutter]}>
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

      <Section title="History">
        <Segmented value={range} onChange={setRange} options={RANGES} />
        {history.data ? (
          <>
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
          </>
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
});
