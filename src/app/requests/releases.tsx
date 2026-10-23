import { router, Stack, useLocalSearchParams, useNavigation } from 'expo-router';
import { useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered, Chip } from '@/miniapps/jellyfin/components';
import { useAsync } from '@/miniapps/jellyfin/use-async';
import { grabRelease, removeDownload, searchReleases, type Arr, type Release } from '@/miniapps/requests/api';
import { formatAge } from '@/miniapps/requests/components';
import { formatBytes, StatusColors } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';

const GB = 1e9;
const RESOLUTIONS = ['2160p', '1080p', '720p'] as const;
/** Size caps to pick from: per episode for a show, for the whole file for a movie. */
const EPISODE_CAPS = [1, 2, 4].map((n) => n * GB);
const MOVIE_CAPS = [4, 8, 15].map((n) => n * GB);
const SORTS = { best: 'Best first', smallest: 'Smallest first', seeders: 'Most seeders' } as const;
type Sort = keyof typeof SORTS;

const resolutionOf = (r: Release) => /(\d{3,4})p/.exec(r.quality)?.[0] ?? (/(\d{3,4})p/i.exec(r.title)?.[0].toLowerCase());
const isHevc = (r: Release) => /\b(x265|hevc|h\.?265)\b/i.test(r.title);

/** Interactive search: every release the indexers have, scored by the TRaSH rules, to pick by hand. */
export default function Releases() {
  const { app, id, season, title, episodes, replaces } = useLocalSearchParams<{
    app: Arr;
    id: string;
    season?: string;
    title: string;
    /** Episodes in the season, to size a season pack per episode. */
    episodes?: string;
    /** Queue ids of a download to remove and blocklist once another release is picked. */
    replaces?: string;
  }>();
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const [showRejected, setShowRejected] = useState(false);
  const [resolution, setResolution] = useState<string>();
  const [cap, setCap] = useState<number>();
  const [hevcOnly, setHevcOnly] = useState(false);
  const [sort, setSort] = useState<Sort>('best');
  const [grabbing, setGrabbing] = useState<string>();
  const screen = useNavigation();
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

  const tv = app === 'sonarr';
  // Opened from a download there's no episode count; the highest episode any release covers is close.
  const episodeCount = Number(episodes) || Math.max(0, ...data.flatMap((r) => r.episodeNumbers ?? [])) || undefined;
  const perEpisode = (r: Release) =>
    tv ? r.size / Math.max(1, r.fullSeason ? (episodeCount ?? 1) : r.episodeNumbers?.length || 1) : r.size;
  const approved = data.filter((r) => r.approved);
  const unfiltered = showRejected ? data : approved;
  const filtered = unfiltered.filter(
    (r) =>
      (!resolution || resolutionOf(r) === resolution) && (!cap || perEpisode(r) <= cap) && (!hevcOnly || isHevc(r)),
  );
  // The server's order is "best first".
  const shown =
    sort === 'smallest'
      ? [...filtered].sort((a, b) => perEpisode(a) - perEpisode(b))
      : sort === 'seeders'
        ? [...filtered].sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0))
        : filtered;
  const filtering = !!(resolution || cap || hevcOnly);
  const caps = tv ? EPISODE_CAPS : MOVIE_CAPS;

  const pickSort = () => {
    const keys = Object.keys(SORTS) as Sort[];
    ActionSheetIOS.showActionSheetWithOptions(
      { title: 'Sort releases', options: [...keys.map((k) => SORTS[k]), 'Cancel'], cancelButtonIndex: keys.length },
      (index) => keys[index] && setSort(keys[index]),
    );
  };

  const grab = (r: Release) => {
    Alert.alert(replaces ? 'Download this one instead?' : 'Download this release?', `${r.title}\n\n${r.quality} · ${formatBytes(r.size)} · ${r.seeders ?? 0} seeders`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Download',
        onPress: async () => {
          setGrabbing(r.guid);
          try {
            await grabRelease(conn, app, r);
            if (replaces) {
              const queueIds = replaces.split(',').map(Number);
              await removeDownload(conn, { arr: app, queueIds }, true, false).catch((e) =>
                Alert.alert(
                  'Downloading the new release',
                  `But the old download couldn't be removed: ${e instanceof Error ? e.message : String(e)}`,
                ),
              );
            }
            // Left meanwhile, going back would close whatever screen is showing now.
            if (screen.isFocused()) router.back();
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
              {approved.length} of {data.length} releases pass your quality rules
              {filtering ? `, ${shown.length} shown` : ''}.{' '}
              <ThemedText type="small" style={{ color: theme.accent }} onPress={pickSort}>
                {SORTS[sort]} ▾
              </ThemedText>
            </ThemedText>
            {data.length > approved.length ? (
              <ChipRow>
                <Chip label="Passing" selected={!showRejected} onPress={() => setShowRejected(false)} />
                <Chip label={`All ${data.length}`} selected={showRejected} onPress={() => setShowRejected(true)} />
              </ChipRow>
            ) : null}
            <ChipRow>
              <Chip label="Any quality" selected={!resolution} onPress={() => setResolution(undefined)} />
              {RESOLUTIONS.map((res) => (
                <Chip key={res} label={res} selected={resolution === res} onPress={() => setResolution(res)} />
              ))}
              <Chip label="x265 only" selected={hevcOnly} onPress={() => setHevcOnly(!hevcOnly)} />
            </ChipRow>
            <ChipRow>
              <Chip label="Any size" selected={!cap} onPress={() => setCap(undefined)} />
              {caps.map((c) => (
                <Chip
                  key={c}
                  label={`Under ${c / GB} GB${tv ? '/ep' : ''}`}
                  selected={cap === c}
                  onPress={() => setCap(c)}
                />
              ))}
            </ChipRow>
          </View>
        }
        ListEmptyComponent={
          <ThemedText themeColor="textSecondary" style={styles.center}>
            {unfiltered.length
              ? 'Nothing matches these filters.'
              : data.length
                ? 'Nothing passes your quality rules. Show all to see why.'
                : 'No releases found.'}
          </ThemedText>
        }
        renderItem={({ item }) => (
          <ReleaseRow
            release={item}
            perEpisode={tv && item.fullSeason && episodeCount ? perEpisode(item) : undefined}
            busy={grabbing === item.guid}
            disabled={!!grabbing}
            onPress={() => grab(item)}
          />
        )}
      />
    </>
  );
}

/** Chips in a line that scrolls sideways, running to the screen edges. */
function ChipRow({ children }: { children: React.ReactNode }) {
  const gutter = useGutter();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginLeft: -gutter.paddingLeft, marginRight: -gutter.paddingRight }}
      contentContainerStyle={[styles.chips, gutter]}>
      {children}
    </ScrollView>
  );
}

function ReleaseRow({
  release: r,
  perEpisode,
  busy,
  disabled,
  onPress,
}: {
  release: Release;
  /** A season pack's size per episode. */
  perEpisode?: number;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const scoreColor = r.customFormatScore > 0 ? StatusColors.good : r.customFormatScore < 0 ? theme.danger : StatusColors.idle;
  const meta = [
    r.fullSeason && 'Season pack',
    r.quality,
    perEpisode ? `${formatBytes(r.size)} (${formatBytes(perEpisode)}/ep)` : formatBytes(r.size),
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
