import { Link, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { BaseItem } from '@/miniapps/jellyfin/api';
import { Centered, ItemRow } from '@/miniapps/jellyfin/components';
import { useJellyfin } from '@/miniapps/jellyfin/session';
import { useAsync } from '@/miniapps/jellyfin/use-async';

export default function JellyfinHome() {
  const client = useJellyfin();
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const { data, error, loading, reload } = useAsync(
    () =>
      Promise.all([client.resume(), client.nextUp(), client.libraries(), client.favorites().catch(() => [])]),
    'home',
  );

  // Refresh "Continue watching" when coming back from the player.
  const focusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedOnce.current) reload();
      focusedOnce.current = true;
    }, [reload]),
  );

  const header = (
    <Stack.Screen
      options={{
        headerRight: () => (
          <Link href="/jellyfin/settings" asChild>
            <Pressable hitSlop={12}>
              <ThemedText style={{ color: theme.accent }}>Settings</ThemedText>
            </Pressable>
          </Link>
        ),
      }}
    />
  );

  const searchBar = (
    <Stack.SearchBar
      placeholder="Movies, shows, episodes"
      hideWhenScrolling={false}
      onChangeText={(e) => setQuery(e.nativeEvent.text)}
      onCancelButtonPress={() => setQuery('')}
    />
  );

  if (query.trim()) {
    return (
      <>
        {header}
        {searchBar}
        <SearchResults term={term} />
      </>
    );
  }

  if (!data) {
    return (
      <>
        {header}
        {searchBar}
        <Centered loading={loading} error={error} onRetry={reload} />
      </>
    );
  }

  const [resume, nextUp, libraries, favorites] = data;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}>
      {header}
      {searchBar}
      <ItemRow title="Continue watching" items={resume} shape="wide" />
      <ItemRow title="Next up" items={nextUp} shape="wide" />
      <ItemRow title="Libraries" items={libraries} shape="wide" />
      <ItemRow title="Favorites" items={favorites} />
    </ScrollView>
  );
}

const SEARCH_GROUPS: { title: string; types: string[]; shape: 'poster' | 'wide' }[] = [
  { title: 'Movies', types: ['Movie'], shape: 'poster' },
  { title: 'Shows', types: ['Series'], shape: 'poster' },
  { title: 'Episodes', types: ['Episode'], shape: 'wide' },
  { title: 'Collections', types: ['BoxSet'], shape: 'poster' },
  { title: 'Music videos', types: ['MusicVideo'], shape: 'wide' },
];

function SearchResults({ term }: { term: string }) {
  const client = useJellyfin();
  const theme = useTheme();
  const { data, error, loading, reload } = useAsync(
    () => (term ? client.search(term) : Promise.resolve<BaseItem[]>([])),
    `search:${term}`,
  );

  const empty = !loading && data && !data.length && term;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.content}>
      {loading ? <ActivityIndicator /> : null}
      {error ? <Centered error={error} onRetry={reload} /> : null}
      {empty ? (
        <ThemedText themeColor="textSecondary" style={styles.empty}>
          No results for “{term}”
        </ThemedText>
      ) : null}
      {SEARCH_GROUPS.map((g) => (
        <ItemRow
          key={g.title}
          title={g.title}
          items={data?.filter((i) => g.types.includes(i.Type))}
          shape={g.shape}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  empty: {
    textAlign: 'center',
    paddingHorizontal: Spacing.four,
  },
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.four,
  },
});
