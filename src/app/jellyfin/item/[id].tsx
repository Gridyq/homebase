import { Image } from 'expo-image';
import { Link, router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { TICKS_PER_SECOND, type BaseItem, type Person, type UserData } from '@/miniapps/jellyfin/api';
import { Button, Centered, Chip, formatRuntime, ItemRow, PosterCard } from '@/miniapps/jellyfin/components';
import { useJellyfin } from '@/miniapps/jellyfin/session';
import { defaultSubtitleIndex, subtitleLabel, subtitleStreams, SUBTITLES_OFF } from '@/miniapps/jellyfin/subtitles';
import { useAsync } from '@/miniapps/jellyfin/use-async';

export default function ItemDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const client = useJellyfin();
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const [selectedSubtitle, setSubtitle] = useState<number>();

  const { data: loaded, error, loading, reload } = useAsync(() => client.item(id), id);
  // Watched/favorite changes made here, shown until the next reload catches up.
  const [userData, setUserData] = useState<{ itemId: string; data: UserData }>();
  const item =
    loaded && userData?.itemId === loaded.Id ? { ...loaded, UserData: { ...loaded.UserData, ...userData.data } } : loaded;

  // Pick up the new resume position after returning from the player.
  const focusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedOnce.current) {
        setUserData(undefined);
        reload();
      }
      focusedOnce.current = true;
    }, [reload]),
  );

  if (!item) return <Centered loading={loading} error={error} onRetry={reload} />;

  const backdrop = client.imageUrl(item, { type: 'Backdrop', height: 720 }) ?? client.imageUrl(item, { height: 720 });
  const resumeTicks = item.UserData?.PlaybackPositionTicks ?? 0;
  const playable = item.MediaType === 'Video';
  const subtitles = subtitleStreams(item);
  const subtitle = selectedSubtitle ?? defaultSubtitleIndex(item);
  const toggle = async (change: (current: UserData) => Promise<UserData>) => {
    const itemId = item.Id;
    try {
      const data = await change(item.UserData ?? {});
      setUserData((prev) => ({ itemId, data: { ...(prev?.itemId === itemId ? prev.data : {}), ...data } }));
    } catch (e) {
      Alert.alert("Couldn't update", e instanceof Error ? e.message : String(e));
    }
  };
  const played = !!item.UserData?.Played;
  const favorite = !!item.UserData?.IsFavorite;
  const canMarkPlayed = playable || item.Type === 'Series' || item.Type === 'Season' || item.Type === 'BoxSet';
  const isPerson = item.Type === 'Person';

  const meta = [
    item.Type === 'Episode' && item.SeriesName,
    item.ProductionYear,
    item.OfficialRating,
    formatRuntime(item.RunTimeTicks),
    item.CommunityRating && `★ ${item.CommunityRating.toFixed(1)}`,
  ].filter(Boolean);

  const play = (startTicks: number) =>
    router.push({
      pathname: '/jellyfin/player/[id]',
      params: {
        id: item.Id,
        start: String(startTicks / TICKS_PER_SECOND),
        ...(subtitles.length ? { subtitle: String(subtitle) } : {}),
      },
    });

  return (
    <ScrollView style={{ backgroundColor: theme.background }} contentInsetAdjustmentBehavior="never">
      <Stack.Screen options={{ title: '', headerTransparent: true }} />
      {backdrop ? (
        <Image source={backdrop} style={{ width, height: (width * 9) / 16 }} contentFit="cover" />
      ) : (
        <View style={{ height: 100 }} />
      )}
      <View style={styles.body}>
        <ThemedText type="subtitle" style={styles.title}>
          {item.Type === 'Episode' && item.IndexNumber != null ? `${item.IndexNumber}. ${item.Name}` : item.Name}
        </ThemedText>
        {meta.length ? (
          <ThemedText type="small" themeColor="textSecondary">
            {meta.join(' · ')}
          </ThemedText>
        ) : null}
        {item.Genres?.length ? (
          <ThemedText type="small" themeColor="textSecondary">
            {item.Genres.join(', ')}
          </ThemedText>
        ) : null}

        {playable ? (
          <View style={styles.actions}>
            {resumeTicks > 0 ? (
              <>
                <Button title={`Resume from ${formatRuntime(resumeTicks)}`} onPress={() => play(resumeTicks)} />
                <Button title="Play from start" variant="secondary" onPress={() => play(0)} />
              </>
            ) : (
              <Button title="Play" onPress={() => play(0)} />
            )}
          </View>
        ) : null}

        {!isPerson ? (
          <View style={styles.toggles}>
            {canMarkPlayed ? (
              <Chip
                label={played ? '✓ Watched' : 'Mark watched'}
                selected={played}
                onPress={() => toggle(() => client.setPlayed(item.Id, !played))}
              />
            ) : null}
            <Chip
              label={favorite ? '♥ Favorite' : '♡ Favorite'}
              selected={favorite}
              onPress={() => toggle(() => client.setFavorite(item.Id, !favorite))}
            />
            <Trailers item={item} />
          </View>
        ) : null}

        {playable && subtitles.length ? (
          <View style={styles.picker}>
            <ThemedText type="smallBold">Subtitles</ThemedText>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pickerChips}>
              {[{ index: SUBTITLES_OFF, label: 'Off' }, ...subtitles.map((s) => ({ index: s.Index, label: subtitleLabel(s) }))].map(
                ({ index, label }) => (
                  <Chip key={index} label={label} selected={index === subtitle} onPress={() => setSubtitle(index)} />
                ),
              )}
            </ScrollView>
          </View>
        ) : null}

        {item.Taglines?.[0] ? (
          <ThemedText type="smallBold" style={styles.tagline}>
            {item.Taglines[0]}
          </ThemedText>
        ) : null}
        {item.Overview ? <ThemedText type="small">{item.Overview}</ThemedText> : null}
        <Crew people={item.People} />
      </View>

      <View style={styles.sections}>
        {item.Type === 'Series' ? <SeriesEpisodes series={item} /> : null}
        {item.IsFolder && item.Type !== 'Series' ? <FolderChildren parent={item} /> : null}
        {playable ? <Chapters item={item} onPlay={play} /> : null}
        <Cast people={item.People} />
        {isPerson ? <Credits person={item} /> : null}
        {item.Type === 'Movie' || item.Type === 'Series' ? <Similar item={item} /> : null}
      </View>
      <View style={{ height: Spacing.six }} />
    </ScrollView>
  );
}

function SeriesEpisodes({ series }: { series: BaseItem }) {
  const client = useJellyfin();
  const { width } = useWindowDimensions();
  const [selectedSeasonId, setSeasonId] = useState<string>();

  const { data: seasons } = useAsync(() => client.seasons(series.Id), series.Id);
  const seasonId = selectedSeasonId ?? seasons?.[0]?.Id;

  const { data: episodes, reload: reloadEpisodes } = useAsync(
    () => (seasonId ? client.episodes(series.Id, seasonId) : Promise.resolve([])),
    `${series.Id}/${seasonId}`,
  );

  const episodeActions = (ep: BaseItem) => {
    const played = !!ep.UserData?.Played;
    Alert.alert(ep.Name, undefined, [
      {
        text: played ? 'Mark as unwatched' : 'Mark as watched',
        onPress: () =>
          client.setPlayed(ep.Id, !played).then(reloadEpisodes, (e: Error) => Alert.alert("Couldn't update", e.message)),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  return (
    <View style={styles.section}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {seasons?.map((s) => (
          <Chip key={s.Id} label={s.Name} selected={s.Id === seasonId} onPress={() => setSeasonId(s.Id)} />
        ))}
      </ScrollView>
      <View style={styles.episodes}>
        {episodes?.map((ep) => (
          <Link key={ep.Id} href={{ pathname: '/jellyfin/item/[id]', params: { id: ep.Id } }} asChild>
            <Pressable style={styles.episode} onLongPress={() => episodeActions(ep)}>
              <EpisodeThumb item={ep} width={Math.min(160, width * 0.38)} />
              <View style={{ flex: 1, gap: 2 }}>
                <ThemedText type="smallBold" numberOfLines={2}>
                  {ep.IndexNumber != null ? `${ep.IndexNumber}. ` : ''}
                  {ep.Name}
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {[formatRuntime(ep.RunTimeTicks), ep.UserData?.Played && 'Watched'].filter(Boolean).join(' · ')}
                </ThemedText>
              </View>
            </Pressable>
          </Link>
        ))}
      </View>
    </View>
  );
}

function EpisodeThumb({ item, width }: { item: BaseItem; width: number }) {
  const client = useJellyfin();
  const theme = useTheme();
  const uri = client.imageUrl(item, { height: 270 });
  const progress = item.UserData?.PlayedPercentage;
  return (
    <View style={[styles.thumb, { width, height: (width * 9) / 16, backgroundColor: theme.backgroundElement }]}>
      {uri ? <Image source={uri} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
      {progress ? (
        <View style={[styles.thumbProgress, { width: `${progress}%`, backgroundColor: theme.accent }]} />
      ) : null}
    </View>
  );
}

function FolderChildren({ parent }: { parent: BaseItem }) {
  const client = useJellyfin();
  const { width } = useWindowDimensions();
  const { data } = useAsync(() => client.children(parent.Id), parent.Id);
  if (!data?.length) return null;
  const cardWidth = (width - Spacing.three * 2 - Spacing.two * 2) / 3;
  if (data.length <= 12) return <ItemRow title="Items" items={data} />;
  return (
    <View style={[styles.section, styles.grid]}>
      {data.map((child) => (
        <PosterCard key={child.Id} item={child} width={cardWidth} />
      ))}
    </View>
  );
}

/** Trailers bundled with the file first; otherwise the first online one (usually YouTube). */
function Trailers({ item }: { item: BaseItem }) {
  const client = useJellyfin();
  const { data: local } = useAsync(
    () => (item.LocalTrailerCount ? client.localTrailers(item.Id).catch(() => []) : Promise.resolve([])),
    `trailers:${item.Id}`,
  );
  const remote = item.RemoteTrailers?.[0];
  if (local?.[0]) {
    const trailer = local[0];
    return (
      <Chip
        label="▶ Trailer"
        selected={false}
        onPress={() => router.push({ pathname: '/jellyfin/player/[id]', params: { id: trailer.Id, start: '0' } })}
      />
    );
  }
  if (remote) {
    return <Chip label="▶ Trailer" selected={false} onPress={() => WebBrowser.openBrowserAsync(remote.Url)} />;
  }
  return null;
}

const CREW_ROLES: { type: string; label: string }[] = [
  { type: 'Director', label: 'Directed by' },
  { type: 'Writer', label: 'Written by' },
];

function Crew({ people }: { people: Person[] | undefined }) {
  const lines = CREW_ROLES.map(({ type, label }) => {
    const names = people?.filter((p) => p.Type === type).map((p) => p.Name);
    return names?.length ? `${label} ${names.slice(0, 3).join(', ')}` : undefined;
  }).filter(Boolean);
  if (!lines.length) return null;
  return (
    <ThemedText type="small" themeColor="textSecondary">
      {lines.join('\n')}
    </ThemedText>
  );
}

function Cast({ people }: { people: Person[] | undefined }) {
  const client = useJellyfin();
  const theme = useTheme();
  const cast = people?.filter((p) => p.Type === 'Actor' || p.Type === 'GuestStar');
  if (!cast?.length) return null;
  return (
    <View style={styles.section}>
      <ThemedText type="smallBold" style={styles.sectionTitle}>
        Cast
      </ThemedText>
      <FlatList
        horizontal
        data={cast}
        keyExtractor={(p, i) => `${p.Id}:${i}`}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rowContent}
        renderItem={({ item: person }) => {
          const uri = client.personImageUrl(person);
          return (
            <Link href={{ pathname: '/jellyfin/item/[id]', params: { id: person.Id } }} asChild>
              <Pressable style={({ pressed }) => [styles.person, { opacity: pressed ? 0.6 : 1 }]}>
                <View style={[styles.personPhoto, { backgroundColor: theme.backgroundElement }]}>
                  {uri ? <Image source={uri} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} /> : null}
                </View>
                <ThemedText type="smallBold" numberOfLines={2} style={styles.personText}>
                  {person.Name}
                </ThemedText>
                {person.Role ? (
                  <ThemedText type="small" themeColor="textSecondary" numberOfLines={2} style={styles.personText}>
                    {person.Role}
                  </ThemedText>
                ) : null}
              </Pressable>
            </Link>
          );
        }}
      />
    </View>
  );
}

function Chapters({ item, onPlay }: { item: BaseItem; onPlay: (startTicks: number) => void }) {
  const client = useJellyfin();
  const chapters = item.Chapters ?? [];
  if (chapters.length < 2) return null;
  return (
    <View style={styles.section}>
      <ThemedText type="smallBold" style={styles.sectionTitle}>
        Chapters
      </ThemedText>
      <FlatList
        horizontal
        data={chapters}
        keyExtractor={(c, i) => `${i}:${c.StartPositionTicks}`}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rowContent}
        renderItem={({ item: chapter, index }) => (
          <Pressable onPress={() => onPlay(chapter.StartPositionTicks)} style={({ pressed }) => ({ width: 160, opacity: pressed ? 0.6 : 1 })}>
            <ChapterThumb uri={client.chapterImageUrl(item, index)} />
            <ThemedText type="smallBold" numberOfLines={1}>
              {chapter.Name || `Chapter ${index + 1}`}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {formatTimestamp(chapter.StartPositionTicks)}
            </ThemedText>
          </Pressable>
        )}
      />
    </View>
  );
}

function ChapterThumb({ uri }: { uri: string | undefined }) {
  const theme = useTheme();
  return (
    <View style={[styles.thumb, styles.chapterThumb, { backgroundColor: theme.backgroundElement }]}>
      {uri ? <Image source={uri} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
    </View>
  );
}

function formatTimestamp(ticks: number) {
  const total = Math.floor(ticks / TICKS_PER_SECOND);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function Similar({ item }: { item: BaseItem }) {
  const client = useJellyfin();
  const { data } = useAsync(() => client.similar(item.Id).catch(() => []), `similar:${item.Id}`);
  return <ItemRow title="More like this" items={data} />;
}

function Credits({ person }: { person: BaseItem }) {
  const client = useJellyfin();
  const { data } = useAsync(() => client.credits(person.Id).catch(() => []), `credits:${person.Id}`);
  return (
    <>
      <ItemRow title="Movies" items={data?.filter((i) => i.Type === 'Movie')} />
      <ItemRow title="Shows" items={data?.filter((i) => i.Type === 'Series')} />
    </>
  );
}

const styles = StyleSheet.create({
  sections: {
    gap: Spacing.four,
  },
  sectionTitle: {
    fontSize: 18,
    paddingHorizontal: Spacing.three,
  },
  rowContent: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.two + Spacing.one,
  },
  toggles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  tagline: {
    fontStyle: 'italic',
  },
  person: {
    width: 96,
    gap: 2,
  },
  personPhoto: {
    width: 96,
    height: 96,
    borderRadius: 48,
    overflow: 'hidden',
    marginBottom: Spacing.one,
  },
  personText: {
    textAlign: 'center',
  },
  chapterThumb: {
    width: 160,
    height: 90,
    marginBottom: Spacing.one,
  },
  body: {
    padding: Spacing.three,
    gap: Spacing.two,
  },
  title: {
    fontSize: 26,
    lineHeight: 32,
  },
  actions: {
    gap: Spacing.two,
    marginVertical: Spacing.two,
  },
  picker: {
    gap: Spacing.two,
    marginBottom: Spacing.two,
  },
  pickerChips: {
    gap: Spacing.two,
  },
  section: {
    gap: Spacing.three,
  },
  chips: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
  episodes: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.three,
  },
  episode: {
    flexDirection: 'row',
    gap: Spacing.three,
    alignItems: 'center',
  },
  thumb: {
    borderRadius: 6,
    overflow: 'hidden',
  },
  thumbProgress: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    height: 3,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
});
