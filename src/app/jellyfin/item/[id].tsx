import { Image } from 'expo-image';
import { Link, router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { TICKS_PER_SECOND, type BaseItem } from '@/miniapps/jellyfin/api';
import { Button, Centered, formatRuntime, ItemRow, PosterCard } from '@/miniapps/jellyfin/components';
import { useJellyfin } from '@/miniapps/jellyfin/session';
import { useAsync } from '@/miniapps/jellyfin/use-async';

export default function ItemDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const client = useJellyfin();
  const theme = useTheme();
  const { width } = useWindowDimensions();

  const { data: item, error, loading, reload } = useAsync(() => client.item(id), id);

  // Pick up the new resume position after returning from the player.
  const focusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedOnce.current) reload();
      focusedOnce.current = true;
    }, [reload]),
  );

  if (!item) return <Centered loading={loading} error={error} onRetry={reload} />;

  const backdrop = client.imageUrl(item, { type: 'Backdrop', height: 720 }) ?? client.imageUrl(item, { height: 720 });
  const resumeTicks = item.UserData?.PlaybackPositionTicks ?? 0;
  const playable = item.MediaType === 'Video';
  const meta = [
    item.Type === 'Episode' && item.SeriesName,
    item.ProductionYear,
    item.OfficialRating,
    formatRuntime(item.RunTimeTicks),
    item.CommunityRating && `★ ${item.CommunityRating.toFixed(1)}`,
  ].filter(Boolean);

  const play = (fromStart: boolean) =>
    router.push({
      pathname: '/jellyfin/player/[id]',
      params: { id: item.Id, start: fromStart ? '0' : String(resumeTicks / TICKS_PER_SECOND) },
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

        {playable ? (
          <View style={styles.actions}>
            {resumeTicks > 0 ? (
              <>
                <Button title={`Resume from ${formatRuntime(resumeTicks)}`} onPress={() => play(false)} />
                <Button title="Play from start" variant="secondary" onPress={() => play(true)} />
              </>
            ) : (
              <Button title="Play" onPress={() => play(true)} />
            )}
          </View>
        ) : null}

        {item.Overview ? <ThemedText type="small">{item.Overview}</ThemedText> : null}
      </View>

      {item.Type === 'Series' ? <SeriesEpisodes series={item} /> : null}
      {item.IsFolder && item.Type !== 'Series' ? <FolderChildren parent={item} /> : null}
      <View style={{ height: Spacing.six }} />
    </ScrollView>
  );
}

function SeriesEpisodes({ series }: { series: BaseItem }) {
  const client = useJellyfin();
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const [selectedSeasonId, setSeasonId] = useState<string>();

  const { data: seasons } = useAsync(() => client.seasons(series.Id), series.Id);
  const seasonId = selectedSeasonId ?? seasons?.[0]?.Id;

  const { data: episodes } = useAsync(
    () => (seasonId ? client.episodes(series.Id, seasonId) : Promise.resolve([])),
    `${series.Id}/${seasonId}`,
  );

  return (
    <View style={styles.section}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {seasons?.map((s) => (
          <Pressable
            key={s.Id}
            onPress={() => setSeasonId(s.Id)}
            style={[styles.chip, { backgroundColor: s.Id === seasonId ? theme.accent : theme.backgroundElement }]}>
            <ThemedText type="smallBold" style={{ color: s.Id === seasonId ? '#fff' : theme.text }}>
              {s.Name}
            </ThemedText>
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.episodes}>
        {episodes?.map((ep) => (
          <Link key={ep.Id} href={{ pathname: '/jellyfin/item/[id]', params: { id: ep.Id } }} asChild>
            <Pressable style={styles.episode}>
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

const styles = StyleSheet.create({
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
  section: {
    gap: Spacing.three,
  },
  chips: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: Spacing.three,
    borderRadius: 999,
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
