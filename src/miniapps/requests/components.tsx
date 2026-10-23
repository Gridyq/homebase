import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatBytes, formatRate, formatWhen, Meter, StatusColors } from '@/miniapps/server/components';

import { MediaStatus, type Conversions, type Download, type MediaType, type Seeding, type SpeedLimit, type Upcoming } from './api';

export function titleHref(type: MediaType, id: number) {
  return { pathname: '/requests/[type]/[id]', params: { type, id: String(id) } } as const;
}

// ---------------------------------------------------------------------------------------------
// Formatting

/** Sonarr's "11:38:00" or "1.02:03:00" as "11h 38m" or "1d 2h". */
export function formatTimeLeft(timeleft: string | undefined) {
  const match = timeleft && /^(?:(\d+)\.)?(\d+):(\d+):\d+$/.exec(timeleft);
  if (!match) return undefined;
  const [d, h, m] = [Number(match[1] ?? 0), Number(match[2]), Number(match[3])];
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}

/** Sonarr and Radarr end file names with the quality ("… WEBDL-1080p"), which is noise here. */
const QUALITY = / (WEBDL|WEBRip|Bluray|HDTV|DVD|Remux|SDTV|Raw-HD)[-\w ]*$/i;
export const displayName = (file: string) => file.replace(QUALITY, '');

/** "0:01:12" → "1m 12s left"; the server says "0:00:00" until it has an estimate. */
export function formatEta(eta: string) {
  const [h = 0, m = 0, s = 0] = eta.split(':').map(Number);
  if (!(h || m || s)) return undefined;
  return `${h ? `${h}h ` : ''}${h || m ? `${m}m` : `${s}s`} left`;
}

/** "2h", "3d", "5mo", "2y" since a release was posted. */
export function formatAge(hours: number | undefined) {
  if (hours === undefined) return undefined;
  if (hours < 24) return `${Math.max(1, Math.round(hours))}h`;
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)}d`;
  if (days < 730) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}

// ---------------------------------------------------------------------------------------------
// Status

type Badge = { label: string; color: string };

export function statusBadge(status: MediaStatus | undefined): Badge | undefined {
  switch (status) {
    case MediaStatus.Available:
      return { label: 'Available', color: StatusColors.good };
    case MediaStatus.PartiallyAvailable:
      return { label: 'Partly available', color: StatusColors.good };
    case MediaStatus.Processing:
      return { label: 'Requested', color: StatusColors.warn };
    case MediaStatus.Pending:
      return { label: 'Awaiting approval', color: StatusColors.warn };
    default:
      return undefined;
  }
}

export function StatusPill({ status }: { status: MediaStatus | undefined }) {
  const badge = statusBadge(status);
  if (!badge) return null;
  return (
    <View style={[styles.pill, { backgroundColor: badge.color }]}>
      <ThemedText style={styles.pillText}>{badge.label}</ThemedText>
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Pieces

export function Poster({ uri, width, label }: { uri: string | undefined; width: number; label?: string }) {
  const theme = useTheme();
  return (
    <View style={[styles.poster, { width, height: width * 1.5, backgroundColor: theme.backgroundElement }]}>
      {uri ? (
        <Image source={uri} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
      ) : label ? (
        <ThemedText type="small" themeColor="textSecondary" style={styles.posterLabel} numberOfLines={3}>
          {label}
        </ThemedText>
      ) : null}
    </View>
  );
}

/** Poster with its status pill, title and year; opens the title page. */
export function TitleCard({
  type,
  id,
  title,
  year,
  posterUrl,
  status,
  width,
}: {
  type: MediaType;
  id: number;
  title: string;
  year?: string;
  posterUrl?: string;
  status?: MediaStatus;
  width: number;
}) {
  return (
    // Not <Link asChild>: it drops a function style, and with it the width.
    <Pressable
      onPress={() => router.push(titleHref(type, id))}
      style={({ pressed }) => [{ width, opacity: pressed ? 0.6 : 1 }]}>
      <View>
        <Poster uri={posterUrl} width={width} label={title} />
        <View style={styles.cardPill}>
          <StatusPill status={status} />
        </View>
      </View>
      <ThemedText type="smallBold" numberOfLines={1} style={styles.cardTitle}>
        {title}
      </ThemedText>
      {year ? (
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
          {year}
        </ThemedText>
      ) : null}
    </Pressable>
  );
}

const DOWNLOAD_STATE_LABELS: Record<Download['state'], string> = {
  downloading: 'Downloading',
  queued: 'Queued',
  paused: 'Paused',
  importing: 'Importing',
  blocked: "Can't import",
  stalled: 'Stalled',
  warning: 'Needs attention',
  failed: 'Failed',
  completed: 'Done',
};

export function DownloadRow({
  download,
  first,
  working,
  onPress,
}: {
  download: Download;
  first: boolean;
  /** What's being done to it right now, like "Removing…". */
  working?: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  const done = download.size ? 1 - download.sizeLeft / download.size : 0;
  const trouble = ['failed', 'warning', 'stalled', 'blocked'].includes(download.state);
  const color = download.state === 'failed' ? theme.danger : trouble ? StatusColors.warn : StatusColors.good;
  const left = download.state === 'downloading' ? formatTimeLeft(download.timeLeft) : undefined;
  const line = [
    working ?? (download.state === 'downloading' ? `${Math.floor(done * 100)}%` : DOWNLOAD_STATE_LABELS[download.state]),
    left && `${left} left`,
    formatBytes(download.size),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Pressable
      onPress={onPress}
      disabled={!!working}
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
        { opacity: working ? 0.5 : pressed ? 0.6 : 1 },
      ]}>
      <Poster uri={download.posterUrl} width={40} />
      <View style={styles.rowText}>
        <ThemedText type="smallBold" numberOfLines={1}>
          {download.title} <ThemedText type="small" themeColor="textSecondary">{download.subtitle}</ThemedText>
        </ThemedText>
        <Meter fraction={done} color={color} />
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.caption}>
          {line}
        </ThemedText>
        {download.problem && trouble ? (
          <ThemedText type="small" numberOfLines={2} style={[styles.caption, { color }]}>
            {download.problem}
          </ThemedText>
        ) : null}
      </View>
    </Pressable>
  );
}

export function SpeedLimitRow({ limit, onPress }: { limit: SpeedLimit; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}>
      <View style={styles.rowText}>
        <ThemedText type="smallBold">Speed limit</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
          {formatRate(limit.speed)} now
        </ThemedText>
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        {limit.limit ? formatRate(limit.limit) : 'None'}
      </ThemedText>
    </Pressable>
  );
}

export function SeedingRow({ seeding, first, onPress }: { seeding: Seeding; first: boolean; onPress: () => void }) {
  const theme = useTheme();
  const caption = seeding.seeding
    ? `${seeding.seeding} torrent${seeding.seeding === 1 ? '' : 's'} · ${formatRate(seeding.speed)} up`
    : seeding.stopped
      ? `${seeding.stopped} stopped`
      : 'Nothing finished';
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
        { opacity: pressed ? 0.6 : 1 },
      ]}>
      <View style={styles.rowText}>
        <ThemedText type="smallBold">Seeding</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
          {caption}
        </ThemedText>
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        {seeding.stopWhenDone ? 'Stops when done' : seeding.seeding ? 'On' : 'Off'}
      </ThemedText>
    </Pressable>
  );
}

/** A file the server is converting right now. */
export function ConvertingRow({ worker, first }: { worker: Conversions['workers'][number]; first: boolean }) {
  const theme = useTheme();
  const line = [`${Math.round(worker.percent)}%`, formatEta(worker.eta)]
    .filter(Boolean)
    .join(' · ');
  return (
    <View
      style={[
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
      ]}>
      <View style={styles.rowText}>
        <ThemedText type="smallBold" numberOfLines={1}>
          {displayName(worker.file)}
        </ThemedText>
        <Meter fraction={worker.percent / 100} color={StatusColors.good} />
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.caption}>
          {line}
        </ThemedText>
      </View>
    </View>
  );
}

/** What's waiting and what's been saved; leads to the Conversions screen. */
export function ConversionsRow({ conversions, first, onPress }: { conversions: Conversions; first: boolean; onPress: () => void }) {
  const theme = useTheme();
  const { queued, failed } = conversions.counts;
  const caption = [
    conversions.paused ? 'Paused' : undefined,
    queued ? `${queued} waiting` : 'Nothing waiting',
    failed ? `${failed} failed` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
        { opacity: pressed ? 0.6 : 1 },
      ]}>
      <View style={styles.rowText}>
        <ThemedText type="smallBold">Conversions</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.caption}>
          {caption}
        </ThemedText>
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        {formatBytes(conversions.savedBytes)} saved ›
      </ThemedText>
    </Pressable>
  );
}

export function UpcomingRow({ item, first }: { item: Upcoming; first: boolean }) {
  const theme = useTheme();
  const { tmdbId } = item;
  return (
    <Pressable
      disabled={!tmdbId}
      onPress={() => tmdbId && router.push(titleHref(item.type, tmdbId))}
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
        { opacity: pressed ? 0.6 : 1 },
      ]}>
      <Poster uri={item.posterUrl} width={40} />
      <View style={styles.rowText}>
        <ThemedText type="smallBold" numberOfLines={1}>
          {item.title}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.caption}>
          {item.subtitle}
        </ThemedText>
      </View>
      <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
        {formatWhen(item.at)}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  poster: {
    borderRadius: 8,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  posterLabel: {
    textAlign: 'center',
    padding: Spacing.two,
  },
  pill: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
  },
  pillText: {
    color: '#fff',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: 700,
  },
  cardPill: {
    position: 'absolute',
    top: Spacing.one,
    left: Spacing.one,
  },
  cardTitle: {
    marginTop: Spacing.one,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two + Spacing.one,
  },
  rowText: {
    flex: 1,
    gap: Spacing.one,
  },
  caption: {
    fontSize: 13,
    lineHeight: 17,
  },
});
