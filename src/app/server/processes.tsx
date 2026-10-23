import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import { fetchProcesses, type ProcessInfo } from '@/miniapps/server/api';
import { Card, formatBytes, formatCpu, Meter, Segmented, usePullToRefresh, useSeriesColors } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { usePolling } from '@/miniapps/server/use-polling';

const POLL_MS = 3000;
const SHOWN = 30;

type SortBy = 'memory' | 'cpu';

export default function ProcessesScreen() {
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const colors = useSeriesColors();
  const { data, error, refresh } = usePolling(() => fetchProcesses(conn), POLL_MS, conn.url);
  const refreshControl = usePullToRefresh(refresh);
  const [sortBy, setSortBy] = useState<SortBy>('memory');

  if (!data) return <Centered loading={!error} error={error} onRetry={refresh} />;

  const value = (p: ProcessInfo) => (sortBy === 'memory' ? p.rssBytes : (p.cpu ?? 0));
  const sorted = [...data.processes].sort((a, b) => value(b) - value(a)).slice(0, SHOWN);
  const top = Math.max(...sorted.map(value), 0) || 1;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.content, gutter]}
      refreshControl={refreshControl}>
      {error ? (
        <ThemedText type="small" style={{ color: theme.danger }}>
          {error.message} Showing the last reading.
        </ThemedText>
      ) : null}
      <Segmented
        value={sortBy}
        onChange={setSortBy}
        options={[
          { value: 'memory', label: 'Memory' },
          { value: 'cpu', label: 'CPU' },
        ]}
      />
      <Card>
        {sorted.map((p, i) => (
          <Pressable
            key={p.pid}
            onPress={() => Alert.alert(`${p.name} (${p.pid})`, p.command || 'No command line')}
            style={({ pressed }) => [
              styles.row,
              i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
              { opacity: pressed ? 0.6 : 1 },
            ]}>
            <View style={styles.line}>
              <View style={styles.flex}>
                <ThemedText type="smallBold" numberOfLines={1}>
                  {p.name}
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.caption}>
                  {[p.service, `PID ${p.pid}`].filter(Boolean).join(' · ')}
                </ThemedText>
              </View>
              <View style={styles.values}>
                <ThemedText type="smallBold" style={styles.tabular}>
                  {sortBy === 'memory' ? formatBytes(p.rssBytes) : formatCpu(p.cpu)}
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary" style={[styles.caption, styles.tabular]}>
                  {sortBy === 'memory' ? `${formatCpu(p.cpu)} CPU` : formatBytes(p.rssBytes)}
                </ThemedText>
              </View>
            </View>
            <Meter fraction={value(p) / top} color={colors[0]} />
          </Pressable>
        ))}
      </Card>
      <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
        {data.count} processes running. Memory is each one&apos;s resident size, which counts shared
        libraries in every process that uses them, so these add up to more than is really in use. Tap
        one to see its command line.
      </ThemedText>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.three,
  },
  row: {
    gap: Spacing.two,
    paddingVertical: Spacing.two + Spacing.one,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  flex: {
    flex: 1,
  },
  values: {
    alignItems: 'flex-end',
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
});
