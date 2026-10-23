import { Image } from 'expo-image';
import { Link, router, Stack, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { useReloadAfterChanges } from '@/miniapps/jellyfin/changes';
import { TICKS_PER_SECOND, type BaseItem, type Person, type UserData } from '@/miniapps/jellyfin/api';
import {
  Centered,
  Chip,
  formatRuntime,
  ItemRow,
  PosterCard,
  SectionTitle,
  usePosterGrid,
  useRowCardWidth,
} from '@/miniapps/jellyfin/components';
import { addToPlaylist, PlaylistEntries } from '@/miniapps/jellyfin/playlists';
import { playOnDevice } from '@/miniapps/jellyfin/remote-play';
import { useIsAdmin, useJellyfin } from '@/miniapps/jellyfin/session';
import { defaultSubtitleIndex, subtitleLabel, subtitleStreams, SUBTITLES_OFF } from '@/miniapps/jellyfin/subtitles';
import { useAsync } from '@/miniapps/jellyfin/use-async';

export default function ItemDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const client = useJellyfin();
  const theme = useTheme();
  const { width, height } = useWindowDimensions();
  const gutter = useGutter();
  const [selectedSubtitle, setSubtitle] = useState<number>();
  const isAdmin = useIsAdmin();
  const insets = useSafeAreaInsets();

  const { data: loaded, error, loading, reload } = useAsync(() => client.item(id), id);
  // Watched/favorite changes made here, laid over the item they were made on until a reload brings
  // a newer one; cleared any sooner, the old values would show while it loads.
  const [userData, setUserData] = useState<{ base: BaseItem; data: UserData }>();
  const item =
    loaded && userData?.base === loaded ? { ...loaded, UserData: { ...loaded.UserData, ...userData.data } } : loaded;

  // Pick up the new resume position after returning from the player.
  useReloadAfterChanges(reload);

  if (!item) return <Centered loading={loading} error={error} onRetry={reload} />;

  // A person's only picture is a portrait, which a wide banner would crop to the forehead.
  const backdrop =
    client.imageUrl(item, { type: 'Backdrop', height: 720 }) ??
    (item.Type === 'Person' ? undefined : client.imageUrl(item, { height: 720 }));
  const portrait = item.Type === 'Person' && !backdrop ? client.imageUrl(item, { height: 480 }) : undefined;
  const resumeTicks = item.UserData?.PlaybackPositionTicks ?? 0;
  // A playlist of videos has MediaType Video too, but it's played from its entries.
  const playable = item.MediaType === 'Video' && !item.IsFolder;
  const isPlaylist = item.Type === 'Playlist';
  const subtitles = subtitleStreams(item);
  const subtitle = selectedSubtitle ?? defaultSubtitleIndex(item);
  const toggle = async (change: (current: UserData) => Promise<UserData>) => {
    const base = loaded!;
    try {
      const data = await change(item.UserData ?? {});
      setUserData((prev) => ({ base, data: { ...(prev?.base === base ? prev.data : {}), ...data } }));
    } catch (e) {
      Alert.alert("Couldn't update", e instanceof Error ? e.message : String(e));
    }
  };
  const played = !!item.UserData?.Played;
  const favorite = !!item.UserData?.IsFavorite;
  const canMarkPlayed = playable || item.Type === 'Series' || item.Type === 'Season' || item.Type === 'BoxSet';
  const isPerson = item.Type === 'Person';
  const canAddToPlaylist = playable || item.Type === 'Series' || item.Type === 'Season' || item.Type === 'BoxSet';
  const canPlayOn = isAdmin && (playable || item.Type === 'Series' || item.Type === 'Season');

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
        // In landscape a full-width 16:9 image would fill the whole screen; keep the title in view.
        <Image source={backdrop} style={{ width, height: Math.min((width * 9) / 16, height * 0.6) }} contentFit="cover" />
      ) : (
        // Clear of the transparent header, whatever its height on this phone.
        <View style={[styles.noBackdrop, { paddingTop: insets.top + 56 }]}>
          {portrait ? <Image source={portrait} style={styles.portrait} contentFit="cover" /> : null}
        </View>
      )}
      <View style={[styles.body, gutter]}>
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

        {!isPerson && !isPlaylist ? (
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
            {canAddToPlaylist ? <Chip label="+ Playlist" selected={false} onPress={() => addToPlaylist(client, item)} /> : null}
            {canPlayOn ? <Chip label="Play on…" selected={false} onPress={() => playOnDevice(client, item)} /> : null}
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
        {item.Overview ? <ThemedText>{item.Overview}</ThemedText> : null}
        <Crew people={item.People} />
      </View>

      <View style={styles.sections}>
        {item.Type === 'Series' ? <SeriesEpisodes series={item} /> : null}
        {isPlaylist ? <PlaylistEntries playlist={item} /> : null}
        {item.IsFolder && item.Type !== 'Series' && !isPlaylist ? <FolderChildren parent={item} /> : null}
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
  const theme = useTheme();
  const { width, height } = useWindowDimensions();
  const gutter = useGutter();
  const [selectedSeasonId, setSeasonId] = useState<string>();

  const { data: seasons, error: seasonsError, reload: reloadSeasons } = useAsync(
    () => client.seasons(series.Id),
    series.Id,
  );
  const seasonId = selectedSeasonId ?? seasons?.[0]?.Id;

  const {
    data: episodes,
    error: episodesError,
    reload: reloadEpisodes,
  } = useAsync(
    () => (seasonId ? client.episodes(series.Id, seasonId) : Promise.resolve([])),
    `${series.Id}/${seasonId}`,
  );

  // Show what was just watched when coming back from the player.
  useReloadAfterChanges(reloadEpisodes);
  const error = seasonsError ?? episodesError;

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
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chips, gutter]}>
        {seasons?.map((s) => (
          <Chip key={s.Id} label={s.Name} selected={s.Id === seasonId} onPress={() => setSeasonId(s.Id)} />
        ))}
      </ScrollView>
      {error && !episodes ? (
        <View style={gutter}>
          <ThemedText type="small" themeColor="textSecondary">
            {error.message}{' '}
            <ThemedText type="small" style={{ color: theme.accent }} onPress={seasonsError ? reloadSeasons : reloadEpisodes}>
              Try again
            </ThemedText>
          </ThemedText>
        </View>
      ) : !episodes ? (
        <ActivityIndicator style={styles.episodesLoading} />
      ) : null}
      <View style={[styles.episodes, gutter]}>
        {episodes?.map((ep) => (
          <Link key={ep.Id} href={{ pathname: '/jellyfin/item/[id]', params: { id: ep.Id } }} asChild>
            <Pressable style={styles.episode} onLongPress={() => episodeActions(ep)}>
              <EpisodeThumb item={ep} width={Math.min(width, height) * 0.42} />
              <View style={{ flex: 1, gap: 2 }}>
                <ThemedText numberOfLines={2} style={styles.episodeTitle}>
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

const FOLDER_PREVIEW = 30;

function FolderChildren({ parent }: { parent: BaseItem }) {
  const client = useJellyfin();
  const { cardWidth, gutter } = usePosterGrid();
  const { data } = useAsync(() => client.children(parent.Id), parent.Id);
  if (!data?.length) return null;
  if (data.length <= 12) return <ItemRow title="Items" items={data} />;
  // A big folder would draw hundreds of posters at once here; the library screen scrolls them lazily.
  return (
    <View style={styles.section}>
      <View style={[styles.grid, gutter]}>
        {data.slice(0, FOLDER_PREVIEW).map((child) => (
          <PosterCard key={child.Id} item={child} width={cardWidth} />
        ))}
      </View>
      {data.length > FOLDER_PREVIEW ? (
        <View style={gutter}>
          <Button
            title={`Show all ${data.length}`}
            variant="secondary"
            onPress={() => router.push({ pathname: '/jellyfin/library/[id]', params: { id: parent.Id } })}
          />
        </View>
      ) : null}
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
  const gutter = useGutter();
  const cast = people?.filter((p) => p.Type === 'Actor' || p.Type === 'GuestStar');
  if (!cast?.length) return null;
  return (
    <View style={styles.section}>
      <SectionTitle title="Cast" />
      <FlatList
        horizontal
        data={cast}
        keyExtractor={(p, i) => `${p.Id}:${i}`}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.rowContent, gutter]}
        renderItem={({ item: person }) => {
          const uri = client.personImageUrl(person);
          return (
            // Not <Link asChild>, which drops function styles (see PosterCard).
            <Pressable
              onPress={() => router.push({ pathname: '/jellyfin/item/[id]', params: { id: person.Id } })}
              style={({ pressed }) => [styles.person, { opacity: pressed ? 0.6 : 1 }]}>
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
          );
        }}
      />
    </View>
  );
}

function Chapters({ item, onPlay }: { item: BaseItem; onPlay: (startTicks: number) => void }) {
  const client = useJellyfin();
  const gutter = useGutter();
  const chapterWidth = useRowCardWidth('wide') * 0.75;
  const chapters = item.Chapters ?? [];
  if (chapters.length < 2) return null;
  return (
    <View style={styles.section}>
      <SectionTitle title="Chapters" />
      <FlatList
        horizontal
        data={chapters}
        keyExtractor={(c, i) => `${i}:${c.StartPositionTicks}`}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.rowContent, gutter]}
        renderItem={({ item: chapter, index }) => (
          <Pressable onPress={() => onPlay(chapter.StartPositionTicks)} style={({ pressed }) => ({ width: chapterWidth, opacity: pressed ? 0.6 : 1 })}>
            <ChapterThumb uri={client.chapterImageUrl(item, index)} width={chapterWidth} />
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

function ChapterThumb({ uri, width }: { uri: string | undefined; width: number }) {
  const theme = useTheme();
  return (
    <View
      style={[styles.thumb, styles.chapterThumb, { width, height: (width * 9) / 16, backgroundColor: theme.backgroundElement }]}>
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
  rowContent: {
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
    width: 112,
    gap: 2,
  },
  personPhoto: {
    width: 112,
    height: 112,
    borderRadius: 56,
    overflow: 'hidden',
    marginBottom: Spacing.one,
  },
  personText: {
    textAlign: 'center',
  },
  chapterThumb: {
    marginBottom: Spacing.one,
  },
  body: {
    paddingVertical: Spacing.three,
    gap: Spacing.two,
  },
  title: {
    fontSize: 28,
    lineHeight: 34,
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
    gap: Spacing.two,
  },
  episodes: {
    gap: Spacing.three,
  },
  episodesLoading: {
    paddingVertical: Spacing.three,
  },
  noBackdrop: {
    alignItems: 'center',
    paddingBottom: Spacing.two,
  },
  portrait: {
    width: 160,
    height: 160,
    borderRadius: 80,
  },
  episode: {
    flexDirection: 'row',
    gap: Spacing.three,
    alignItems: 'center',
  },
  episodeTitle: {
    fontWeight: 600,
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
    gap: Spacing.two,
  },
});
