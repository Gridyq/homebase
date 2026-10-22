import { useEventListener } from 'expo';
import { router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView, type VideoSource } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { TICKS_PER_SECOND, type BaseItem, type JellyfinClient } from '@/miniapps/jellyfin/api';
import { Button } from '@/miniapps/jellyfin/components';
import { useJellyfin } from '@/miniapps/jellyfin/session';
import { useAsync } from '@/miniapps/jellyfin/use-async';

const PROGRESS_INTERVAL_SECONDS = 10;

export default function PlayerScreen() {
  const { id, start } = useLocalSearchParams<{ id: string; start?: string }>();
  const client = useJellyfin();
  const { data, error, reload } = useAsync(
    () => Promise.all([client.item(id), client.playbackInfo(id)]),
    id,
  );

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

  const [item, playback] = data;
  return <Player client={client} item={item} playback={playback} startSeconds={Number(start) || 0} />;
}

type Playback = Awaited<ReturnType<JellyfinClient['playbackInfo']>>;

function Player({
  client,
  item,
  playback,
  startSeconds,
}: {
  client: JellyfinClient;
  item: BaseItem;
  playback: Playback;
  startSeconds: number;
}) {
  const viewRef = useRef<VideoView>(null);
  const [fullscreen, setFullscreen] = useState(false);
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

  useEventListener(player, 'statusChange', ({ status }) => {
    if (status !== 'readyToPlay' || started.current) return;
    started.current = true;
    if (startSeconds > 0) player.seekBy(startSeconds);
    player.play();
    report('start');
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

  useEventListener(player, 'playToEnd', () => router.back());

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
    </Shell>
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
});
