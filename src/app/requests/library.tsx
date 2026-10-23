import { router } from 'expo-router';
import { useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Centered } from '@/components/centered';
import { Chip } from '@/components/chip';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';

import { useAsync } from '@/miniapps/jellyfin/use-async';
import { deleteFromLibrary, deleteSeason, library, mediaDisk, type LibraryItem } from '@/miniapps/requests/api';
import { Poster, titleHref } from '@/miniapps/requests/components';
import { Card, Meter, StatusColors } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { errorText } from '@/utils/error-text';
import { formatBytes } from '@/utils/format';

type Filter = 'all' | 'sonarr' | 'radarr';

/** Everything Sonarr and Radarr keep on the media drive, biggest first, to clear space. */
export default function Library() {
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string>();
  // Hidden as soon as they're deleted, rather than after the reload.
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const { data, error, loading, reload } = useAsync(
    () => Promise.all([library(conn), mediaDisk(conn).catch(() => undefined)]),
    'library',
  );
  const [pulled, setPulled] = useState(false);
  if (pulled && !loading) setPulled(false);
  // After deleting a season the row keeps its old size until the reload; stay busy until then.
  const [settling, setSettling] = useState(false);
  if (settling && !loading) {
    setSettling(false);
    setBusy(undefined);
  }

  if (!data) return <Centered loading={loading} error={error} onRetry={reload} />;
  const [items, disk] = data;
  const shown = items.filter((i) => (filter === 'all' || i.arr === filter) && !deleted.has(i.key));

  const remove = (item: LibraryItem, what: string, size: number, action: () => Promise<void>, whole: boolean) => {
    Alert.alert(`Delete ${what}?`, `This deletes ${formatBytes(size)} of files from the server.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setBusy(item.key);
          try {
            await action();
            if (whole) {
              setDeleted((d) => new Set(d).add(item.key));
              setBusy(undefined);
            } else {
              setSettling(true);
            }
          } catch (e) {
            setBusy(undefined);
            Alert.alert(`Couldn't delete ${what}`, errorText(e));
          }
          reload();
        },
      },
    ]);
  };

  const showActions = (item: LibraryItem) => {
    const show = item.arr === 'sonarr';
    // Deleting the last season with files is the same as deleting the show.
    const seasons = show && item.seasons.length > 1 ? item.seasons : [];
    const options = [
      item.tmdbId ? 'Open title' : undefined,
      ...seasons.map((s) => `Delete ${seasonName(s.seasonNumber)} (${formatBytes(s.size)})`),
      `Delete ${show ? 'show' : 'movie'} (${formatBytes(item.size)})`,
    ].filter((o): o is string => !!o);
    const firstDelete = item.tmdbId ? 1 : 0;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: item.title,
        message: show
          ? 'A deleted season is unmonitored so it isn’t downloaded again. Deleting the show removes it from Sonarr.'
          : 'Deleting the movie removes it from Radarr too.',
        options: [...options, 'Cancel'],
        cancelButtonIndex: options.length,
        destructiveButtonIndex: options.map((_, i) => i).slice(firstDelete),
      },
      (index) => {
        if (index >= options.length) return;
        if (index === 0 && item.tmdbId) {
          router.push(titleHref(show ? 'tv' : 'movie', item.tmdbId));
          return;
        }
        const season = seasons[index - firstDelete];
        if (season) {
          remove(item, `${item.title} ${seasonName(season.seasonNumber)}`, season.size, () =>
            deleteSeason(conn, item.id, season.seasonNumber),
            false,
          );
        } else {
          remove(item, item.title, item.size, () => deleteFromLibrary(conn, item), true);
        }
      },
    );
  };

  const used = items.reduce((sum, i) => sum + i.size, 0);
  const shows = items.filter((i) => i.arr === 'sonarr').length;

  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.list, gutter]}
      data={shown}
      keyExtractor={(i) => i.key}
      refreshControl={
        <RefreshControl
          refreshing={pulled}
          onRefresh={() => {
            setPulled(true);
            reload();
          }}
        />
      }
      ListHeaderComponent={
        <View style={styles.header}>
          <DiskCard used={used} disk={disk} />
          <View style={styles.chips}>
            <Chip label="All" selected={filter === 'all'} onPress={() => setFilter('all')} />
            <Chip label={`Shows ${shows}`} selected={filter === 'sonarr'} onPress={() => setFilter('sonarr')} />
            <Chip
              label={`Movies ${items.length - shows}`}
              selected={filter === 'radarr'}
              onPress={() => setFilter('radarr')}
            />
          </View>
        </View>
      }
      ListEmptyComponent={
        <ThemedText themeColor="textSecondary" style={styles.center}>
          Nothing here yet.
        </ThemedText>
      }
      renderItem={({ item }) => (
        <LibraryRow item={item} busy={busy === item.key} onPress={() => busy !== item.key && showActions(item)} />
      )}
    />
  );
}

const seasonName = (n: number) => (n === 0 ? 'Specials' : `Season ${n}`);

function DiskCard({ used, disk }: { used: number; disk?: { free: number; total: number } }) {
  const fraction = disk ? 1 - disk.free / disk.total : undefined;
  return (
    <Card>
      <View style={styles.disk}>
        <ThemedText type="smallBold">{formatBytes(used)} of shows and movies</ThemedText>
        {disk && fraction !== undefined ? (
          <>
            <Meter fraction={fraction} color={fraction > 0.9 ? StatusColors.warn : StatusColors.good} />
            <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
              {formatBytes(disk.free)} free of {formatBytes(disk.total)} on the media drive
            </ThemedText>
          </>
        ) : null}
      </View>
    </Card>
  );
}

function LibraryRow({
  item,
  busy,
  onPress,
}: {
  item: LibraryItem;
  busy: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const caption =
    item.arr === 'sonarr'
      ? item.seasons.map((s) => `S${s.seasonNumber} ${formatBytes(s.size)}`).join(' · ') || 'No episodes on disk'
      : item.size
        ? String(item.year ?? '')
        : 'Not downloaded yet';
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: theme.backgroundElement, opacity: pressed || busy ? 0.6 : 1 },
      ]}>
      <Poster uri={item.posterUrl} width={40} />
      <View style={styles.rowText}>
        <ThemedText type="smallBold" numberOfLines={1}>
          {item.title}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={2} style={styles.caption}>
          {busy ? 'Deleting…' : caption}
        </ThemedText>
      </View>
      <ThemedText type="smallBold" style={styles.size}>
        {formatBytes(item.size)}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingVertical: Spacing.three,
    gap: Spacing.two,
  },
  header: {
    gap: Spacing.three,
    marginBottom: Spacing.one,
  },
  chips: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  center: {
    textAlign: 'center',
  },
  disk: {
    gap: Spacing.one,
    paddingVertical: Spacing.two + Spacing.one,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    borderRadius: 14,
    padding: Spacing.two + Spacing.one,
  },
  rowText: {
    flex: 1,
    gap: Spacing.half,
  },
  caption: {
    fontSize: 13,
    lineHeight: 17,
  },
  size: {
    fontVariant: ['tabular-nums'],
  },
});
