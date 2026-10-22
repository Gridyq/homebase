import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { DEFAULT_LIBRARY_QUERY, type BaseItem, type ItemsResponse, type LibraryQuery, type LibrarySort } from '@/miniapps/jellyfin/api';
import { Centered, Chip, PosterCard } from '@/miniapps/jellyfin/components';
import { useJellyfin } from '@/miniapps/jellyfin/session';
import { useAsync } from '@/miniapps/jellyfin/use-async';

const COLUMNS = 3;

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
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState<LibraryQuery>(DEFAULT_LIBRARY_QUERY);
  // Pages loaded past the first, tagged with the first page they continue.
  const [more, setMore] = useState<{ after?: ItemsResponse; items: BaseItem[] }>({ items: [] });
  const [loadingMore, setLoadingMore] = useState(false);

  const { data: library, error: libraryError, reload: reloadLibrary } = useAsync(() => client.item(id), id);
  const { data: genres } = useAsync(() => client.genres(id).catch(() => []), `genres:${id}`);

  const { data, error, loading, reload } = useAsync(
    async () => (library ? client.libraryItems(library, query) : undefined),
    `${library?.Id}:${JSON.stringify(query)}`,
  );

  // Pages fetched for an earlier sort or filter don't belong to this list.
  const items = data ? [...data.Items, ...(more.after === data ? more.items : [])] : [];
  const hasMore = data ? items.length < data.TotalRecordCount : false;

  const loadMore = useCallback(async () => {
    if (!data || !library || !hasMore || loadingMore || loading) return;
    setLoadingMore(true);
    try {
      const page = await client.libraryItems(library, query, items.length);
      setMore((prev) => ({ after: data, items: [...(prev.after === data ? prev.items : []), ...page.Items] }));
    } finally {
      setLoadingMore(false);
    }
  }, [client, data, library, query, hasMore, loadingMore, loading, items.length]);

  if (!library) return <Centered loading={!libraryError} error={libraryError} onRetry={reloadLibrary} />;

  const cardWidth = (width - Spacing.three * 2 - Spacing.two * (COLUMNS - 1)) / COLUMNS;

  const pickSort = (sort: (typeof SORTS)[number]) =>
    setQuery((q) =>
      // Tapping the current sort again flips its direction.
      q.sortBy === sort.sortBy
        ? { ...q, descending: !q.descending }
        : { ...q, sortBy: sort.sortBy, descending: sort.descending },
    );

  const filters = (
    <View style={styles.filters}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
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
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
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
        data={loading ? [] : items}
        keyExtractor={(i) => i.Id}
        numColumns={COLUMNS}
        columnWrapperStyle={styles.column}
        contentContainerStyle={styles.content}
        renderItem={({ item }) => <PosterCard item={item} width={cardWidth} />}
        onEndReached={loadMore}
        onEndReachedThreshold={1.5}
        ListHeaderComponent={filters}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={{ margin: Spacing.four }} />
          ) : error ? (
            <Centered error={error} onRetry={reload} />
          ) : (
            <ThemedText themeColor="textSecondary" style={styles.empty}>
              Nothing matches these filters.
            </ThemedText>
          )
        }
        ListFooterComponent={loadingMore ? <ActivityIndicator style={{ margin: Spacing.four }} /> : undefined}
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
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
  filters: {
    gap: Spacing.two,
  },
  chips: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
  empty: {
    textAlign: 'center',
    padding: Spacing.four,
  },
});
