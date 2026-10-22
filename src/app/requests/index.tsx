import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, FlatList, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered, SectionTitle, usePosterGrid, useRowCardWidth } from '@/miniapps/jellyfin/components';
import { useAsync } from '@/miniapps/jellyfin/use-async';
import {
  details,
  downloads,
  recentRequests,
  removeDownload,
  search,
  setSpeedLimit,
  speedLimit,
  titleOf,
  tmdbImage,
  upcoming,
  yearOf,
  type Download,
} from '@/miniapps/requests/api';
import { DownloadRow, formatSpeed, SpeedLimitRow, TitleCard, titleHref, UpcomingRow } from '@/miniapps/requests/components';
import type { Connection } from '@/miniapps/server/api';
import { Card } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { usePolling } from '@/miniapps/server/use-polling';

const QUEUE_POLL_MS = 5000;
/** Download limits to pick from, in bytes per second. 0 is no limit. */
const SPEED_LIMITS = [0, 1e6, 2e6, 5e6, 10e6, 20e6, 50e6];

export default function RequestsHome() {
  const { connection } = useServerConnection();
  const theme = useTheme();
  const gutter = useGutter();

  if (!connection) {
    return (
      <View style={[styles.empty, gutter, { backgroundColor: theme.background }]}>
        <ThemedText type="smallBold">Not connected</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
          Requests go through the home server. Connect the Server app first.
        </ThemedText>
        <Button title="Set up connection" onPress={() => router.push('/server/connect')} />
      </View>
    );
  }
  return <Home key={`${connection.url}|${connection.token}`} conn={connection} />;
}

function Home({ conn }: { conn: Connection }) {
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const searchBar = (
    <Stack.SearchBar
      placeholder="Find a movie or show"
      hideWhenScrolling={false}
      onChangeText={(e) => setQuery(e.nativeEvent.text)}
      onCancelButtonPress={() => setQuery('')}
    />
  );

  if (query.trim()) {
    return (
      <>
        {searchBar}
        <SearchResults conn={conn} term={term} />
      </>
    );
  }

  return (
    <>
      {searchBar}
      <Overview conn={conn} />
    </>
  );
}

function Overview({ conn }: { conn: Connection }) {
  const theme = useTheme();
  const gutter = useGutter();
  const queue = usePolling(() => downloads(conn), QUEUE_POLL_MS, conn.url);
  const limit = usePolling(() => speedLimit(conn), QUEUE_POLL_MS, conn.url);
  const rest = useAsync(() => Promise.all([upcoming(conn), requestedTitles(conn)]), 'overview');
  const [pulled, setPulled] = useState(false);
  if (pulled && !rest.loading) setPulled(false);

  // Pick up requests made on a title page.
  const focusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedOnce.current) rest.reload();
      focusedOnce.current = true;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rest.reload]),
  );

  const showActions = (d: Download) => {
    const options = [d.tmdbId ? 'Open title' : undefined, 'Remove', 'Remove and find another'].filter(
      (o): o is string => !!o,
    );
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: d.title,
        message: d.release,
        options: [...options, 'Cancel'],
        cancelButtonIndex: options.length,
        destructiveButtonIndex: [options.indexOf('Remove'), options.indexOf('Remove and find another')],
      },
      async (index) => {
        const choice = options[index];
        if (choice === 'Open title' && d.tmdbId) {
          router.push(titleHref(d.arr === 'sonarr' ? 'tv' : 'movie', d.tmdbId));
          return;
        }
        if (!choice) return;
        try {
          // Blocklisting the release makes Sonarr or Radarr search for a different one.
          await removeDownload(conn, d, choice === 'Remove and find another');
        } catch (e) {
          Alert.alert(`Couldn't remove ${d.title}`, e instanceof Error ? e.message : String(e));
        }
        await queue.refresh();
      },
    );
  };

  const pickSpeedLimit = (current: number) => {
    const labels = SPEED_LIMITS.map((l) => (l ? formatSpeed(l) : 'No limit'));
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'Download speed limit',
        message: 'For everything qBittorrent downloads.',
        options: [...labels, 'Cancel'],
        cancelButtonIndex: labels.length,
      },
      async (index) => {
        const next = SPEED_LIMITS[index];
        // qBittorrent keeps limits in whole KiB, so a pick comes back a little under.
        if (next === undefined || Math.abs(next - current) < 1024) return;
        try {
          await setSpeedLimit(conn, next);
        } catch (e) {
          Alert.alert("Couldn't change the speed limit", e instanceof Error ? e.message : String(e));
        }
        await limit.refresh();
      },
    );
  };

  if (!queue.data && !rest.data) {
    const error = queue.error ?? rest.error;
    return <Centered loading={!error} error={error} onRetry={rest.reload} />;
  }

  const [comingUp, requested] = rest.data ?? [];
  const active = queue.data ?? [];
  const nothing = !active.length && !comingUp?.length && !requested?.length;
  const speed = limit.data;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={pulled}
          onRefresh={() => {
            setPulled(true);
            rest.reload();
            queue.refresh();
            limit.refresh();
          }}
        />
      }>
      {queue.error ? (
        <ThemedText type="small" style={[gutter, { color: theme.danger }]}>
          {queue.error.message}
        </ThemedText>
      ) : null}

      {active.length || speed ? (
        <View style={styles.section}>
          <SectionTitle title="Downloading" />
          <View style={gutter}>
            <Card>
              {speed ? <SpeedLimitRow limit={speed} onPress={() => pickSpeedLimit(speed.limit)} /> : null}
              {active.map((d, i) => (
                <DownloadRow key={d.key} download={d} first={i === 0 && !speed} onPress={() => showActions(d)} />
              ))}
            </Card>
          </View>
        </View>
      ) : null}

      {comingUp?.length ? (
        <View style={styles.section}>
          <SectionTitle title="Coming up" />
          <View style={gutter}>
            <Card>
              {comingUp.map((u, i) => (
                <UpcomingRow key={u.key} item={u} first={i === 0} />
              ))}
            </Card>
          </View>
        </View>
      ) : null}

      {requested?.length ? <RequestedRow items={requested} /> : null}

      {nothing ? (
        <ThemedText themeColor="textSecondary" style={[styles.center, gutter]}>
          Nothing downloading or requested yet. Search for a movie or show to get started.
        </ThemedText>
      ) : null}
    </ScrollView>
  );
}

type RequestedTitle = Awaited<ReturnType<typeof requestedTitles>>[number];

/** Recent requests with their titles and posters, newest first, one per title. */
async function requestedTitles(conn: Connection) {
  const requests = await recentRequests(conn, 20);
  const seen = new Set<string>();
  const unique = requests.filter((r) => {
    const key = `${r.type}:${r.media.tmdbId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const titles = await Promise.all(
    unique.slice(0, 12).map(async (r) => {
      const d = await details(conn, r.type, r.media.tmdbId).catch(() => undefined);
      return d && { type: r.type, id: r.media.tmdbId, title: titleOf(d), year: yearOf(d), poster: d.posterPath, status: r.media.status };
    }),
  );
  return titles.filter((t) => t !== undefined);
}

function RequestedRow({ items }: { items: RequestedTitle[] }) {
  const gutter = useGutter();
  const width = useRowCardWidth('poster');
  return (
    <View style={styles.section}>
      <SectionTitle title="Recently requested" />
      <FlatList
        horizontal
        data={items}
        keyExtractor={(i) => `${i.type}:${i.id}`}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.rowContent, gutter]}
        renderItem={({ item }) => (
          <TitleCard
            type={item.type}
            id={item.id}
            title={item.title}
            year={item.year}
            posterUrl={tmdbImage(item.poster, 'w342')}
            status={item.status}
            width={width}
          />
        )}
      />
    </View>
  );
}

function SearchResults({ conn, term }: { conn: Connection; term: string }) {
  const theme = useTheme();
  const { columns, cardWidth, gutter } = usePosterGrid();
  const { data, error, loading, reload } = useAsync(
    () => (term ? search(conn, term) : Promise.resolve([])),
    `search:${term}`,
  );

  return (
    <FlatList
      key={columns}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.grid, gutter]}
      columnWrapperStyle={styles.gridRow}
      numColumns={columns}
      data={data ?? []}
      keyExtractor={(r) => `${r.mediaType}:${r.id}`}
      ListHeaderComponent={
        loading ? (
          <ActivityIndicator />
        ) : error ? (
          <Centered error={error} onRetry={reload} />
        ) : data && !data.length && term ? (
          <ThemedText themeColor="textSecondary" style={styles.center}>
            No results for “{term}”
          </ThemedText>
        ) : undefined
      }
      renderItem={({ item }) => (
        <TitleCard
          type={item.mediaType}
          id={item.id}
          title={titleOf(item)}
          year={yearOf(item)}
          posterUrl={tmdbImage(item.posterPath, 'w342')}
          status={item.mediaInfo?.status}
          width={cardWidth}
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  center: {
    textAlign: 'center',
  },
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.four,
  },
  section: {
    gap: Spacing.two,
  },
  rowContent: {
    gap: Spacing.two + Spacing.one,
  },
  grid: {
    paddingVertical: Spacing.three,
    gap: Spacing.three,
  },
  gridRow: {
    gap: Spacing.two,
  },
});
