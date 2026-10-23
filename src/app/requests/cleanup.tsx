import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Centered } from '@/components/centered';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';

import { cleanup, type Cleanup, type Strikes } from '@/miniapps/requests/api';
import { Card, Meter, Section, StatTile, StatusColors } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { usePolling } from '@/miniapps/server/use-polling';
import { formatWhen } from '@/utils/format';

/** The server checks the queues every 5 minutes, so there's no point asking more often than this. */
const POLL_MS = 30_000;

/** Downloads the server is watching because they won't finish, and the ones it cleared. */
export default function CleanupScreen() {
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const { data, error, refresh } = usePolling(() => cleanup(conn), POLL_MS, conn.url);
  const [pulled, setPulled] = useState(false);

  if (!data) return <Centered loading={!error} error={error} onRetry={refresh} />;
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
      {error ? (
        <ThemedText type="small" style={{ color: theme.danger }}>
          {error.message} Showing the last reading.
        </ThemedText>
      ) : null}

      <View style={styles.tiles}>
        <StatTile
          label="Watching"
          value={String(data.strikes.length)}
          caption={data.strikes.length === 1 ? 'download with strikes' : 'downloads with strikes'}
        />
        <StatTile
          label="Cleared"
          value={String(data.removed.length)}
          caption={data.removed.length ? `latest ${formatWhen(data.removed[0].at)}` : 'nothing yet'}
        />
      </View>

      <View style={styles.status}>
        <View style={[styles.dot, { backgroundColor: data.failing ? StatusColors.warn : StatusColors.good }]} />
        <ThemedText type="smallBold" style={styles.flex}>
          {data.failing
            ? `Can't check the queues since ${formatWhen(data.failing.since)}: ${data.failing.reason}`
            : data.dryRun
              ? 'Trial run: only noting what it would clear'
              : 'Checking the queues every 5 minutes'}
        </ThemedText>
      </View>

      {data.strikes.length ? (
        <Section title="Watching">
          <Card>
            {data.strikes.map((s, i) => (
              <StrikeRow key={s.title + s.lastStrike} strikes={s} limits={data.limits} first={i === 0} />
            ))}
          </Card>
          <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
            Out of strikes, a download is removed, that release is blocked and another one is searched for.
            Strikes lapse after {data.lapseHours} hours without a new one.
          </ThemedText>
        </Section>
      ) : null}

      {data.removed.length ? (
        <Section title="Cleared">
          <Card>
            {data.removed.map((r, i) => (
              <View key={r.at + r.title} style={[styles.row, !i ? undefined : divider(theme.backgroundSelected)]}>
                <ThemedText type="smallBold" numberOfLines={2}>
                  {r.title}
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
                  {r.reason} · {formatWhen(r.at)}
                </ThemedText>
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      {!data.strikes.length && !data.removed.length ? (
        <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
          Nothing stuck. Downloads that stall, can’t get started or won’t import will show up here.
        </ThemedText>
      ) : null}

      <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
        {data.blocklist
          ? `Files matching any of ${data.blocklist} malware patterns are never downloaded.`
          : 'The malware blocklist hasn’t been fetched yet.'}
      </ThemedText>
    </ScrollView>
  );
}

const KINDS: { key: keyof Cleanup['limits']; label: string }[] = [
  { key: 'stalled', label: 'Stalled' },
  { key: 'metadata', label: 'Can’t get started' },
  { key: 'failedImport', label: 'Won’t import' },
];

function StrikeRow({ strikes, limits, first }: { strikes: Strikes; limits: Cleanup['limits']; first: boolean }) {
  const theme = useTheme();
  // The kind closest to running out decides how full the meter is.
  const worst = KINDS.filter((k) => strikes[k.key] > 0).sort(
    (a, b) => strikes[b.key] / limits[b.key] - strikes[a.key] / limits[a.key],
  );
  const lead = worst[0];
  const fraction = lead ? strikes[lead.key] / limits[lead.key] : 0;
  return (
    <View style={[styles.row, first ? undefined : divider(theme.backgroundSelected)]}>
      <ThemedText type="smallBold" numberOfLines={2}>
        {strikes.title}
      </ThemedText>
      <Meter fraction={fraction} color={fraction >= 0.5 ? StatusColors.warn : StatusColors.idle} />
      <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
        {[...worst.map((k) => `${k.label} ${strikes[k.key]} of ${limits[k.key]}`), formatWhen(strikes.lastStrike)].join(
          ' · ',
        )}
      </ThemedText>
    </View>
  );
}

const divider = (color: string) => ({ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color });

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
  status: {
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
  row: {
    gap: Spacing.one + 2,
    paddingVertical: Spacing.two + Spacing.one,
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
