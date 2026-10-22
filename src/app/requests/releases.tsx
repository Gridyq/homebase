import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered, Chip } from '@/miniapps/jellyfin/components';
import { useAsync } from '@/miniapps/jellyfin/use-async';
import { grabRelease, searchReleases, type Arr, type Release } from '@/miniapps/requests/api';
import { formatAge } from '@/miniapps/requests/components';
import { formatBytes, StatusColors } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';

/** Interactive search: every release the indexers have, scored by the TRaSH rules, to pick by hand. */
export default function Releases() {
  const { app, id, season, title } = useLocalSearchParams<{ app: Arr; id: string; season?: string; title: string }>();
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const [showRejected, setShowRejected] = useState(false);
  const [grabbing, setGrabbing] = useState<string>();
  const { data, error, loading, reload } = useAsync(
    () => searchReleases(conn, app, Number(id), season !== undefined ? Number(season) : undefined),
    `${app}:${id}:${season}`,
  );

  const header = <Stack.Screen options={{ title: season !== undefined ? `Season ${season}` : 'Releases' }} />;

  if (!data) {
    return (
      <>
        {header}
        {loading ? (
          <View style={[styles.searching, { backgroundColor: theme.background }]}>
            <ActivityIndicator />
            <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
              Asking every indexer for {title}. This can take a minute.
            </ThemedText>
          </View>
        ) : (
          <Centered error={error} onRetry={reload} />
        )}
      </>
    );
  }

  const approved = data.filter((r) => r.approved);
  const shown = showRejected ? data : approved;

  const grab = (r: Release) => {
    Alert.alert('Download this release?', `${r.title}\n\n${r.quality} · ${formatBytes(r.size)} · ${r.seeders ?? 0} seeders`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Download',
        onPress: async () => {
          setGrabbing(r.guid);
          try {
            await grabRelease(conn, app, r);
            router.back();
          } catch (e) {
            Alert.alert("Couldn't start the download", e instanceof Error ? e.message : String(e));
          } finally {
            setGrabbing(undefined);
          }
        },
      },
    ]);
  };

  return (
    <>
      {header}
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={[styles.list, gutter]}
        data={shown}
        keyExtractor={(r) => `${r.indexerId}:${r.guid}`}
        ListHeaderComponent={
          <View style={styles.header}>
            <ThemedText type="small" themeColor="textSecondary">
              {approved.length} of {data.length} releases pass your quality rules, best first.
            </ThemedText>
            {data.length > approved.length ? (
              <View style={styles.chips}>
                <Chip label="Passing" selected={!showRejected} onPress={() => setShowRejected(false)} />
                <Chip label={`All ${data.length}`} selected={showRejected} onPress={() => setShowRejected(true)} />
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <ThemedText themeColor="textSecondary" style={styles.center}>
            {data.length ? 'Nothing passes your quality rules. Show all to see why.' : 'No releases found.'}
          </ThemedText>
        }
        renderItem={({ item }) => (
          <ReleaseRow release={item} busy={grabbing === item.guid} disabled={!!grabbing} onPress={() => grab(item)} />
        )}
      />
    </>
  );
}

function ReleaseRow({
  release: r,
  busy,
  disabled,
  onPress,
}: {
  release: Release;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const scoreColor = r.customFormatScore > 0 ? StatusColors.good : r.customFormatScore < 0 ? theme.danger : StatusColors.idle;
  const meta = [
    r.fullSeason && 'Season pack',
    r.quality,
    formatBytes(r.size),
    r.seeders !== undefined && `${r.seeders} seeders`,
    formatAge(r.ageHours),
    r.indexer,
  ].filter(Boolean);

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: theme.backgroundElement, opacity: pressed ? 0.6 : r.approved ? 1 : 0.6 },
      ]}>
      <View style={styles.rowTop}>
        <ThemedText type="smallBold" numberOfLines={2} style={styles.flex}>
          {r.title}
        </ThemedText>
        {busy ? (
          <ActivityIndicator />
        ) : (
          <View style={[styles.score, { backgroundColor: scoreColor }]}>
            <ThemedText style={styles.scoreText}>{r.customFormatScore > 0 ? `+${r.customFormatScore}` : r.customFormatScore}</ThemedText>
          </View>
        )}
      </View>
      <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
        {meta.join(' · ')}
      </ThemedText>
      {r.customFormats.length ? (
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={2} style={styles.caption}>
          {r.customFormats.join(', ')}
        </ThemedText>
      ) : null}
      {r.rejections.length ? (
        <ThemedText type="small" numberOfLines={3} style={[styles.caption, { color: theme.danger }]}>
          {r.rejections.join('\n')}
        </ThemedText>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  searching: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    gap: Spacing.three,
  },
  center: {
    textAlign: 'center',
  },
  list: {
    paddingVertical: Spacing.three,
    gap: Spacing.two,
  },
  header: {
    gap: Spacing.two,
    marginBottom: Spacing.one,
  },
  chips: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  row: {
    borderRadius: 14,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  flex: {
    flex: 1,
  },
  score: {
    borderRadius: 999,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
  },
  scoreText: {
    color: '#fff',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: 700,
    fontVariant: ['tabular-nums'],
  },
  caption: {
    fontSize: 13,
    lineHeight: 17,
  },
});
