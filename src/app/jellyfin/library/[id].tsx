import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, useWindowDimensions } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { BaseItem } from '@/miniapps/jellyfin/api';
import { Centered, PosterCard } from '@/miniapps/jellyfin/components';
import { useJellyfin } from '@/miniapps/jellyfin/session';
import { useAsync } from '@/miniapps/jellyfin/use-async';

const COLUMNS = 3;

export default function Library() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const client = useJellyfin();
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const [more, setMore] = useState<BaseItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);

  const { data, error, loading, reload } = useAsync(async () => {
    setMore([]);
    const library = await client.item(id);
    const page = await client.libraryItems(library);
    return { library, ...page };
  }, id);

  const items = data ? [...data.Items, ...more] : [];
  const hasMore = data ? items.length < data.TotalRecordCount : false;

  const loadMore = useCallback(async () => {
    if (!data || !hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await client.libraryItems(data.library, items.length);
      setMore((prev) => [...prev, ...page.Items]);
    } finally {
      setLoadingMore(false);
    }
  }, [client, data, hasMore, loadingMore, items.length]);

  if (!data) return <Centered loading={loading} error={error} onRetry={reload} />;

  const cardWidth = (width - Spacing.three * 2 - Spacing.two * (COLUMNS - 1)) / COLUMNS;

  return (
    <>
      <Stack.Screen options={{ title: data.library.Name }} />
      <FlatList
        style={{ backgroundColor: theme.background }}
        contentInsetAdjustmentBehavior="automatic"
        data={items}
        keyExtractor={(i) => i.Id}
        numColumns={COLUMNS}
        columnWrapperStyle={styles.column}
        contentContainerStyle={styles.content}
        renderItem={({ item }) => <PosterCard item={item} width={cardWidth} />}
        onEndReached={loadMore}
        onEndReachedThreshold={1.5}
        ListFooterComponent={loadingMore ? <ActivityIndicator style={{ margin: Spacing.four }} /> : undefined}
      />
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.three,
    gap: Spacing.three,
  },
  column: {
    gap: Spacing.two,
  },
});
