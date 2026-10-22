/**
 * Seerr (search and requests), Sonarr (TV) and Radarr (movies), reached through the status
 * server's `/api/arr/` proxy so their API keys stay on the server.
 */
import { request, type Connection } from '@/miniapps/server/api';

export type MediaType = 'movie' | 'tv';
export type Arr = 'sonarr' | 'radarr';

/** Seerr's status for a title as a whole, or for one season. */
export enum MediaStatus {
  Unknown = 1,
  Pending = 2,
  Processing = 3,
  PartiallyAvailable = 4,
  Available = 5,
  Blocklisted = 6,
  Deleted = 7,
}

export type MediaInfo = {
  status: MediaStatus;
  /** Sonarr series id or Radarr movie id, once it's been sent there. */
  externalServiceId?: number | null;
  seasons?: { seasonNumber: number; status: MediaStatus }[];
};

export type SearchResult = {
  id: number;
  mediaType: MediaType | 'person';
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  posterPath?: string | null;
  mediaInfo?: MediaInfo;
};

export type Season = { seasonNumber: number; episodeCount: number; name: string; airDate?: string | null };

export type Details = {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  tagline?: string;
  releaseDate?: string;
  firstAirDate?: string;
  runtime?: number;
  episodeRunTime?: number[];
  voteAverage?: number;
  genres?: { name: string }[];
  posterPath?: string | null;
  backdropPath?: string | null;
  /** TV only. */
  seasons?: Season[];
  status?: string;
  mediaInfo?: MediaInfo;
};

export type SeerrRequest = {
  id: number;
  type: MediaType;
  status: number;
  createdAt: string;
  seasons: { seasonNumber: number }[];
  media: { tmdbId: number; status: MediaStatus };
};

const arr = <T>(conn: Connection, path: string, init?: Parameters<typeof request>[2]) =>
  request<T>(conn, `/api/arr/${path}`, init);

// ---------------------------------------------------------------------------------------------
// Seerr

export function titleOf(item: { title?: string; name?: string }) {
  return item.title ?? item.name ?? '';
}

export function yearOf(item: { releaseDate?: string; firstAirDate?: string }) {
  return (item.releaseDate ?? item.firstAirDate)?.slice(0, 4);
}

export function tmdbImage(path: string | null | undefined, size: 'w185' | 'w342' | 'w780' | 'w1280') {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
}

export async function search(conn: Connection, query: string) {
  // Seerr wants spaces as %20; URLSearchParams would send "+", which it rejects.
  const res = await arr<{ results: SearchResult[] }>(conn, `seerr/search?query=${encodeURIComponent(query)}&page=1`);
  return res.results.filter((r): r is SearchResult & { mediaType: MediaType } => r.mediaType !== 'person');
}

export function details(conn: Connection, type: MediaType, id: number) {
  return arr<Details>(conn, `seerr/${type}/${id}`);
}

/** Ask for a movie, or for some seasons of a show. Seerr sends it on to Sonarr or Radarr. */
export function requestMedia(conn: Connection, type: MediaType, id: number, seasons?: number[]) {
  return arr<SeerrRequest>(conn, 'seerr/request', {
    method: 'POST',
    body: JSON.stringify({ mediaType: type, mediaId: id, ...(type === 'tv' ? { seasons } : {}) }),
  });
}

export async function recentRequests(conn: Connection, take = 10) {
  const res = await arr<{ results: SeerrRequest[] }>(conn, `seerr/request?take=${take}&sort=added`);
  return res.results;
}

// ---------------------------------------------------------------------------------------------
// Sonarr and Radarr

type ArrImage = { coverType: string; remoteUrl?: string };

type QueueRecord = {
  id: number;
  downloadId?: string;
  title: string;
  size: number;
  sizeleft: number;
  /** "hh:mm:ss", or "d.hh:mm:ss" past a day. */
  timeleft?: string;
  status: string;
  trackedDownloadStatus?: 'ok' | 'warning' | 'error';
  trackedDownloadState?: string;
  statusMessages?: { title: string; messages: string[] }[];
  errorMessage?: string | null;
  seasonNumber?: number;
  series?: { id: number; title: string; tmdbId?: number; images: ArrImage[] };
  episode?: { seasonNumber: number; episodeNumber: number };
  movie?: { id: number; title: string; year: number; tmdbId: number; images: ArrImage[] };
};

/** One torrent, which for a season pack covers several of Sonarr's queue records. */
export type Download = {
  key: string;
  arr: Arr;
  /** Queue record ids it covers, for removing it. */
  queueIds: number[];
  title: string;
  /** "Season 3", "S03E04", or the year for a movie. */
  subtitle: string;
  release: string;
  posterUrl?: string;
  tmdbId?: number;
  size: number;
  sizeLeft: number;
  timeLeft?: string;
  state: 'downloading' | 'queued' | 'paused' | 'importing' | 'stalled' | 'warning' | 'failed' | 'completed';
  problem?: string;
};

const poster = (images: ArrImage[] | undefined) => images?.find((i) => i.coverType === 'poster')?.remoteUrl;
const pad = (n: number) => String(n).padStart(2, '0');

function downloadState(r: QueueRecord): Download['state'] {
  if (r.trackedDownloadStatus === 'error' || r.status === 'failed') return 'failed';
  if (r.trackedDownloadState === 'importPending' || r.trackedDownloadState === 'importing') return 'importing';
  if (r.trackedDownloadState === 'imported') return 'completed';
  if (r.trackedDownloadStatus === 'warning') return r.status === 'warning' ? 'stalled' : 'warning';
  if (r.status === 'paused') return 'paused';
  if (r.status === 'queued' || r.status === 'delay') return 'queued';
  if (r.status === 'completed') return 'importing';
  return 'downloading';
}

function problemOf(r: QueueRecord) {
  return r.errorMessage || r.statusMessages?.flatMap((m) => m.messages)[0] || undefined;
}

async function queueOf(conn: Connection, app: Arr) {
  const include = app === 'sonarr' ? 'includeSeries=true&includeEpisode=true' : 'includeMovie=true';
  const res = await arr<{ records: QueueRecord[] }>(conn, `${app}/queue?pageSize=200&${include}`);
  const groups = new Map<string, QueueRecord[]>();
  for (const r of res.records) {
    const key = r.downloadId ?? `${app}:${r.id}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups].map(([key, records]): Download => {
    const r = records[0];
    const episodes = records.flatMap((x) => (x.episode ? [x.episode] : []));
    const seasons = [...new Set(episodes.map((e) => e.seasonNumber))];
    const subtitle = r.movie
      ? String(r.movie.year)
      : episodes.length === 1
        ? `S${pad(episodes[0].seasonNumber)}E${pad(episodes[0].episodeNumber)}`
        : seasons.length === 1
          ? `Season ${seasons[0]}`
          : `${episodes.length} episodes`;
    return {
      key,
      arr: app,
      queueIds: records.map((x) => x.id),
      title: r.series?.title ?? r.movie?.title ?? r.title,
      subtitle,
      release: r.title,
      posterUrl: poster(r.series?.images ?? r.movie?.images),
      tmdbId: r.series?.tmdbId ?? r.movie?.tmdbId,
      size: r.size,
      sizeLeft: r.sizeleft,
      timeLeft: r.timeleft,
      state: downloadState(r),
      problem: problemOf(r),
    };
  });
}

/** Everything Sonarr and Radarr are downloading. A side that fails is left out. */
export async function downloads(conn: Connection) {
  const results = await Promise.allSettled([queueOf(conn, 'sonarr'), queueOf(conn, 'radarr')]);
  if (results.every((r) => r.status === 'rejected')) throw (results[0] as PromiseRejectedResult).reason;
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

/** Remove a download, optionally blocklisting the release so it isn't picked again. */
export async function removeDownload(conn: Connection, download: Download, blocklist: boolean) {
  const query = `removeFromClient=true&blocklist=${blocklist}&skipRedownload=false`;
  for (const id of download.queueIds) {
    await arr(conn, `${download.arr}/queue/${id}?${query}`, { method: 'DELETE' });
  }
}

export type Upcoming = {
  key: string;
  type: MediaType;
  tmdbId?: number;
  title: string;
  subtitle: string;
  at: number;
  posterUrl?: string;
};

type CalendarEpisode = {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  airDateUtc?: string;
  hasFile: boolean;
  series: { title: string; tmdbId?: number; images: ArrImage[] };
};

type CalendarMovie = {
  id: number;
  title: string;
  tmdbId: number;
  hasFile: boolean;
  digitalRelease?: string;
  physicalRelease?: string;
  images: ArrImage[];
};

/** New episodes and movie home releases from now until `days` ahead, soonest first. */
export async function upcoming(conn: Connection, days = 14) {
  const start = new Date();
  const end = new Date(start.getTime() + days * 86_400_000);
  const range = `start=${start.toISOString()}&end=${end.toISOString()}`;
  const [episodes, movies] = await Promise.all([
    arr<CalendarEpisode[]>(conn, `sonarr/calendar?${range}&includeSeries=true`).catch(() => []),
    arr<CalendarMovie[]>(conn, `radarr/calendar?${range}`).catch(() => []),
  ]);
  const list: Upcoming[] = [
    ...episodes
      .filter((e) => e.airDateUtc && !e.hasFile)
      .map((e) => ({
        key: `ep:${e.id}`,
        type: 'tv' as const,
        tmdbId: e.series.tmdbId,
        title: e.series.title,
        subtitle: [`S${pad(e.seasonNumber)}E${pad(e.episodeNumber)}`, e.title].filter(Boolean).join(' · '),
        at: Date.parse(e.airDateUtc!),
        posterUrl: poster(e.series.images),
      })),
    ...movies.flatMap((m) => {
      const release = m.digitalRelease ?? m.physicalRelease;
      if (!release || m.hasFile) return [];
      const at = Date.parse(release);
      if (at < start.getTime() || at > end.getTime()) return [];
      return [
        {
          key: `movie:${m.id}`,
          type: 'movie' as const,
          tmdbId: m.tmdbId,
          title: m.title,
          subtitle: m.digitalRelease ? 'Digital release' : 'Disc release',
          at,
          posterUrl: poster(m.images),
        },
      ];
    }),
  ];
  return list.sort((a, b) => a.at - b.at);
}

export type Release = {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number;
  seeders?: number;
  leechers?: number;
  ageHours?: number;
  quality: string;
  customFormatScore: number;
  customFormats: string[];
  approved: boolean;
  rejections: string[];
  fullSeason?: boolean;
};

type RawRelease = Omit<Release, 'quality' | 'customFormats' | 'indexer'> & {
  indexer: string;
  quality: { quality: { name: string } };
  customFormats?: { name: string }[];
};

/**
 * Ask every indexer for releases, the way "Interactive search" does: for a movie, or for a whole
 * season of a show. Takes up to a minute or two.
 */
export async function searchReleases(conn: Connection, app: Arr, id: number, season?: number) {
  const query = app === 'radarr' ? `movieId=${id}` : `seriesId=${id}&seasonNumber=${season}`;
  const raw = await arr<RawRelease[]>(conn, `${app}/release?${query}`, { timeoutMs: 190_000 });
  return raw
    .map(
      (r): Release => ({
        ...r,
        indexer: r.indexer.replace(/ \(Prowlarr\)$/, ''),
        quality: r.quality.quality.name,
        customFormats: (r.customFormats ?? []).map((f) => f.name),
        rejections: r.rejections ?? [],
      }),
    )
    .sort(
      (a, b) =>
        Number(b.approved) - Number(a.approved) ||
        // For a season, whole-season packs before single episodes.
        Number(!!b.fullSeason) - Number(!!a.fullSeason) ||
        b.customFormatScore - a.customFormatScore ||
        (b.seeders ?? 0) - (a.seeders ?? 0),
    );
}

export function grabRelease(conn: Connection, app: Arr, release: Pick<Release, 'guid' | 'indexerId'>) {
  return arr(conn, `${app}/release`, {
    method: 'POST',
    body: JSON.stringify({ guid: release.guid, indexerId: release.indexerId }),
    timeoutMs: 60_000,
  });
}
