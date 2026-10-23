import { Image } from 'expo-image';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import { useAsync } from '@/miniapps/jellyfin/use-async';
import {
  details,
  MediaStatus,
  qualityProfiles,
  requestMedia,
  titleOf,
  tmdbImage,
  yearOf,
  type Details,
  type MediaType,
  type Season,
} from '@/miniapps/requests/api';
import { statusBadge, StatusPill } from '@/miniapps/requests/components';
import type { Connection } from '@/miniapps/server/api';
import { Card } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';

/** Seasons that are neither on the server nor already asked for. */
const missing = (status: MediaStatus | undefined) =>
  !status || status === MediaStatus.Unknown || status === MediaStatus.Deleted;

export default function TitlePage() {
  const { type, id } = useLocalSearchParams<{ type: MediaType; id: string }>();
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const { width, height } = useWindowDimensions();
  const gutter = useGutter();
  const { data: item, error, loading, reload } = useAsync(() => details(conn, type, Number(id)), `${type}:${id}`);

  // Pick up a release grabbed on the releases screen.
  const focusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedOnce.current) reload();
      focusedOnce.current = true;
    }, [reload]),
  );

  if (!item) return <Centered loading={loading} error={error} onRetry={reload} />;

  const backdrop = tmdbImage(item.backdropPath, 'w1280') ?? tmdbImage(item.posterPath, 'w780');
  const runtime = item.runtime ?? item.episodeRunTime?.[0];
  const meta = [
    yearOf(item),
    type === 'tv' && item.seasons && `${realSeasons(item).length} seasons`,
    runtime && `${runtime}m`,
    item.voteAverage ? `★ ${item.voteAverage.toFixed(1)}` : undefined,
    item.genres?.slice(0, 3).map((g) => g.name).join(', '),
  ].filter(Boolean);

  return (
    <ScrollView style={{ backgroundColor: theme.background }} contentInsetAdjustmentBehavior="never">
      <Stack.Screen options={{ title: '', headerTransparent: true }} />
      {backdrop ? (
        <Image
          source={backdrop}
          style={{ width, height: Math.min((width * 9) / 16, height * 0.6) }}
          contentFit="cover"
        />
      ) : (
        <View style={{ height: 120 }} />
      )}
      <View style={[styles.body, gutter]}>
        <ThemedText type="subtitle" style={styles.title}>
          {titleOf(item)}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {meta.join(' · ')}
        </ThemedText>
        <StatusPill status={item.mediaInfo?.status} />
        {type === 'movie' ? (
          <MovieActions conn={conn} item={item} onChange={reload} />
        ) : (
          <SeasonPicker conn={conn} item={item} onChange={reload} />
        )}
        {item.tagline ? (
          <ThemedText type="smallBold" style={styles.tagline}>
            {item.tagline}
          </ThemedText>
        ) : null}
        {item.overview ? <ThemedText style={styles.overview}>{item.overview}</ThemedText> : null}
      </View>
    </ScrollView>
  );
}

function realSeasons(item: Details) {
  // Season 0 holds specials, which Seerr can't request.
  return (item.seasons ?? []).filter((s) => s.seasonNumber > 0);
}

function useRequest(conn: Connection, item: Details, type: MediaType, onDone: () => void) {
  const [sending, setSending] = useState(false);
  // The details it was requested from: the button stays busy until fresh ones replace them, or
  // it would offer the same request again in between.
  const [requestedFrom, setRequestedFrom] = useState<Details>();
  const [profileId, setProfileId] = useState<number>();
  const busy = sending || requestedFrom === item;
  const send = async (seasons?: number[]) => {
    if (busy) return;
    setSending(true);
    try {
      await requestMedia(conn, type, item.id, seasons, profileId);
      setRequestedFrom(item);
      onDone();
    } catch (e) {
      Alert.alert("Couldn't request it", e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };
  return { busy, send, profileId, setProfileId };
}

/** Which Sonarr or Radarr quality profile a request uses; smaller ones save disk space. */
function QualityRow({
  conn,
  type,
  profileId,
  onChange,
}: {
  conn: Connection;
  type: MediaType;
  profileId: number | undefined;
  onChange: (id: number | undefined) => void;
}) {
  const theme = useTheme();
  const { data: profiles, error, reload } = useAsync(
    () => qualityProfiles(conn, type === 'tv' ? 'sonarr' : 'radarr'),
    `profiles:${type}`,
  );
  if (!profiles?.length) {
    if (!error) return null;
    return (
      <Pressable onPress={reload} style={({ pressed }) => [styles.quality, { opacity: pressed ? 0.6 : 1 }]}>
        <ThemedText type="small" themeColor="textSecondary">
          Quality
        </ThemedText>
        <ThemedText type="small" style={{ color: theme.danger }}>
          Couldn&apos;t load · Try again
        </ThemedText>
      </Pressable>
    );
  }
  const pick = () => {
    const labels = ['Server default', ...profiles.map((p) => p.name)];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'Quality',
        message: 'Lower resolutions take far less space. The default is the one set in Seerr.',
        options: [...labels, 'Cancel'],
        cancelButtonIndex: labels.length,
      },
      (index) => {
        if (index === 0) onChange(undefined);
        else if (profiles[index - 1]) onChange(profiles[index - 1].id);
      },
    );
  };
  return (
    <Pressable onPress={pick} style={({ pressed }) => [styles.quality, { opacity: pressed ? 0.6 : 1 }]}>
      <ThemedText type="small" themeColor="textSecondary">
        Quality
      </ThemedText>
      <ThemedText type="small" style={{ color: theme.accent }}>
        {profiles.find((p) => p.id === profileId)?.name ?? 'Server default'} ▾
      </ThemedText>
    </Pressable>
  );
}

function releasesHref(app: 'sonarr' | 'radarr', id: number, title: string, season?: Season) {
  return {
    pathname: '/requests/releases',
    params: {
      app,
      id: String(id),
      title,
      ...(season ? { season: String(season.seasonNumber), episodes: String(season.episodeCount) } : {}),
    },
  } as const;
}

function MovieActions({ conn, item, onChange }: { conn: Connection; item: Details; onChange: () => void }) {
  const { busy, send, profileId, setProfileId } = useRequest(conn, item, 'movie', onChange);
  const status = item.mediaInfo?.status;
  const radarrId = item.mediaInfo?.externalServiceId;
  return (
    <View style={styles.actions}>
      {missing(status) ? (
        <>
          <Button title={busy ? 'Requesting…' : 'Request'} disabled={busy} onPress={() => send()} />
          <QualityRow conn={conn} type="movie" profileId={profileId} onChange={setProfileId} />
        </>
      ) : null}
      {radarrId ? (
        <Button
          title={status === MediaStatus.Available ? 'Find a better release' : 'Pick a release'}
          variant="secondary"
          onPress={() => router.push(releasesHref('radarr', radarrId, titleOf(item)))}
        />
      ) : null}
    </View>
  );
}

function SeasonPicker({ conn, item, onChange }: { conn: Connection; item: Details; onChange: () => void }) {
  const theme = useTheme();
  const { busy, send, profileId, setProfileId } = useRequest(conn, item, 'tv', onChange);
  const statusOf = (s: Season) => item.mediaInfo?.seasons?.find((x) => x.seasonNumber === s.seasonNumber)?.status;
  const seasons = realSeasons(item);
  const requestable = seasons.filter((s) => missing(statusOf(s)));
  // Everything missing is ticked to start with.
  const [unticked, setUnticked] = useState<Set<number>>(new Set());
  const chosen = requestable.filter((s) => !unticked.has(s.seasonNumber)).map((s) => s.seasonNumber);
  const sonarrId = item.mediaInfo?.externalServiceId;

  const toggle = (n: number) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  return (
    <View style={styles.actions}>
      {requestable.length ? (
        <Button
          title={
            busy
              ? 'Requesting…'
              : chosen.length === requestable.length && requestable.length === seasons.length
                ? 'Request all seasons'
                : `Request ${chosen.length} season${chosen.length === 1 ? '' : 's'}`
          }
          disabled={busy || !chosen.length}
          onPress={() => send(chosen)}
        />
      ) : null}
      {/* Seerr only uses the profile when it first adds the show to Sonarr. */}
      {requestable.length && !sonarrId ? (
        <QualityRow conn={conn} type="tv" profileId={profileId} onChange={setProfileId} />
      ) : null}
      <Card>
        {seasons.map((s, i) => {
          const status = statusOf(s);
          const canRequest = missing(status);
          const ticked = canRequest && !unticked.has(s.seasonNumber);
          const badge = statusBadge(status);
          return (
            <View
              key={s.seasonNumber}
              style={[styles.season, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected }]}>
              <Pressable
                disabled={!canRequest}
                onPress={() => toggle(s.seasonNumber)}
                style={({ pressed }) => [styles.seasonMain, { opacity: pressed ? 0.6 : 1 }]}>
                <View
                  style={[
                    styles.check,
                    { borderColor: canRequest ? theme.accent : theme.backgroundSelected },
                    ticked && { backgroundColor: theme.accent },
                  ]}>
                  {ticked ? <ThemedText style={styles.checkMark}>✓</ThemedText> : null}
                </View>
                <View style={styles.seasonText}>
                  <ThemedText type="smallBold">{s.name || `Season ${s.seasonNumber}`}</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
                    {[`${s.episodeCount} episodes`, s.airDate?.slice(0, 4), badge?.label].filter(Boolean).join(' · ')}
                  </ThemedText>
                </View>
              </Pressable>
              {sonarrId ? (
                <Pressable
                  hitSlop={8}
                  onPress={() => router.push(releasesHref('sonarr', sonarrId, `${titleOf(item)} · Season ${s.seasonNumber}`, s))}>
                  <ThemedText type="small" style={{ color: theme.accent }}>
                    Releases
                  </ThemedText>
                </Pressable>
              ) : null}
            </View>
          );
        })}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingVertical: Spacing.three,
    gap: Spacing.two,
  },
  title: {
    fontSize: 28,
    lineHeight: 34,
  },
  actions: {
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  quality: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.one,
  },
  tagline: {
    marginTop: Spacing.two,
  },
  overview: {
    lineHeight: 22,
  },
  season: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  seasonMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two + Spacing.one,
  },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkMark: {
    color: '#fff',
    fontSize: 13,
    lineHeight: 16,
    fontWeight: 700,
  },
  seasonText: {
    flex: 1,
    gap: Spacing.half,
  },
  caption: {
    fontSize: 13,
    lineHeight: 17,
  },
});
