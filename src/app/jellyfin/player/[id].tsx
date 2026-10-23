import { useEventListener } from 'expo';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useVideoPlayer, VideoView, type AudioTrack, type VideoPlayer, type VideoSource } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { TICKS_PER_SECOND, type BaseItem, type JellyfinClient } from '@/miniapps/jellyfin/api';
import { episodeLabel } from '@/miniapps/jellyfin/components';
import { clearLastPlayed, saveLastPlayed } from '@/miniapps/jellyfin/last-played';
import { useJellyfin } from '@/miniapps/jellyfin/session';
import { PlayerControls, type ControlAction } from '@/miniapps/jellyfin/player-controls';
import { currentMaxBitrate, useJellyfinSettings } from '@/miniapps/jellyfin/settings';
import {
  SUBTITLES_OFF,
  subtitleIndexForLanguage,
  subtitleLabel,
  subtitleLanguage,
  subtitleStreams,
} from '@/miniapps/jellyfin/subtitles';
import { useAsync } from '@/miniapps/jellyfin/use-async';

const PROGRESS_INTERVAL_SECONDS = 10;
const UP_NEXT_SECONDS = 10;

// A full-screen modal gets the insets of the screen under it, which stay portrait when the
// phone turns, so the controls measure this screen's own edges instead.
export default function PlayerScreen() {
  return (
    <SafeAreaProvider>
      <PlayerLoader />
    </SafeAreaProvider>
  );
}

function PlayerLoader() {
  const { id, start, subtitle, subtitleLang, playlist } = useLocalSearchParams<{
    id: string;
    start?: string;
    /** Subtitle stream index picked on the item screen. */
    subtitle?: string;
    /** Subtitle language carried over from the previous episode, or "off". */
    subtitleLang?: string;
    /** Playing through a playlist: what comes next is the playlist's next entry. */
    playlist?: string;
  }>();
  const client = useJellyfin();
  const { settings } = useJellyfinSettings();
  const { data, error, reload } = useAsync(async () => {
    const item = await client.item(id);
    const subtitleIndex =
      subtitle !== undefined
        ? Number(subtitle)
        : subtitleLang
          ? subtitleIndexForLanguage(item, subtitleLang)
          : undefined;
    const maxBitrate = await currentMaxBitrate(settings);
    const [playback, next] = await Promise.all([
      client.playbackInfo(id, subtitleIndex, maxBitrate),
      playlist
        ? client.playlistItems(playlist).then((items) => nextInPlaylist(items, id), () => undefined)
        : item.Type === 'Episode'
          ? client.nextEpisode(item).catch(() => undefined)
          : undefined,
    ]);
    return { item, playback: { ...playback, subtitleIndex }, next };
  }, `${id}/${subtitle}/${playlist}`);

  if (!data) {
    return (
      <Shell>
        {error ? (
          <View style={styles.error}>
            <ThemedText style={styles.light}>{error.message}</ThemedText>
            <Button title="Try again" onPress={reload} />
          </View>
        ) : (
          <ActivityIndicator color="#fff" />
        )}
      </Shell>
    );
  }

  return <Player client={client} {...data} playlist={playlist} startSeconds={Number(start) || 0} />;
}

/** The first video after this item in a playlist. */
function nextInPlaylist(items: BaseItem[], currentId: string) {
  const at = items.findIndex((i) => i.Id === currentId);
  return at < 0 ? undefined : items.slice(at + 1).find((i) => i.MediaType === 'Video');
}

type Playback = Awaited<ReturnType<JellyfinClient['playbackInfo']>> & { subtitleIndex?: number };

function Player({
  client,
  item,
  playback,
  next,
  playlist,
  startSeconds,
}: {
  client: JellyfinClient;
  item: BaseItem;
  playback: Playback;
  next: BaseItem | undefined;
  playlist: string | undefined;
  startSeconds: number;
}) {
  const viewRef = useRef<VideoView>(null);
  /** Handed over to the iOS player (for AirPlay and its menus); our controls are hidden meanwhile. */
  const [systemPlayer, setSystemPlayer] = useState(false);
  const [ended, setEnded] = useState(false);
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const started = useRef(false);
  const position = useRef(startSeconds);
  const lastReport = useRef(0);
  const finished = useRef(false);

  const source: VideoSource = {
    uri: playback.url,
    metadata: {
      title: item.Name,
      artist: item.SeriesName ?? item.ProductionYear?.toString(),
      artwork: client.imageUrl(item, { height: 600 }),
    },
  };

  const player = useVideoPlayer(source, (p) => {
    p.staysActiveInBackground = true;
    p.showNowPlayingNotification = true;
    // Often enough for the controls' clock; the server only hears every PROGRESS_INTERVAL_SECONDS.
    p.timeUpdateEventInterval = 0.5;
    // Start (and resume after a seek) as soon as there's a picture, instead of AVPlayer's default
    // of buffering ahead first; the server sends segments well faster than real time.
    p.bufferOptions = { waitsToMinimizeStalling: false };
  });

  const trickplay = client.trickplay(item, playback.mediaSourceId);

  const report = (phase: 'start' | 'progress' | 'stopped', isPaused = false) => {
    lastReport.current = Date.now();
    return client.reportPlayback(phase, {
      ItemId: item.Id,
      MediaSourceId: playback.mediaSourceId,
      PlaySessionId: playback.playSessionId,
      PositionTicks: Math.round(position.current * TICKS_PER_SECOND),
      PlayMethod: playback.playMethod,
      IsPaused: isPaused,
    });
  };

  // Played directly, the file's own subtitle tracks are all there to pick from; otherwise the
  // chosen one arrives as the only track in the HLS stream. Either way, switch it on once, when
  // it shows up, and leave later changes in the system menu alone.
  const directSubtitles = playback.embeddedSubtitles;
  const chosenSubtitle = useRef(
    directSubtitles ? (playback.subtitleIndex ?? playback.defaultSubtitleIndex ?? SUBTITLES_OFF) : playback.subtitleIndex,
  );
  const subtitleApplied = useRef(false);
  const applySubtitle = () => {
    if (subtitleApplied.current) return;
    if (directSubtitles) {
      if (player.availableSubtitleTracks.length < directSubtitles.length) return;
      showEmbeddedSubtitleTrack(player, directSubtitles, chosenSubtitle.current);
      subtitleApplied.current = true;
      return;
    }
    if ((playback.subtitleIndex ?? -1) < 0) return;
    subtitleApplied.current = showFirstSubtitleTrack(player);
  };
  useEventListener(player, 'availableSubtitleTracksChange', applySubtitle);
  useEventListener(player, 'availableAudioTracksChange', ({ availableAudioTracks }) => setAudioTracks(availableAudioTracks));

  useEventListener(player, 'statusChange', ({ status }) => {
    if (status !== 'readyToPlay' || started.current) return;
    started.current = true;
    if (startSeconds > 0) player.seekBy(startSeconds);
    player.play();
    report('start');
    applySubtitle();
  });

  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    position.current = currentTime;
    if (Date.now() - lastReport.current >= PROGRESS_INTERVAL_SECONDS * 1000) report('progress', !player.playing);
  });

  useEventListener(player, 'playingChange', ({ isPlaying }) => {
    position.current = player.currentTime;
    report('progress', !isPlaying);
  });

  useEventListener(player, 'playToEnd', () => {
    position.current = player.duration;
    finished.current = true;
    if (!next) {
      router.back();
      return;
    }
    viewRef.current?.exitFullscreen().catch(() => undefined);
    setEnded(true);
  });

  const lang = () => subtitleLanguage(item, chosenSubtitle.current);
  const playNext = () => {
    if (!next) return;
    const l = lang();
    router.replace({
      pathname: '/jellyfin/player/[id]',
      params: { id: next.Id, start: '0', ...(l ? { subtitleLang: l } : {}), ...(playlist ? { playlist } : {}) },
    });
  };

  // Tell the server where we stopped so "Continue watching" is up to date, and remember it for the
  // launcher's Resume shortcut (or the next episode, once this one is done).
  useEffect(() => {
    return () => {
      if (!started.current) return;
      report('stopped');
      const l = lang();
      if (!finished.current) saveLastPlayed(item, position.current, l);
      else if (next) saveLastPlayed(next, 0, l);
      else clearLastPlayed();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickSubtitles = () => {
    const streams = subtitleStreams(item);
    const choices = [{ index: SUBTITLES_OFF, label: 'Off' }, ...streams.map((s) => ({ index: s.Index, label: subtitleLabel(s) }))];
    const current = player.subtitleTrack ? chosenSubtitle.current : SUBTITLES_OFF;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'Subtitles',
        options: [...choices.map((c) => (c.index === current ? `✓ ${c.label}` : c.label)), 'Cancel'],
        cancelButtonIndex: choices.length,
      },
      (i) => {
        const choice = choices[i];
        if (!choice || choice.index === current) return;
        if (choice.index === SUBTITLES_OFF) {
          player.subtitleTrack = null;
          chosenSubtitle.current = SUBTITLES_OFF;
          return;
        }
        const track = directSubtitles
          ? embeddedSubtitleTrack(player, directSubtitles, choice.index)
          : choice.index === playback.subtitleIndex
            ? (player.subtitleTrack ?? player.availableSubtitleTracks[0] ?? null)
            : null;
        if (track) {
          player.subtitleTrack = track;
          chosenSubtitle.current = choice.index;
          return;
        }
        // The stream only carries the subtitle asked for, so another one means asking again.
        router.replace({
          pathname: '/jellyfin/player/[id]',
          params: {
            id: item.Id,
            start: String(player.currentTime),
            subtitle: String(choice.index),
            ...(playlist ? { playlist } : {}),
          },
        });
      },
    );
  };

  const pickAudio = () => {
    const current = player.audioTrack;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'Audio',
        options: [
          ...audioTracks.map((t) => (t.language === current?.language && t.label === current?.label ? `✓ ${t.label}` : t.label)),
          'Cancel',
        ],
        cancelButtonIndex: audioTracks.length,
      },
      (i) => {
        const track = audioTracks[i];
        if (track) player.audioTrack = track;
      },
    );
  };

  const actions: ControlAction[] = [
    ...(subtitleStreams(item).length ? [{ label: 'CC', onPress: pickSubtitles }] : []),
    ...(audioTracks.length > 1 ? [{ label: 'Audio', onPress: pickAudio }] : []),
    { label: 'PiP', onPress: () => viewRef.current?.startPictureInPicture().catch(() => undefined) },
    { label: 'iOS', onPress: () => setSystemPlayer(true) },
  ];

  // Go fullscreen only once the native controls are switched on, or the iOS player would open
  // without any way to close it.
  useEffect(() => {
    if (!systemPlayer) return;
    const frame = requestAnimationFrame(() => {
      viewRef.current?.enterFullscreen().catch(() => setSystemPlayer(false));
    });
    return () => cancelAnimationFrame(frame);
  }, [systemPlayer]);

  return (
    <Shell showClose={false}>
      <StatusBar hidden />
      <VideoView
        ref={viewRef}
        style={StyleSheet.absoluteFill}
        player={player}
        contentFit="contain"
        nativeControls={systemPlayer}
        allowsPictureInPicture
        startsPictureInPictureAutomatically
        fullscreenOptions={{ enable: true, orientation: 'default' }}
        // Leaving the iOS player comes back to ours rather than closing.
        onFullscreenExit={() => setSystemPlayer(false)}
      />
      {!systemPlayer && !ended ? (
        <PlayerControls
          player={player}
          title={item.Type === 'Episode' ? (item.SeriesName ?? item.Name) : item.Name}
          subtitle={item.Type === 'Episode' ? [episodeLabel(item), item.Name].filter(Boolean).join(' · ') : undefined}
          fallbackDuration={(item.RunTimeTicks ?? 0) / TICKS_PER_SECOND}
          trickplay={trickplay}
          actions={actions}
          onClose={() => router.back()}
        />
      ) : null}
      {ended && next ? <UpNext client={client} next={next} onPlay={playNext} onClose={() => router.back()} /> : null}
    </Shell>
  );
}

/** Jellyfin's HLS stream only carries the subtitle we asked for, so the first track is it. */
function showFirstSubtitleTrack(player: VideoPlayer) {
  const track = player.subtitleTrack ?? player.availableSubtitleTracks[0];
  if (track) player.subtitleTrack = track;
  return !!track;
}

/** The player's track for a Jellyfin subtitle stream, matched by position among the file's embedded ones. */
function embeddedSubtitleTrack(player: VideoPlayer, embedded: number[], index: number | undefined) {
  const position = index === undefined ? -1 : embedded.indexOf(index);
  return position === -1 ? null : (player.availableSubtitleTracks[position] ?? null);
}

/** Shows that track, or none when the stream isn't one of the embedded ones (e.g. subtitles off). */
function showEmbeddedSubtitleTrack(player: VideoPlayer, embedded: number[], index: number | undefined) {
  player.subtitleTrack = embeddedSubtitleTrack(player, embedded, index);
}

function UpNext({
  client,
  next,
  onPlay,
  onClose,
}: {
  client: JellyfinClient;
  next: BaseItem;
  onPlay: () => void;
  onClose: () => void;
}) {
  const [seconds, setSeconds] = useState(UP_NEXT_SECONDS);
  const done = useRef(false);
  const play = () => {
    if (done.current) return;
    done.current = true;
    onPlay();
  };

  useEffect(() => {
    if (seconds <= 0) {
      play();
      return;
    }
    const timer = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds]);

  const thumb = client.imageUrl(next, { height: 360 });
  return (
    <View style={styles.upNext}>
      {thumb ? <Image source={thumb} style={styles.upNextThumb} contentFit="cover" /> : null}
      <ThemedText type="small" style={styles.dim}>
        Up next
      </ThemedText>
      <ThemedText type="subtitle" style={[styles.light, styles.upNextTitle]} numberOfLines={2}>
        {[episodeLabel(next), next.Name].filter(Boolean).join(' · ')}
      </ThemedText>
      <ThemedText type="small" style={styles.dim}>
        Playing in {Math.max(seconds, 0)}s
      </ThemedText>
      <View style={styles.upNextActions}>
        <Button title="Play now" onPress={play} />
        <Button
          title="Close"
          variant="secondary"
          onPress={() => {
            done.current = true;
            onClose();
          }}
        />
      </View>
    </View>
  );
}

function Shell({ children, showClose = true }: { children: React.ReactNode; showClose?: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.shell}>
      {children}
      {showClose ? (
        <Pressable
          onPress={() => router.back()}
          hitSlop={16}
          style={[styles.close, { top: insets.top + Spacing.two, left: insets.left + Spacing.three }]}>
          <ThemedText style={styles.light}>✕</ThemedText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  close: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  light: {
    color: '#fff',
    textAlign: 'center',
  },
  error: {
    padding: Spacing.four,
    gap: Spacing.three,
  },
  dim: {
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
  },
  upNext: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    gap: Spacing.two,
  },
  upNextThumb: {
    width: 280,
    maxWidth: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 8,
    marginBottom: Spacing.two,
  },
  upNextTitle: {
    fontSize: 22,
    lineHeight: 28,
  },
  upNextActions: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
});
