import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import { fetchUsage, type Group, type GroupCategory } from '@/miniapps/server/api';
import {
  Card,
  formatBytes,
  formatCpu,
  formatPercent,
  LegendItem,
  Meter,
  Section,
  Segmented,
  StackedBar,
  useSeriesColors,
} from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { usePolling } from '@/miniapps/server/use-polling';

const POLL_MS = 5000;
const SHOWN = 15;

const CATEGORY_LABELS: Record<GroupCategory, string> = {
  container: 'Containers',
  homebase: 'Homebase',
  desktop: 'Desktop apps',
  login: 'Logins and shells',
  system: 'System services',
};

type SortBy = 'memory' | 'cpu' | 'disk';

const SORTS: Record<SortBy, { value: (g: Group) => number; format: (g: Group) => string }> = {
  memory: { value: (g) => g.usedBytes, format: (g) => formatBytes(g.usedBytes) },
  cpu: { value: (g) => g.cpu ?? 0, format: (g) => formatCpu(g.cpu) },
  disk: {
    value: (g) => (g.readPerSec ?? 0) + (g.writePerSec ?? 0),
    format: (g) => `${formatBytes((g.readPerSec ?? 0) + (g.writePerSec ?? 0))}/s`,
  },
};

export default function MemoryScreen() {
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const colors = useSeriesColors();
  const { data, error, refresh } = usePolling(() => fetchUsage(conn), POLL_MS, conn.url);
  const [sortBy, setSortBy] = useState<SortBy>('memory');
  const [showAll, setShowAll] = useState(false);

  if (!data) return <Centered loading={!error} error={error} onRetry={refresh} />;

  const { memory: m, pressure, groups } = data;
  const sort = SORTS[sortBy];
  const sorted = [...groups].sort((a, b) => sort.value(b) - sort.value(a));
  const shown = showAll ? sorted : sorted.slice(0, SHOWN);
  const top = Math.max(...sorted.map(sort.value), 0) || 1;

  const byCategory = Object.entries(
    groups.reduce<Record<string, number>>((acc, g) => {
      acc[g.category] = (acc[g.category] ?? 0) + g.usedBytes;
      return acc;
    }, {}),
  )
    .map(([category, bytes]) => ({ category: category as GroupCategory, bytes }))
    .sort((a, b) => b.bytes - a.bytes);
  const categoryTop = byCategory[0]?.bytes || 1;

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

      <Card>
        <View style={styles.cardBody}>
          <View>
            <ThemedText style={styles.hero}>{formatBytes(m.availableBytes)} available</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              of {formatBytes(m.totalBytes)}
            </ThemedText>
          </View>
          <StackedBar
            total={m.totalBytes}
            parts={[
              { value: m.appsBytes, color: colors[0] },
              { value: m.kernelBytes, color: colors[1] },
              { value: m.cacheBytes, color: colors[2] },
            ]}
          />
          <View style={styles.legend}>
            <LegendItem color={colors[0]} label="Programs" value={formatBytes(m.appsBytes)} />
            <LegendItem color={colors[1]} label="Kernel" value={formatBytes(m.kernelBytes)} />
            <LegendItem color={colors[2]} label="Cache" value={formatBytes(m.cacheBytes)} />
            <LegendItem color={theme.backgroundSelected} label="Free" value={formatBytes(m.freeBytes)} />
            {m.swapTotalBytes ? (
              <LegendItem
                label="Swap"
                value={`${formatBytes(m.swapUsedBytes)} of ${formatBytes(m.swapTotalBytes)}`}
              />
            ) : null}
          </View>
          <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
            Cache is recently read files the kernel keeps in spare memory, and gives back the moment a
            program needs room. A full-looking machine with lots of cache is healthy.
          </ThemedText>
        </View>
      </Card>

      <Section title="Waiting">
        <Card>
          <View style={styles.cardBody}>
            <View style={styles.pressure}>
              <PressureTile label="Memory" value={pressure.memory} />
              <PressureTile label="CPU" value={pressure.cpu} />
              <PressureTile label="Disk" value={pressure.io} />
            </View>
            <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
              How much of the last minute programs spent stalled for each. Anything above a few
              percent means that resource is the bottleneck.
            </ThemedText>
          </View>
        </Card>
      </Section>

      <Section title="By kind">
        <Card>
          <View style={styles.cardBody}>
            {byCategory.map((c) => (
              <View key={c.category} style={styles.kind}>
                <View style={styles.rowLine}>
                  <ThemedText type="small" style={styles.flex}>
                    {CATEGORY_LABELS[c.category]}
                  </ThemedText>
                  <ThemedText type="smallBold" style={styles.tabular}>
                    {formatBytes(c.bytes)}
                  </ThemedText>
                </View>
                <Meter fraction={c.bytes / categoryTop} color={colors[0]} />
              </View>
            ))}
          </View>
        </Card>
      </Section>

      <Section title="By service">
        <Segmented
          value={sortBy}
          onChange={setSortBy}
          options={[
            { value: 'memory', label: 'Memory' },
            { value: 'cpu', label: 'CPU' },
            { value: 'disk', label: 'Disk' },
          ]}
        />
        <Card>
          {shown.map((g, i) => (
            <GroupRow
              key={g.id}
              group={g}
              first={i === 0}
              value={sort.format(g)}
              fraction={sort.value(g) / top}
              color={colors[0]}
            />
          ))}
          {sorted.length > SHOWN ? (
            <Pressable onPress={() => setShowAll(!showAll)}
              style={[styles.more, { borderTopColor: theme.backgroundSelected }]}>
              <ThemedText type="smallBold" style={{ color: theme.accent }}>
                {showAll ? 'Show fewer' : `Show all ${sorted.length}`}
              </ThemedText>
            </Pressable>
          ) : null}
        </Card>
        <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
          Memory here leaves out each service&apos;s cache. CPU is a share of the whole machine.
        </ThemedText>
      </Section>
    </ScrollView>
  );
}

function PressureTile({ label, value }: { label: string; value?: number }) {
  const theme = useTheme();
  const high = (value ?? 0) >= 0.05;
  return (
    <View style={[styles.pressureTile, { backgroundColor: theme.backgroundSelected }]}>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText type="smallBold" style={[styles.tabular, high && { color: theme.danger }]}>
        {value === undefined ? '–' : value > 0 && value < 0.01 ? '<1%' : formatPercent(value)}
      </ThemedText>
    </View>
  );
}

function GroupRow({
  group,
  first,
  value,
  fraction,
  color,
}: {
  group: Group;
  first: boolean;
  value: string;
  fraction: number;
  color: string;
}) {
  const theme = useTheme();
  const caption = [
    CATEGORY_LABELS[group.category],
    group.cacheBytes >= 50e6 ? `+${formatBytes(group.cacheBytes)} cache` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const serviceId = group.serviceId;
  return (
    <Pressable
      disabled={!serviceId}
      onPress={() => serviceId && router.push({ pathname: '/server/service/[id]', params: { id: serviceId } })}
      style={({ pressed }) => [
        styles.groupRow,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
        { opacity: pressed ? 0.6 : 1 },
      ]}>
      <View style={styles.rowLine}>
        <View style={styles.flex}>
          <ThemedText type="smallBold" numberOfLines={1}>
            {group.name}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.caption}>
            {caption}
          </ThemedText>
        </View>
        <ThemedText type="smallBold" style={styles.tabular}>
          {value}
        </ThemedText>
        {serviceId ? (
          <ThemedText themeColor="textSecondary" style={styles.chevron}>
            ›
          </ThemedText>
        ) : null}
      </View>
      <Meter fraction={fraction} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.three,
  },
  cardBody: {
    gap: Spacing.three,
    paddingVertical: Spacing.two,
  },
  hero: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: 700,
    fontVariant: ['tabular-nums'],
  },
  legend: {
    gap: Spacing.two,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
  },
  pressure: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  pressureTile: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: Spacing.two,
    alignItems: 'center',
  },
  kind: {
    gap: Spacing.one,
  },
  rowLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
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
  chevron: {
    fontSize: 22,
    lineHeight: 24,
  },
  groupRow: {
    gap: Spacing.two,
    paddingVertical: Spacing.two + Spacing.one,
  },
  more: {
    alignItems: 'center',
    paddingVertical: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
