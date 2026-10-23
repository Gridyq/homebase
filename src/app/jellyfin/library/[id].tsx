import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Centered } from '@/components/centered';
import { Chip } from '@/components/chip';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { DEFAULT_LIBRARY_QUERY, type BaseItem, type ItemsResponse, type LibraryQuery, type LibrarySort } from '@/miniapps/jellyfin/api';
import { PosterCard, usePosterGrid } from '@/miniapps/jellyfin/components';
import { useJellyfin } from '@/miniapps/jellyfin/session';
import { useAsync } from '@/miniapps/jellyfin/use-async';

/** Sort options, each with the direction it starts in when picked. */
const SORTS: { sortBy: LibrarySort; label: string; descending: boolean }[] = [
  { sortBy: 'SortName', label: 'Name', descending: false },
  { sortBy: 'DateCreated', label: 'Date added', descending: true },
  { sortBy: 'PremiereDate', label: 'Release date', descending: true },
  { sortBy: 'CommunityRating', label: 'Rating', descending: true },
];

export default function Library() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const client = useJellyfin();
  const theme = useTheme();
  const { columns, cardWidth, gutter } = usePosterGrid();
  const [query, setQuery] = useState<LibraryQuery>(DEFAULT_LIBRARY_QUERY);
  // Pages loaded past the first, tagged with the first page they continue.
  const [more, setMore] = useState<{ after?: ItemsResponse; items: BaseItem[] }>({ items: [] });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<Error>();
  // onEndReached can fire twice before the state above has re-rendered.
  const inFlight = useRef(false);
  const [pulled, setPulled] = useState(false);

  const { data: library, error: libraryError, reload: reloadLibrary } = useAsync(() => client.item(id), id);
  const { data: genres } = useAsync(() => client.genres(id).catch(() => []), `genres:${id}`);

  const { data, error, loading, reload } = useAsync(
    async () => (library ? client.libraryItems(library, query) : undefined),
    `${library?.Id}:${JSON.stringify(query)}`,
  );

  // Pages fetched for an earlier sort or filter don't belong to this list.
  const items = useMemo(() => (data ? [...data.Items, ...(more.after === data ? more.items : [])] : []), [data, more]);
  const hasMore = data ? items.length < data.TotalRecordCount : false;

  if (pulled && !loading) setPulled(false);

  const loadMore = useCallback(async () => {
    if (!data || !library || !hasMore || inFlight.current || loading) return;
    inFlight.current = true;
    setLoadingMore(true);
    setMoreError(undefined);
    try {
      const page = await client.libraryItems(library, query, items.length);
      // Paged by position, so something added or removed meanwhile shifts the next page by that
      // much: leave out what's already listed.
      const listed = new Set(items.map((i) => i.Id));
      const fresh = page.Items.filter((i) => !listed.has(i.Id));
      setMore((prev) => ({ after: data, items: [...(prev.after === data ? prev.items : []), ...fresh] }));
    } catch (e) {
      setMoreError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      inFlight.current = false;
      setLoadingMore(false);
    }
  }, [client, data, library, query, hasMore, loading, items]);

  const renderItem = useCallback(
    ({ item }: { item: BaseItem }) => <PosterCard item={item} width={cardWidth} />,
    [cardWidth],
  );

  if (!library) return <Centered loading={!libraryError} error={libraryError} onRetry={reloadLibrary} />;

  const pickSort = (sort: (typeof SORTS)[number]) =>
    setQuery((q) =>
      // Tapping the current sort again flips its direction.
      q.sortBy === sort.sortBy
        ? { ...q, descending: !q.descending }
        : { ...q, sortBy: sort.sortBy, descending: sort.descending },
    );

  const filters = (
    <View style={styles.filters}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chips, gutter]}>
        {SORTS.map((sort) => {
          const selected = query.sortBy === sort.sortBy;
          return (
            <Chip
              key={sort.sortBy}
              label={selected ? `${sort.label} ${query.descending ? '↓' : '↑'}` : sort.label}
              selected={selected}
              onPress={() => pickSort(sort)}
            />
          );
        })}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chips, gutter]}>
        <Chip
          label="Unwatched"
          selected={query.unwatched}
          onPress={() => setQuery((q) => ({ ...q, unwatched: !q.unwatched }))}
        />
        <Chip
          label="Favorites"
          selected={query.favorites}
          onPress={() => setQuery((q) => ({ ...q, favorites: !q.favorites }))}
        />
        {genres?.map((g) => (
          <Chip
            key={g.Id}
            label={g.Name}
            selected={query.genreId === g.Id}
            onPress={() => setQuery((q) => ({ ...q, genreId: q.genreId === g.Id ? undefined : g.Id }))}
          />
        ))}
      </ScrollView>
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ title: library.Name }} />
      <FlatList
        style={{ backgroundColor: theme.background }}
        contentInsetAdjustmentBehavior="automatic"
        data={items}
        keyExtractor={(i) => i.Id}
        // numColumns can't change on a mounted FlatList, so remount when rotating changes it.
        key={columns}
        numColumns={columns}
        columnWrapperStyle={[styles.column, gutter]}
        contentContainerStyle={styles.content}
        renderItem={renderItem}
        // A failed page waits for "Try again" rather than retrying on every scroll.
        onEndReached={moreError ? undefined : loadMore}
        refreshControl={
          <RefreshControl
            refreshing={pulled}
            onRefresh={() => {
              setPulled(true);
              setMoreError(undefined);
              reload();
            }}
          />
        }
        onEndReachedThreshold={1.5}
        ListHeaderComponent={filters}
        ListEmptyComponent={
          !data && !error ? (
            <ActivityIndicator style={{ margin: Spacing.four }} />
          ) : error && !data ? (
            <Centered error={error} onRetry={reload} />
          ) : (
            <ThemedText themeColor="textSecondary" style={styles.empty}>
              Nothing matches these filters.
            </ThemedText>
          )
        }
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator style={{ margin: Spacing.four }} />
          ) : moreError ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
              Couldn&apos;t load more.{' '}
              <ThemedText type="small" style={{ color: theme.accent }} onPress={loadMore}>
                Try again
              </ThemedText>
            </ThemedText>
          ) : undefined
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.three,
  },
  column: {
    gap: Spacing.two,
  },
  filters: {
    gap: Spacing.two,
  },
  chips: {
    gap: Spacing.two,
  },
  empty: {
    textAlign: 'center',
    padding: Spacing.four,
  },
});
