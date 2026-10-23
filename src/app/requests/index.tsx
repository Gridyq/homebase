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
  checkDownloads,
  conversions,
  details,
  downloads,
  importAnyway,
  recentRequests,
  removeDownload,
  requestsMade,
  search,
  seeding,
  setSeeding,
  setSpeedLimit,
  speedLimit,
  titleOf,
  tmdbImage,
  upcoming,
  yearOf,
  type Download,
  type Seeding,
} from '@/miniapps/requests/api';
import { ConversionsRow, ConvertingRow, DownloadRow, SeedingRow, SpeedLimitRow, TitleCard, titleHref, UpcomingRow } from '@/miniapps/requests/components';
import { fetchGameMode, setGameMode, type Connection, type GameMode } from '@/miniapps/server/api';
import { Card } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { usePolling } from '@/miniapps/server/use-polling';

const QUEUE_POLL_MS = 5000;
/** Tdarr's file list is cached on the server for 15 s, so there's no point asking more often. */
const CONVERSIONS_POLL_MS = 10_000;
/** Download limits to pick from, in megabits per second to match the Server app. 0 is no limit. */
const SPEED_LIMITS_MBPS = [0, 10, 25, 50, 100, 200];

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
  // Loaded here rather than in Overview, so a search doesn't throw it away and start over.
  const overview = useOverview(conn);

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const header = (
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button icon="internaldrive" onPress={() => router.push('/requests/library')}>
        Library
      </Stack.Toolbar.Button>
      <Stack.Toolbar.Button
        icon="arrow.triangle.2.circlepath"
        onPress={() => router.push('/requests/conversions')}>
        Conversions
      </Stack.Toolbar.Button>
    </Stack.Toolbar>
  );

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
        {header}
        {searchBar}
        <SearchResults conn={conn} term={term} typing={query.trim() !== term} />
      </>
    );
  }

  return (
    <>
      {header}
      {searchBar}
      <Overview conn={conn} data={overview} />
    </>
  );
}

/** How long the Overview's titles stay fresh when nothing new was requested. */
const OVERVIEW_STALE_MS = 5 * 60_000;

function useOverview(conn: Connection) {
  const game = usePolling(() => fetchGameMode(conn), QUEUE_POLL_MS, conn.url);
  // Nothing else is asked for while game mode is on: Seerr would start up on the first call.
  // An older status server without game mode answers with an error; carry on then.
  const ready = !!game.error || game.data?.on === false;
  const queue = usePolling(() => downloads(conn), QUEUE_POLL_MS, conn.url, { enabled: ready });
  const limit = usePolling(() => speedLimit(conn), QUEUE_POLL_MS, conn.url, { enabled: ready });
  const seed = usePolling(() => seeding(conn), QUEUE_POLL_MS, conn.url, { enabled: ready });
  const convert = usePolling(() => conversions(conn), CONVERSIONS_POLL_MS, conn.url, { enabled: ready });
  const coming = useAsync(() => (ready ? upcoming(conn) : new Promise<never>(() => {})), `upcoming:${ready}`);
  const requested = useAsync(
    () => (ready ? requestedTitles(conn) : new Promise<never>(() => {})),
    `requested:${ready}`,
  );

  // Pick up requests made on a title page, and refresh now and then, without asking Seerr for a
  // dozen titles every time the screen comes back.
  const loaded = useRef<{ at: number; requests: number }>(undefined);
  const reloadTitles = useCallback(() => {
    loaded.current = { at: Date.now(), requests: requestsMade() };
    coming.reload();
    requested.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coming.reload, requested.reload]);
  useFocusEffect(
    useCallback(() => {
      // The first focus is the first load.
      if (!loaded.current) loaded.current = { at: Date.now(), requests: requestsMade() };
      const { at, requests } = loaded.current;
      if (requests !== requestsMade() || Date.now() - at > OVERVIEW_STALE_MS) reloadTitles();
    }, [reloadTitles]),
  );

  const refreshAll = useCallback(() => {
    reloadTitles();
    queue.refresh();
    limit.refresh();
    seed.refresh();
    convert.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadTitles]);

  return { game, queue, limit, seed, convert, coming, requested, refreshAll };
}

function Overview({ conn, data }: { conn: Connection; data: ReturnType<typeof useOverview> }) {
  const { game, queue, limit, seed, convert, coming, requested, refreshAll } = data;
  const theme = useTheme();
  const gutter = useGutter();
  const [pulled, setPulled] = useState(false);
  if (pulled && !coming.loading && !requested.loading) setPulled(false);
  // Downloads being acted on, with what's happening to them.
  const [working, setWorking] = useState<Record<string, string>>({});

  const showActions = (d: Download) => {
    if (working[d.key]) return;
    const finished = d.state === 'blocked' || d.state === 'importing';
    const options = [
      d.state === 'blocked' ? 'Import anyway' : undefined,
      finished ? 'Check again' : undefined,
      d.tmdbId ? 'Open title' : undefined,
      'Remove',
      'Remove and find another',
      d.arrId !== undefined ? 'Choose another release' : undefined,
    ].filter((o): o is string => !!o);
    const removals = ['Remove', 'Remove and find another'];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: d.title,
        message: [d.release, d.problem].filter(Boolean).join('\n\n'),
        options: [...options, 'Cancel'],
        cancelButtonIndex: options.length,
        destructiveButtonIndex: removals.map((r) => options.indexOf(r)).filter((i) => i >= 0),
      },
      async (index) => {
        const choice = options[index];
        if (!choice) return;
        if (choice === 'Open title' && d.tmdbId) {
          router.push(titleHref(d.arr === 'sonarr' ? 'tv' : 'movie', d.tmdbId));
          return;
        }
        if (choice === 'Choose another release' && d.arrId !== undefined) {
          // This one is only removed once another is picked, so backing out keeps it.
          router.push({
            pathname: '/requests/releases',
            params: {
              app: d.arr,
              id: String(d.arrId),
              title: d.title,
              replaces: d.queueIds.join(','),
              ...(d.arr === 'sonarr' && d.seasonNumber !== undefined ? { season: String(d.seasonNumber) } : {}),
            },
          });
          return;
        }
        setWorking((w) => ({
          ...w,
          [d.key]: choice === 'Import anyway' ? 'Importing…' : choice === 'Check again' ? 'Checking…' : 'Removing…',
        }));
        try {
          if (choice === 'Import anyway') {
            const { imported, skipped } = await importAnyway(conn, d);
            Alert.alert(
              'Importing',
              `${imported} file${imported === 1 ? '' : 's'} sent to ${d.arr === 'sonarr' ? 'Sonarr' : 'Radarr'}.` +
                (skipped ? ` ${skipped} skipped (samples, extras or not an upgrade).` : ''),
            );
          } else if (choice === 'Check again') {
            await checkDownloads(conn, d.arr);
          } else {
            // Blocklisting the release makes Sonarr or Radarr search for a different one.
            await removeDownload(conn, d, choice === 'Remove and find another');
          }
        } catch (e) {
          const failed = choice === 'Import anyway' ? 'import' : choice === 'Check again' ? 'check' : 'remove';
          Alert.alert(`Couldn't ${failed} ${d.title}`, e instanceof Error ? e.message : String(e));
        }
        await queue.refresh();
        setWorking((w) => {
          const { [d.key]: _done, ...rest } = w;
          return rest;
        });
      },
    );
  };

  const pickSpeedLimit = (current: number) => {
    const labels = SPEED_LIMITS_MBPS.map((l) => (l ? `${l} Mb/s` : 'No limit'));
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'Download speed limit',
        message: 'For everything qBittorrent downloads.',
        options: [...labels, 'Cancel'],
        cancelButtonIndex: labels.length,
      },
      async (index) => {
        const mbps = SPEED_LIMITS_MBPS[index];
        if (mbps === undefined) return;
        const next = mbps * 125_000; // qBittorrent wants bytes per second
        // qBittorrent keeps limits in whole KiB, so a pick comes back a little under.
        if (Math.abs(next - current) < 1024) return;
        try {
          await setSpeedLimit(conn, next);
        } catch (e) {
          Alert.alert("Couldn't change the speed limit", e instanceof Error ? e.message : String(e));
        }
        await limit.refresh();
      },
    );
  };

  const pickSeeding = (current: Seeding) => {
    const options = [
      current.seeding ? 'Stop seeding now' : undefined,
      current.stopped && !current.stopWhenDone ? 'Resume seeding' : undefined,
      current.stopWhenDone ? 'Keep seeding when done' : 'Always stop when done',
    ].filter((o): o is string => !!o);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'Seeding',
        message: current.stopWhenDone
          ? 'Torrents stop as soon as they finish downloading.'
          : 'Finished torrents keep uploading until you stop them.',
        options: [...options, 'Cancel'],
        cancelButtonIndex: options.length,
      },
      async (index) => {
        const choice = options[index];
        if (!choice) return;
        try {
          await setSeeding(
            conn,
            choice === 'Stop seeding now'
              ? { seed: false }
              : choice === 'Resume seeding'
                ? { seed: true }
                : // Stopping new ones as they finish should stop the ones seeding now too.
                  choice === 'Always stop when done'
                  ? { stopWhenDone: true, seed: false }
                  : { stopWhenDone: false },
          );
        } catch (e) {
          Alert.alert("Couldn't change seeding", e instanceof Error ? e.message : String(e));
        }
        await seed.refresh();
      },
    );
  };

  if (game.data?.on) {
    return (
      <GameModeNotice
        conn={conn}
        gameMode={game.data}
        onOff={async () => {
          // Turning it off lets everything else load.
          await game.refresh();
        }}
      />
    );
  }

  if (!queue.data && !coming.data && !requested.data) {
    const error = queue.error ?? coming.error ?? requested.error;
    return <Centered loading={!error} error={error} onRetry={refreshAll} />;
  }

  const comingUp = coming.data;
  const recent = requested.data;
  const active = queue.data ?? [];
  const nothing =
    !active.length && !comingUp?.length && !recent?.length && !queue.error && !coming.error && !requested.error;
  const speed = limit.data;
  const seeds = seed.data;
  // Tdarr may be stopped or not set up; then the section just doesn't show.
  const converting = convert.error ? undefined : convert.data;

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
            refreshAll();
          }}
        />
      }>
      {queue.error ? (
        <ThemedText type="small" style={[gutter, { color: theme.danger }]}>
          {queue.error.message}
        </ThemedText>
      ) : null}

      {active.length || speed || seeds ? (
        <View style={styles.section}>
          <SectionTitle title="Downloading" />
          <View style={gutter}>
            <Card>
              {speed ? <SpeedLimitRow limit={speed} onPress={() => pickSpeedLimit(speed.limit)} /> : null}
              {seeds ? <SeedingRow seeding={seeds} first={!speed} onPress={() => pickSeeding(seeds)} /> : null}
              {active.map((d, i) => (
                <DownloadRow
                  key={d.key}
                  download={d}
                  first={i === 0 && !speed && !seeds}
                  working={working[d.key]}
                  onPress={() => showActions(d)}
                />
              ))}
            </Card>
          </View>
        </View>
      ) : null}

      {converting && (converting.workers.length || converting.counts.queued) ? (
        <View style={styles.section}>
          <SectionTitle title="Converting" />
          <View style={gutter}>
            <Card>
              {converting.workers.map((w, i) => (
                <ConvertingRow key={w.file} worker={w} first={i === 0} />
              ))}
              <ConversionsRow
                conversions={converting}
                first={!converting.workers.length}
                onPress={() => router.push('/requests/conversions')}
              />
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
      ) : (
        <SectionError title="Coming up" error={coming.data ? undefined : coming.error} onRetry={coming.reload} />
      )}

      {recent?.length ? (
        <RequestedRow items={recent} />
      ) : (
        <SectionError
          title="Recently requested"
          error={requested.data ? undefined : requested.error}
          onRetry={requested.reload}
        />
      )}

      {nothing ? (
        <ThemedText themeColor="textSecondary" style={[styles.center, gutter]}>
          Nothing downloading or requested yet. Search for a movie or show to get started.
        </ThemedText>
      ) : null}
    </ScrollView>
  );
}

/** A section that couldn't load, with a way to try again. */
function SectionError({ title, error, onRetry }: { title: string; error: Error | undefined; onRetry: () => void }) {
  const theme = useTheme();
  const gutter = useGutter();
  if (!error) return null;
  return (
    <View style={styles.section}>
      <SectionTitle title={title} />
      <ThemedText type="small" style={[gutter, { color: theme.danger }]}>
        {error.message}{' '}
        <ThemedText type="small" style={{ color: theme.accent }} onPress={onRetry}>
          Try again
        </ThemedText>
      </ThemedText>
    </View>
  );
}

function GameModeNotice({ conn, gameMode, onOff }: { conn: Connection; gameMode: GameMode; onOff: () => Promise<void> }) {
  const theme = useTheme();
  const gutter = useGutter();
  const [busy, setBusy] = useState(false);
  const turnOff = async () => {
    setBusy(true);
    try {
      await setGameMode(conn, false);
      await onOff();
    } catch (e) {
      Alert.alert("Couldn't turn game mode off", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={[styles.empty, gutter, { backgroundColor: theme.background }]}>
      <ThemedText type="smallBold">Game mode is on</ThemedText>
      <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
        {gameMode.manual || !gameMode.game
          ? 'Downloads and requests are stopped to leave memory for games.'
          : `Downloads and requests are stopped while ${gameMode.game} runs, and come back shortly after it closes.`}
      </ThemedText>
      {busy ? <ActivityIndicator /> : <Button title="Turn off game mode" onPress={turnOff} />}
    </View>
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

function SearchResults({ conn, term, typing }: { conn: Connection; term: string; typing: boolean }) {
  const theme = useTheme();
  const { columns, cardWidth, gutter } = usePosterGrid();
  const { data, error, loading, reload } = useAsync(
    () => (term ? search(conn, term) : Promise.resolve([])),
    `search:${term}`,
  );
  const waiting = typing || loading;

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
        waiting ? (
          <Searching />
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

/** Seerr is stopped when idle, and the first search after that waits for it to start. */
function Searching() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <View style={styles.searching}>
      <ActivityIndicator />
      {slow ? (
        <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
          Waking Seerr up. The first search takes a few seconds.
        </ThemedText>
      ) : null}
    </View>
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
  searching: {
    gap: Spacing.two,
  },
});
