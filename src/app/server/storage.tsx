import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Centered } from '@/components/centered';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';

import { fetchStorage, type StorageCategory } from '@/miniapps/server/api';
import { Card, LegendItem, Meter, NavRow, Section, StackedBar, usePullToRefresh, useSeriesColors } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { usePolling } from '@/miniapps/server/use-polling';
import { formatBytes } from '@/utils/format';

// Sizes change slowly, and each reading walks the whole drive.
const POLL_MS = 60_000;

const LIBRARY = new Set(['shows', 'movies', 'youtube']);

/** What fills the media drive, by folder. */
export default function StorageScreen() {
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const colors = useSeriesColors();
  const { data, error, refresh } = usePolling(() => fetchStorage(conn), POLL_MS, conn.url);
  const refreshControl = usePullToRefresh(refresh);

  if (!data) return <Centered loading={!error} error={error} onRetry={refresh} />;

  const sum = (cats: StorageCategory[]) => cats.reduce((n, c) => n + c.bytes, 0);
  const library = sum(data.categories.filter((c) => LIBRARY.has(c.id)));
  const downloads = sum(data.categories.filter((c) => c.id === 'downloads'));
  const rest = sum(data.categories.filter((c) => !LIBRARY.has(c.id) && c.id !== 'downloads'));
  // Filesystem bookkeeping and anything outside the folders listed.
  const unlisted = Math.max(0, data.usedBytes - library - downloads - rest);
  const largest = Math.max(1, ...data.categories.flatMap((c) => c.items.map((i) => i.bytes)));
  const shown = data.categories.filter((c) => c.bytes > 0 && (c.items.length || c.bytes >= 1 << 20));

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

      <Card>
        <View style={styles.summary}>
          <View style={styles.line}>
            <ThemedText type="smallBold" style={styles.flex}>
              {data.mount}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {formatBytes(data.availableBytes)} free of {formatBytes(data.totalBytes)}
            </ThemedText>
          </View>
          <StackedBar
            total={data.totalBytes}
            parts={[
              { value: library, color: colors[0] },
              { value: downloads, color: colors[1] },
              { value: rest, color: colors[2] },
              { value: unlisted, color: theme.textSecondary },
            ]}
          />
          <View style={styles.legend}>
            <LegendItem color={colors[0]} label="Library" value={formatBytes(library)} />
            <LegendItem color={colors[1]} label="Downloads" value={formatBytes(downloads)} />
            <LegendItem color={colors[2]} label="Caches, backups and trash" value={formatBytes(rest)} />
            {unlisted >= 1 << 30 ? (
              <LegendItem color={theme.textSecondary} label="Other" value={formatBytes(unlisted)} />
            ) : null}
            <LegendItem color={theme.backgroundSelected} label="Free" value={formatBytes(data.availableBytes)} />
          </View>
        </View>
      </Card>

      <Card>
        <NavRow
          first
          title="Free up space"
          caption="Delete shows and movies in Requests"
          onPress={() => router.push('/requests/library')}
        />
      </Card>

      {shown.map((c) => (
        <Section key={c.id} title={`${c.label} · ${formatBytes(c.bytes)}`}>
          {c.items.length ? (
            <Card>
              {c.items.map((item, i) => (
                <View
                  key={item.name}
                  style={[
                    styles.item,
                    i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
                  ]}>
                  <View style={styles.line}>
                    <ThemedText type="small" style={styles.flex} numberOfLines={1}>
                      {item.name}
                    </ThemedText>
                    <ThemedText type="smallBold" style={styles.tabular}>
                      {formatBytes(item.bytes)}
                    </ThemedText>
                  </View>
                  <Meter
                    fraction={item.bytes / largest}
                    color={LIBRARY.has(c.id) ? colors[0] : c.id === 'downloads' ? colors[1] : colors[2]}
                  />
                </View>
              ))}
              {c.more ? (
                <ThemedText type="small" themeColor="textSecondary" style={styles.more}>
                  and {c.more} smaller
                </ThemedText>
              ) : null}
            </Card>
          ) : null}
          {c.id === 'downloads' ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
              {data.sharedDownloadBytes
                ? `Another ${formatBytes(data.sharedDownloadBytes)} of downloads are the same files as the library, so they take no extra room. `
                : ''}
              These are torrents still seeding, or ones whose files were converted after import, so the
              library has its own copy. Removing them in qBittorrent frees the space.
            </ThemedText>
          ) : null}
        </Section>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.three,
  },
  summary: {
    gap: Spacing.three,
    paddingVertical: Spacing.two,
  },
  legend: {
    gap: Spacing.one,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.two,
  },
  flex: {
    flex: 1,
  },
  item: {
    gap: Spacing.two,
    paddingVertical: Spacing.two + Spacing.one,
  },
  tabular: {
    fontVariant: ['tabular-nums'],
  },
  more: {
    fontSize: 13,
    paddingBottom: Spacing.two,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
  },
});
