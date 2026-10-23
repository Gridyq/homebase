import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import { fetchReliability, type ServiceReliability } from '@/miniapps/server/api';
import {
  Card,
  formatPercent,
  formatWhen,
  Section,
  Segmented,
  StatTile,
  StatusColors,
  usePullToRefresh,
} from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { EventRow } from '@/miniapps/server/events';
import { LONG_RANGES, rangeName } from '@/miniapps/server/trends';
import { useRangedPolling } from '@/miniapps/server/use-polling';

const POLL_MS = 30_000;
const TROUBLE = new Set(['crashed', 'failed', 'oom', 'problem', 'boot']);
const FILTERS = [
  { value: 'trouble', label: 'Trouble' },
  { value: 'all', label: 'Everything' },
] as const;

/** Crashes, memory kills and reboots, per service and as a timeline. */
export default function ReliabilityScreen() {
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const [filter, setFilter] = useState<'trouble' | 'all'>('trouble');
  const { data, error, stale, refresh, range, setRange } = useRangedPolling(
    LONG_RANGES[1].value,
    (range) => fetchReliability(conn, range),
    POLL_MS,
    conn.url,
  );
  const refreshControl = usePullToRefresh(refresh);

  const picker = <Segmented value={range} onChange={setRange} options={LONG_RANGES} />;
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

  const sum = (pick: (s: ServiceReliability) => number) => data.services.reduce((n, s) => n + pick(s), 0);
  const crashes = sum((s) => s.crashes + s.failures);
  const kills = sum((s) => s.oomKills);
  const unknownKills = data.events.filter((e) => e.kind === 'oom' && !e.id).length;
  const events = filter === 'all' ? data.events : data.events.filter((e) => TROUBLE.has(e.kind));
  const partial = data.oldest && data.oldest > data.start;

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

      <View style={styles.tiles}>
        <StatTile label="Crashes" value={String(crashes)} caption={rangeName(range)} />
        <StatTile label="Memory kills" value={String(kills + unknownKills)} caption={unknownKills ? `${unknownKills} outside services` : rangeName(range)} />
        <StatTile label="Reboots" value={String(data.boots.length)} caption={data.boots.length ? `last ${formatWhen(data.boots.at(-1)!)}` : rangeName(range)} />
      </View>

      <Section title="Services">
        <Card>
          {data.services.map((s, i) => (
            <ServiceLine key={s.id} service={s} first={i === 0} />
          ))}
        </Card>
        <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
          {partial ? `Counted since ${formatWhen(data.oldest!)}, when the server started keeping track. ` : ''}
          Up is the share of the time it was running, including stops on purpose (game mode, on demand
          or by you), so the assistant is low by design.
        </ThemedText>
      </Section>

      <Section title="What happened">
        <Segmented value={filter} onChange={setFilter} options={[...FILTERS]} />
        <Card>
          {events.length ? (
            events.map((e, i) => <EventRow key={`${e.t}-${i}`} event={e} first={i === 0} />)
          ) : (
            <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
              Nothing in {rangeName(range)}.
            </ThemedText>
          )}
        </Card>
      </Section>
    </ScrollView>
  );
}

function ServiceLine({ service: s, first }: { service: ServiceReliability; first: boolean }) {
  const theme = useTheme();
  const trouble = s.crashes + s.failures + s.oomKills;
  const parts = [
    s.crashes && `${s.crashes} crash${s.crashes === 1 ? '' : 'es'}`,
    s.failures && `failed ${s.failures}×`,
    s.oomKills && `${s.oomKills} memory kill${s.oomKills === 1 ? '' : 's'}`,
    s.stops && `stopped unexpectedly ${s.stops}×`,
    s.restarts && `restarted ${s.restarts}×`,
  ].filter(Boolean);
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/server/service/[id]', params: { id: s.id } })}
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
        { opacity: pressed ? 0.6 : 1 },
      ]}>
      <View style={[styles.dot, { backgroundColor: trouble ? theme.danger : s.stops ? StatusColors.warn : StatusColors.good }]} />
      <View style={styles.flex}>
        <ThemedText type="smallBold" numberOfLines={1}>
          {s.name}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.caption} numberOfLines={2}>
          {parts.length ? parts.join(' · ') : 'No trouble'}
          {s.lastTrouble ? ` · last ${formatWhen(s.lastTrouble)}` : ''}
        </ThemedText>
      </View>
      {s.running ? (
        <ThemedText type="small" themeColor="textSecondary" style={styles.tabular}>
          Up {formatPercent(s.running)}
        </ThemedText>
      ) : null}
    </Pressable>
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
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
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
  empty: {
    paddingVertical: Spacing.two,
  },
});
