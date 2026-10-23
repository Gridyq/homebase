import { Image } from 'expo-image';
import { router } from 'expo-router';
import { memo } from 'react';
import { FlatList, PixelRatio, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';

import { TICKS_PER_SECOND, type BaseItem } from './api';
import { useJellyfin } from './session';

export function formatRuntime(ticks?: number) {
  if (!ticks) return undefined;
  const minutes = Math.round(ticks / TICKS_PER_SECOND / 60);
  const h = Math.floor(minutes / 60);
  return h ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}

export function episodeLabel(item: BaseItem) {
  if (item.Type !== 'Episode') return undefined;
  const s = item.ParentIndexNumber;
  const e = item.IndexNumber;
  return s != null && e != null ? `S${s}:E${e}` : undefined;
}

export function itemHref(item: BaseItem) {
  if (item.Type === 'CollectionFolder' || item.Type === 'UserView') {
    return { pathname: '/jellyfin/library/[id]', params: { id: item.Id } } as const;
  }
  return { pathname: '/jellyfin/item/[id]', params: { id: item.Id } } as const;
}

type PosterProps = {
  item: BaseItem;
  width: number;
  /** "wide" for 16:9 thumbnails (continue watching, episodes, libraries). */
  shape?: 'poster' | 'wide';
};

/** Memoized: a library grid re-renders every card on each page it loads otherwise. */
export const PosterCard = memo(function PosterCard({ item, width, shape = 'poster' }: PosterProps) {
  const client = useJellyfin();
  const theme = useTheme();
  const aspect = shape === 'wide' ? 16 / 9 : 2 / 3;
  const height = width / aspect;
  // Ask for the image at the size it's drawn on screen, so it's sharp on 3x displays.
  const pixels = PixelRatio.getPixelSizeForLayoutSize(height);
  const uri =
    shape === 'wide'
      ? (client.imageUrl(item, { type: 'Thumb', height: pixels }) ??
        client.imageUrl(item, { type: 'Backdrop', height: pixels }) ??
        client.imageUrl(item, { height: pixels }))
      : client.imageUrl(item, { height: pixels });
  const progress = item.UserData?.PlayedPercentage;
  const subtitle =
    item.Type === 'Episode'
      ? [item.SeriesName, episodeLabel(item)].filter(Boolean).join(' · ')
      : item.ProductionYear?.toString();

  return (
    // Not <Link asChild>: it flattens the child's style, which drops a function style like
    // this one (and with it the width), so the card would shrink to fit its text.
    <Pressable
      onPress={() => router.push(itemHref(item))}
      style={({ pressed }) => [{ width, opacity: pressed ? 0.6 : 1 }]}>
      <View style={[styles.art, { height, backgroundColor: theme.backgroundElement }]}>
        {uri ? (
          <Image source={uri} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
        ) : (
          <ThemedText
            type={shape === 'wide' ? 'default' : 'small'}
            themeColor="textSecondary"
            style={[styles.fallback, shape === 'wide' && styles.fallbackWide]}
            numberOfLines={3}>
            {item.Name}
          </ThemedText>
        )}
        {progress ? (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress}%`, backgroundColor: theme.accent }]} />
          </View>
        ) : null}
      </View>
      <ThemedText type="smallBold" numberOfLines={1} style={styles.title}>
        {item.Type === 'Episode' && item.SeriesName ? item.SeriesName : item.Name}
      </ThemedText>
      {subtitle && item.Type !== 'Episode' ? (
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
          {subtitle}
        </ThemedText>
      ) : item.Type === 'Episode' ? (
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
          {[episodeLabel(item), item.Name].filter(Boolean).join(' · ')}
        </ThemedText>
      ) : null}
    </Pressable>
  );
});

export const ItemRow = memo(function ItemRow({
  title,
  items,
  shape = 'poster',
}: {
  title: string;
  items: BaseItem[] | undefined;
  shape?: 'poster' | 'wide';
}) {
  const gutter = useGutter();
  const cardWidth = useRowCardWidth(shape);
  if (!items?.length) return null;
  return (
    <View style={styles.row}>
      <SectionTitle title={title} />
      <FlatList
        horizontal
        data={items}
        keyExtractor={(i) => i.Id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.rowContent, gutter]}
        renderItem={({ item }) => <PosterCard item={item} width={cardWidth} shape={shape} />}
      />
    </View>
  );
});

/**
 * Card width for horizontal rows: about 3 posters or 1.4 wide cards across a phone in portrait,
 * so they grow on bigger phones, capped so landscape doesn't blow them up.
 */
export function useRowCardWidth(shape: 'poster' | 'wide') {
  const { width, height } = useWindowDimensions();
  const portraitWidth = Math.min(width, height);
  return shape === 'wide' ? Math.min(portraitWidth * 0.7, 340) : Math.min(portraitWidth * 0.3, 160);
}

/** Poster grid that fits 3 columns on a phone in portrait and more as the screen gets wider. */
export function usePosterGrid() {
  const { width } = useWindowDimensions();
  const gutter = useGutter();
  const available = width - gutter.paddingLeft - gutter.paddingRight;
  const columns = Math.max(3, Math.floor(available / 160));
  const cardWidth = (available - Spacing.two * (columns - 1)) / columns;
  return { columns, cardWidth, gutter };
}

export function SectionTitle({ title }: { title: string }) {
  const gutter = useGutter();
  return <ThemedText style={[styles.rowTitle, gutter]}>{title}</ThemedText>;
}

const styles = StyleSheet.create({
  art: {
    borderRadius: 8,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  fallback: {
    textAlign: 'center',
    padding: Spacing.two,
  },
  fallbackWide: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: 700,
  },
  progressTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 4,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  progressFill: {
    height: 4,
  },
  title: {
    marginTop: Spacing.one,
  },
  row: {
    gap: Spacing.two,
  },
  rowTitle: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: 700,
  },
  rowContent: {
    gap: Spacing.two + Spacing.one,
  },
});
