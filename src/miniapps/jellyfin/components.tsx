import { Image } from 'expo-image';
import { Link } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
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

export function PosterCard({ item, width, shape = 'poster' }: PosterProps) {
  const client = useJellyfin();
  const theme = useTheme();
  const aspect = shape === 'wide' ? 16 / 9 : 2 / 3;
  const height = width / aspect;
  const uri =
    shape === 'wide'
      ? (client.imageUrl(item, { type: 'Thumb', height: 360 }) ??
        client.imageUrl(item, { type: 'Backdrop', height: 360 }) ??
        client.imageUrl(item, { height: 360 }))
      : client.imageUrl(item, { height: 450 });
  const progress = item.UserData?.PlayedPercentage;
  const subtitle =
    item.Type === 'Episode'
      ? [item.SeriesName, episodeLabel(item)].filter(Boolean).join(' · ')
      : item.ProductionYear?.toString();

  return (
    <Link href={itemHref(item)} asChild>
      <Pressable style={({ pressed }) => [{ width, opacity: pressed ? 0.6 : 1 }]}>
        <View style={[styles.art, { height, backgroundColor: theme.backgroundElement }]}>
          {uri ? (
            <Image source={uri} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
          ) : (
            <ThemedText type="small" themeColor="textSecondary" style={styles.fallback} numberOfLines={3}>
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
    </Link>
  );
}

export function ItemRow({
  title,
  items,
  shape = 'poster',
}: {
  title: string;
  items: BaseItem[] | undefined;
  shape?: 'poster' | 'wide';
}) {
  if (!items?.length) return null;
  const width = shape === 'wide' ? 240 : 120;
  return (
    <View style={styles.row}>
      <ThemedText type="smallBold" style={styles.rowTitle}>
        {title}
      </ThemedText>
      <FlatList
        horizontal
        data={items}
        keyExtractor={(i) => i.Id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rowContent}
        renderItem={({ item }) => <PosterCard item={item} width={width} shape={shape} />}
      />
    </View>
  );
}

export function Centered({ loading, error, onRetry }: { loading?: boolean; error?: Error; onRetry?: () => void }) {
  const theme = useTheme();
  return (
    <View style={[styles.centered, { backgroundColor: theme.background }]}>
      {loading ? <ActivityIndicator /> : null}
      {error ? (
        <>
          <ThemedText themeColor="textSecondary" style={{ textAlign: 'center' }}>
            {error.message}
          </ThemedText>
          {onRetry ? <Button title="Try again" onPress={onRetry} /> : null}
        </>
      ) : null}
    </View>
  );
}

export function Button({
  title,
  onPress,
  disabled,
  variant = 'primary',
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
}) {
  const theme = useTheme();
  const primary = variant === 'primary';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: primary ? theme.accent : theme.backgroundElement,
          opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
        },
      ]}>
      <ThemedText type="smallBold" style={{ color: primary ? '#fff' : theme.text }}>
        {title}
      </ThemedText>
    </Pressable>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} style={[styles.chip, { backgroundColor: selected ? theme.accent : theme.backgroundElement }]}>
      <ThemedText type="smallBold" style={{ color: selected ? '#fff' : theme.text }}>
        {label}
      </ThemedText>
    </Pressable>
  );
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
    fontSize: 18,
    paddingHorizontal: Spacing.three,
  },
  rowContent: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.two + Spacing.one,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    gap: Spacing.three,
  },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: Spacing.three,
    borderRadius: 999,
  },
  button: {
    paddingVertical: 12,
    paddingHorizontal: Spacing.four,
    borderRadius: 10,
    alignItems: 'center',
  },
});
