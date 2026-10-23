import { useEventListener } from 'expo';
import { Image } from 'expo-image';
import type { VideoPlayer } from 'expo-video';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

import type { JellyfinClient } from './api';

const HIDE_AFTER_MS = 4000;
const SKIP_SECONDS = 10;

export type Trickplay = NonNullable<ReturnType<JellyfinClient['trickplay']>>;

export type ControlAction = { label: string; onPress: () => void };

/**
 * Homebase's own controls over the video, so scrubbing can show the server's preview thumbnails.
 * Tap the video to show or hide them; they hide by themselves while playing.
 */
export function PlayerControls({
  player,
  title,
  subtitle,
  fallbackDuration,
  trickplay,
  actions,
  onClose,
}: {
  player: VideoPlayer;
  title: string;
  subtitle?: string;
  /** Used until the player knows the length itself. */
  fallbackDuration: number;
  trickplay?: Trickplay;
  /** Buttons along the top right, such as Subtitles or the iOS player. */
  actions: ControlAction[];
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(true);
  const [time, setTime] = useState(player.currentTime);
  const [duration, setDuration] = useState(player.duration);
  const [playing, setPlaying] = useState(player.playing);
  const [loading, setLoading] = useState(player.status === 'loading');
  /** Where the finger is while scrubbing, in seconds. */
  const [scrubTo, setScrubTo] = useState<number>();
  const [interacted, setInteracted] = useState(0);

  useEventListener(player, 'timeUpdate', ({ currentTime }) => setTime(currentTime));
  useEventListener(player, 'playingChange', ({ isPlaying }) => setPlaying(isPlaying));
  useEventListener(player, 'statusChange', ({ status }) => setLoading(status === 'loading'));
  useEventListener(player, 'sourceLoad', (e) => setDuration(e.duration));

  const length = duration > 0 ? duration : fallbackDuration;
  const scrubbing = scrubTo !== undefined;

  // Hide again a few seconds after the last touch, unless paused or scrubbing.
  useEffect(() => {
    if (!visible || !playing || scrubbing) return;
    const timer = setTimeout(() => setVisible(false), HIDE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [visible, playing, scrubbing, interacted]);

  const touched = () => setInteracted((n) => n + 1);
  const seek = (seconds: number) => {
    setTime(seekTo(player, Math.max(0, Math.min(seconds, length))));
    touched();
  };

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable style={StyleSheet.absoluteFill} onPress={() => setVisible((v) => !v)} />
      {/* With the controls up, the spinner takes the play button's place instead. */}
      {loading && !visible ? (
        <View style={styles.center} pointerEvents="none">
          <ActivityIndicator color="#fff" size="large" />
        </View>
      ) : null}
      {visible ? (
        <View style={styles.overlay} pointerEvents="box-none">
          <View
            style={[
              styles.top,
              { paddingTop: insets.top + Spacing.two, paddingLeft: insets.left + Spacing.three, paddingRight: insets.right + Spacing.three },
            ]}>
            <RoundButton label="✕" onPress={onClose} />
            <View style={styles.titles}>
              <ThemedText type="smallBold" style={styles.light} numberOfLines={1}>
                {title}
              </ThemedText>
              {subtitle ? (
                <ThemedText type="small" style={styles.dim} numberOfLines={1}>
                  {subtitle}
                </ThemedText>
              ) : null}
            </View>
            {actions.map((a) => (
              <PillButton
                key={a.label}
                label={a.label}
                onPress={() => {
                  touched();
                  a.onPress();
                }}
              />
            ))}
          </View>

          {!scrubbing ? (
            <View style={styles.middle} pointerEvents="box-none">
              <RoundButton label={`↺ ${SKIP_SECONDS}`} large onPress={() => seek(player.currentTime - SKIP_SECONDS)} />
              <RoundButton
                label={playing ? '❚❚' : '▶'}
                busy={loading}
                huge
                onPress={() => {
                  if (playing) player.pause();
                  else player.play();
                  touched();
                }}
              />
              <RoundButton label={`${SKIP_SECONDS} ↻`} large onPress={() => seek(player.currentTime + SKIP_SECONDS)} />
            </View>
          ) : null}

          <View
            style={[
              styles.bottom,
              {
                paddingBottom: Math.max(insets.bottom, Spacing.three),
                paddingLeft: insets.left + Spacing.three,
                paddingRight: insets.right + Spacing.three,
              },
            ]}>
            <Scrubber
              time={scrubTo ?? time}
              length={length}
              trickplay={trickplay}
              onScrub={setScrubTo}
              onRelease={(seconds) => {
                setScrubTo(undefined);
                seek(seconds);
              }}
            />
            <View style={styles.times}>
              <ThemedText type="small" style={styles.light}>
                {formatClock(scrubTo ?? time)}
              </ThemedText>
              <ThemedText type="small" style={styles.dim}>
                -{formatClock(Math.max(0, length - (scrubTo ?? time)))}
              </ThemedText>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function seekTo(player: VideoPlayer, seconds: number) {
  player.currentTime = seconds;
  return seconds;
}

const TRACK_HIT_HEIGHT = 44;
const THUMB_BORDER = 2;

function Scrubber({
  time,
  length,
  trickplay,
  onScrub,
  onRelease,
}: {
  time: number;
  length: number;
  trickplay?: Trickplay;
  onScrub: (seconds: number) => void;
  onRelease: (seconds: number) => void;
}) {
  const { width: screenWidth } = useWindowDimensions();
  const track = useRef<ComponentRef<typeof View>>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  const [preview, setPreview] = useState<number>();
  const trackX = useRef(0);

  const at = (pageX: number) => (trackWidth ? Math.max(0, Math.min(1, (pageX - trackX.current) / trackWidth)) * length : 0);
  const move = (pageX: number) => {
    const seconds = at(pageX);
    setPreview(seconds);
    onScrub(seconds);
    return seconds;
  };
  const release = (pageX: number) => {
    setPreview(undefined);
    onRelease(at(pageX));
  };

  const fraction = length > 0 ? Math.min(1, time / length) : 0;
  const thumbWidth = Math.min(200, screenWidth * 0.4);
  const thumbLeft = Math.max(0, Math.min(trackWidth - thumbWidth, fraction * trackWidth - thumbWidth / 2));

  return (
    <View
      ref={track}
      style={styles.trackHit}
      onLayout={(e) => {
        setTrackWidth(e.nativeEvent.layout.width);
        track.current?.measureInWindow((x) => {
          trackX.current = x;
        });
      }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        const seconds = move(e.nativeEvent.pageX);
        if (trickplay) prefetchTiles(trickplay, seconds);
      }}
      onResponderMove={(e) => move(e.nativeEvent.pageX)}
      onResponderRelease={(e) => release(e.nativeEvent.pageX)}
      onResponderTerminate={(e) => release(e.nativeEvent.pageX)}>
      {preview !== undefined && trickplay ? (
        <View style={[styles.preview, { left: thumbLeft - THUMB_BORDER }]} pointerEvents="none">
          <TrickplayThumb trickplay={trickplay} seconds={preview} width={thumbWidth} />
        </View>
      ) : null}
      <View style={styles.track}>
        <View style={[styles.trackFill, { width: `${fraction * 100}%` }]} />
      </View>
      <View
        style={[styles.knob, preview !== undefined && styles.knobActive, { left: fraction * trackWidth - (preview !== undefined ? 10 : 7) }]}
        pointerEvents="none"
      />
    </View>
  );
}

/** The preview thumbnail for a moment, cut out of the tile image that holds it. */
function TrickplayThumb({ trickplay, seconds, width }: { trickplay: Trickplay; seconds: number; width: number }) {
  const { info, tileUrl, headers } = trickplay;
  const { tile, column, row } = thumbnailAt(trickplay, seconds);
  const scale = width / info.Width;
  const height = info.Height * scale;
  return (
    <View style={[styles.thumb, { width, height }]}>
      <Image
        source={{ uri: tileUrl(tile), headers }}
        style={{
          position: 'absolute',
          width: info.Width * info.TileWidth * scale,
          height: info.Height * info.TileHeight * scale,
          left: -column * width,
          top: -row * height,
        }}
        contentFit="fill"
        cachePolicy="memory-disk"
        transition={0}
      />
    </View>
  );
}

function thumbnailAt({ info }: Trickplay, seconds: number) {
  const perTile = info.TileWidth * info.TileHeight;
  const index = Math.max(0, Math.min(info.ThumbnailCount - 1, Math.floor((seconds * 1000) / info.Interval)));
  const inTile = index % perTile;
  return { tile: Math.floor(index / perTile), column: inTile % info.TileWidth, row: Math.floor(inTile / info.TileWidth) };
}

/** Load the tile under the finger and its neighbours, so dragging doesn't wait on each one. */
function prefetchTiles(trickplay: Trickplay, seconds: number) {
  const { tile } = thumbnailAt(trickplay, seconds);
  const last = Math.ceil(trickplay.info.ThumbnailCount / (trickplay.info.TileWidth * trickplay.info.TileHeight)) - 1;
  const tiles = [tile, tile - 1, tile + 1].filter((t) => t >= 0 && t <= last);
  Image.prefetch(tiles.map(trickplay.tileUrl), { cachePolicy: 'memory-disk', headers: trickplay.headers }).catch(() => undefined);
}

export function formatClock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function RoundButton({
  label,
  onPress,
  large,
  huge,
  busy,
}: {
  label: string;
  onPress: () => void;
  large?: boolean;
  huge?: boolean;
  /** Show a spinner instead of the label. */
  busy?: boolean;
}) {
  const size = huge ? 72 : large ? 56 : 36;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={12}
      style={({ pressed }) => [
        styles.round,
        { width: size, height: size, borderRadius: size / 2, opacity: pressed ? 0.6 : 1 },
      ]}>
      {busy ? (
        <ActivityIndicator color="#fff" size="large" />
      ) : (
        <ThemedText style={[styles.light, huge ? styles.hugeLabel : large ? styles.largeLabel : null]}>{label}</ThemedText>
      )}
    </Pressable>
  );
}

function PillButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} style={({ pressed }) => [styles.pill, { opacity: pressed ? 0.6 : 1 }]}>
      <ThemedText type="smallBold" style={styles.light}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'space-between',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  center: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  titles: {
    flex: 1,
    marginLeft: Spacing.one,
  },
  middle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.five,
  },
  bottom: {
    gap: Spacing.one,
  },
  times: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  light: {
    color: '#fff',
  },
  dim: {
    color: 'rgba(255,255,255,0.7)',
  },
  round: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  largeLabel: {
    fontSize: 15,
    fontWeight: 600,
  },
  hugeLabel: {
    fontSize: 28,
    lineHeight: 34,
  },
  pill: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: 999,
  },
  trackHit: {
    height: TRACK_HIT_HEIGHT,
    justifyContent: 'center',
  },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.3)',
    overflow: 'hidden',
  },
  trackFill: {
    height: 4,
    backgroundColor: '#fff',
  },
  knob: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#fff',
  },
  knobActive: {
    width: 20,
    height: 20,
    borderRadius: 10,
  },
  preview: {
    position: 'absolute',
    bottom: TRACK_HIT_HEIGHT,
    borderWidth: THUMB_BORDER,
    borderColor: '#fff',
    borderRadius: 8,
  },
  thumb: {
    overflow: 'hidden',
    borderRadius: 6,
    backgroundColor: '#111',
  },
});
