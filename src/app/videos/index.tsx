import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { ActionSheetIOS, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { type Connection } from '@/miniapps/server/api';
import {
  Card,
  formatBytes,
  formatDuration,
  formatWhen,
  Meter,
  PollStatus,
  Section,
  Segmented,
  StatusColors,
} from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { usePolling } from '@/miniapps/server/use-polling';
import {
  cancelVideo,
  listVideos,
  removeVideo,
  retryVideo,
  saveVideo,
  type VideoJob,
  type VideoQuality,
} from '@/miniapps/videos/api';

const ACTIVE_POLL_MS = 2000;
const IDLE_POLL_MS = 15_000;
const QUALITIES: { value: VideoQuality; label: string }[] = [
  { value: 1080, label: '1080p' },
  { value: 720, label: '720p' },
  { value: 480, label: '480p' },
];

/** `homebase://videos?url=…` fills in the link, so an iOS Shortcut can send one from the share sheet. */
export default function VideosHome() {
  const { connection } = useServerConnection();
  const theme = useTheme();
  const gutter = useGutter();

  if (!connection) {
    return (
      <View style={[styles.empty, gutter, { backgroundColor: theme.background }]}>
        <ThemedText type="smallBold">Not connected</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
          Videos download on the home server. Connect the Server app first.
        </ThemedText>
        <Button title="Set up connection" onPress={() => router.push('/server/connect')} />
      </View>
    );
  }
  return <Videos key={`${connection.url}|${connection.token}`} conn={connection} />;
}

function Videos({ conn }: { conn: Connection }) {
  const theme = useTheme();
  const gutter = useGutter();
  const params = useLocalSearchParams<{ url?: string }>();
  const [url, setUrl] = useState(params.url ?? '');
  // A link arriving while the screen is already open replaces what's typed.
  const [linkParam, setLinkParam] = useState(params.url);
  if (params.url !== linkParam) {
    setLinkParam(params.url);
    if (params.url) setUrl(params.url);
  }
  const [quality, setQuality] = useState<VideoQuality>(1080);
  const [saving, setSaving] = useState(false);
  const [pulled, setPulled] = useState(false);
  const [interval, setPollInterval] = useState(IDLE_POLL_MS);
  const list = usePolling(() => listVideos(conn), interval, conn.url);
  const jobs = list.data?.jobs;

  // Poll quickly only while something is downloading or waiting to.
  const busy = !!jobs?.some((j) => j.state === 'queued' || j.state === 'downloading');
  const wanted = busy ? ACTIVE_POLL_MS : IDLE_POLL_MS;
  if (wanted !== interval) setPollInterval(wanted);

  const save = async () => {
    setSaving(true);
    try {
      await saveVideo(conn, url.trim(), quality);
      setUrl('');
      await list.refresh();
    } catch (e) {
      Alert.alert('Couldn’t start the download', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const act = (action: () => Promise<unknown>) =>
    action().then(list.refresh, (e: Error) => Alert.alert('Something went wrong', e.message));

  const showActions = (job: VideoJob) => {
    const running = job.state === 'queued' || job.state === 'downloading';
    const retryable = job.state === 'failed' || job.state === 'cancelled';
    const options = [
      running ? 'Cancel download' : undefined,
      retryable ? 'Try again' : undefined,
      'Open link',
      'Remove from list',
    ].filter((o): o is string => !!o);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: job.title ?? job.url,
        message: job.files.length ? 'Removing it from the list keeps the video in Jellyfin.' : undefined,
        options: [...options, 'Cancel'],
        cancelButtonIndex: options.length,
        destructiveButtonIndex: running ? 0 : undefined,
      },
      (index) => {
        const option = options[index];
        if (option === 'Cancel download') act(() => cancelVideo(conn, job.id));
        if (option === 'Try again') act(() => retryVideo(conn, job.id));
        if (option === 'Open link') WebBrowser.openBrowserAsync(job.url);
        if (option === 'Remove from list') act(() => removeVideo(conn, job.id));
      },
    );
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.content, gutter]}
      refreshControl={
        <RefreshControl
          refreshing={pulled}
          onRefresh={async () => {
            setPulled(true);
            await list.refresh();
            setPulled(false);
          }}
        />
      }>
      <Section title="Save to Jellyfin">
        <TextInput
          style={[styles.input, { backgroundColor: theme.backgroundElement, color: theme.text }]}
          value={url}
          onChangeText={setUrl}
          placeholder="YouTube or other video link"
          placeholderTextColor={theme.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
          returnKeyType="go"
          onSubmitEditing={() => url.trim() && !saving && save()}
        />
        <Segmented options={QUALITIES} value={quality} onChange={setQuality} />
        <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
          Saved in the YouTube library, one folder per channel. A playlist link saves every video in it. Lower
          quality takes less space.
        </ThemedText>
        <Button title={saving ? 'Starting…' : 'Download'} onPress={save} disabled={saving || !url.trim()} />
      </Section>

      <Section title="Downloads">
        <PollStatus error={list.error} loaded={!!jobs} onRetry={list.refresh} />
        {!jobs ? null : jobs.length ? (
          <Card>
            {jobs.map((job, i) => (
              <JobRow key={job.id} job={job} first={i === 0} onPress={() => showActions(job)} />
            ))}
          </Card>
        ) : (
          <ThemedText themeColor="textSecondary">Nothing downloaded yet.</ThemedText>
        )}
      </Section>
    </ScrollView>
  );
}

function JobRow({ job, first, onPress }: { job: VideoJob; first: boolean; onPress: () => void }) {
  const theme = useTheme();
  const fraction = job.progress?.total ? job.progress.bytes / job.progress.total : undefined;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
        { opacity: pressed ? 0.6 : 1 },
      ]}>
      <View style={[styles.thumb, { backgroundColor: theme.backgroundSelected }]}>
        {job.thumbnail ? <Image source={job.thumbnail} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
      </View>
      <View style={styles.rowText}>
        <ThemedText type="smallBold" numberOfLines={2}>
          {job.title ?? job.url}
        </ThemedText>
        <ThemedText
          type="small"
          themeColor="textSecondary"
          numberOfLines={job.error ? 3 : 1}
          style={[styles.caption, job.error ? { color: theme.danger } : null]}>
          {describe(job)}
        </ThemedText>
        {job.state === 'downloading' ? <Meter fraction={fraction} color={StatusColors.good} /> : null}
      </View>
    </Pressable>
  );
}

function describe(job: VideoJob) {
  const playlist = job.item ? `${job.item.index} of ${job.item.count}` : undefined;
  switch (job.state) {
    case 'queued':
      return 'Waiting';
    case 'downloading': {
      const p = job.progress;
      if (!p) return [playlist, job.title ? 'Starting' : 'Looking it up'].filter(Boolean).join(' · ');
      return [
        playlist,
        p.total ? `${formatBytes(p.bytes)} of ${formatBytes(p.total)}` : formatBytes(p.bytes),
        p.speed ? `${formatBytes(p.speed)}/s` : undefined,
        p.eta ? `${formatDuration(p.eta * 1000)} left` : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
    }
    case 'done': {
      const when = job.finishedAt ? formatWhen(job.finishedAt) : undefined;
      if (job.note) return [job.note, when].filter(Boolean).join(' · ');
      const count = job.files.length > 1 ? `${job.files.length} videos` : undefined;
      return [`Saved${job.channel ? ` · ${job.channel}` : ''}`, count, `${job.quality}p`, when].filter(Boolean).join(' · ');
    }
    case 'failed':
      return job.error ?? 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.four,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.three,
  },
  center: {
    textAlign: 'center',
  },
  input: {
    borderRadius: 10,
    paddingHorizontal: Spacing.three,
    paddingVertical: 14,
    fontSize: 17,
  },
  caption: {
    fontSize: 13,
    lineHeight: 17,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two + Spacing.one,
  },
  thumb: {
    width: 80,
    height: 45,
    borderRadius: 6,
    overflow: 'hidden',
  },
  rowText: {
    flex: 1,
    gap: Spacing.half,
  },
});
