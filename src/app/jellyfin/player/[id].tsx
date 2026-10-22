import { useEventListener } from 'expo';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView, type VideoPlayer, type VideoSource } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { TICKS_PER_SECOND, type BaseItem, type JellyfinClient } from '@/miniapps/jellyfin/api';
import { Button, episodeLabel } from '@/miniapps/jellyfin/components';
import { useJellyfin } from '@/miniapps/jellyfin/session';
import { subtitleIndexForLanguage, subtitleLanguage } from '@/miniapps/jellyfin/subtitles';
import { useAsync } from '@/miniapps/jellyfin/use-async';

const PROGRESS_INTERVAL_SECONDS = 10;
const UP_NEXT_SECONDS = 10;

export default function PlayerScreen() {
  const { id, start, subtitle, subtitleLang } = useLocalSearchParams<{
    id: string;
    start?: string;
    /** Subtitle stream index picked on the item screen. */
    subtitle?: string;
    /** Subtitle language carried over from the previous episode, or "off". */
    subtitleLang?: string;
  }>();
  const client = useJellyfin();
  const { data, error, reload } = useAsync(async () => {
    const item = await client.item(id);
    const subtitleIndex =
      subtitle !== undefined
        ? Number(subtitle)
        : subtitleLang
          ? subtitleIndexForLanguage(item, subtitleLang)
          : undefined;
    const [playback, next] = await Promise.all([
      client.playbackInfo(id, subtitleIndex),
      item.Type === 'Episode' ? client.nextEpisode(item).catch(() => undefined) : undefined,
    ]);
    return { item, playback: { ...playback, subtitleIndex }, next };
  }, id);

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

  return <Player client={client} {...data} startSeconds={Number(start) || 0} />;
}

type Playback = Awaited<ReturnType<JellyfinClient['playbackInfo']>> & { subtitleIndex?: number };

function Player({
  client,
  item,
  playback,
  next,
  startSeconds,
}: {
  client: JellyfinClient;
  item: BaseItem;
  playback: Playback;
  next: BaseItem | undefined;
  startSeconds: number;
}) {
  const viewRef = useRef<VideoView>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [ended, setEnded] = useState(false);
  const started = useRef(false);
  const position = useRef(startSeconds);

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
    p.timeUpdateEventInterval = PROGRESS_INTERVAL_SECONDS;
  });

  const report = (phase: 'start' | 'progress' | 'stopped', isPaused = false) =>
    client.reportPlayback(phase, {
      ItemId: item.Id,
      MediaSourceId: playback.mediaSourceId,
      PlaySessionId: playback.playSessionId,
      PositionTicks: Math.round(position.current * TICKS_PER_SECOND),
      PlayMethod: playback.playMethod,
      IsPaused: isPaused,
    });

  // Subtitles chosen up front arrive as a track in the HLS stream; switch it on once, when it
  // shows up, and leave later changes in the system menu alone.
  const subtitleApplied = useRef(false);
  const applySubtitle = () => {
    if (subtitleApplied.current || (playback.subtitleIndex ?? -1) < 0) return;
    subtitleApplied.current = showFirstSubtitleTrack(player);
  };
  useEventListener(player, 'availableSubtitleTracksChange', applySubtitle);

  useEventListener(player, 'statusChange', ({ status }) => {
    if (status !== 'readyToPlay' || started.current) return;
    started.current = true;
    if (startSeconds > 0) player.seekBy(startSeconds);
    player.play();
    report('start');
    applySubtitle();
    // Hand over to the system player: rotation, scrubbing, audio and subtitle menus, AirPlay, PiP.
    viewRef.current?.enterFullscreen().catch(() => undefined);
  });

  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    position.current = currentTime;
    report('progress', !player.playing);
  });

  useEventListener(player, 'playingChange', ({ isPlaying }) => {
    position.current = player.currentTime;
    report('progress', !isPlaying);
  });

  useEventListener(player, 'playToEnd', () => {
    position.current = player.duration;
    if (!next) {
      router.back();
      return;
    }
    viewRef.current?.exitFullscreen().catch(() => undefined);
    setEnded(true);
  });

  const playNext = () => {
    if (!next) return;
    const lang = subtitleLanguage(item, playback.subtitleIndex);
    router.replace({
      pathname: '/jellyfin/player/[id]',
      params: { id: next.Id, start: '0', ...(lang ? { subtitleLang: lang } : {}) },
    });
  };

  // Tell the server where we stopped so "Continue watching" is up to date.
  useEffect(() => {
    return () => {
      if (started.current) report('stopped');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Shell showClose={!fullscreen}>
      <VideoView
        ref={viewRef}
        style={StyleSheet.absoluteFill}
        player={player}
        contentFit="contain"
        nativeControls
        allowsPictureInPicture
        startsPictureInPictureAutomatically
        fullscreenOptions={{ enable: true, orientation: 'default' }}
        onFullscreenEnter={() => setFullscreen(true)}
        // Don't close the screen here: leaving fullscreen is also how Picture in Picture starts,
        // and unmounting would kill it. The close button reappears instead.
        onFullscreenExit={() => setFullscreen(false)}
      />
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
