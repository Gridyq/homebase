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
  /** Seerr's own id for the title, not TMDB's. */
  id: number;
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

/** Seerr is stopped while unused; the server starts it on the first call, which takes a few seconds. */
const SEERR_TIMEOUT_MS = 30_000;

const arr = <T>(conn: Connection, path: string, init?: Parameters<typeof request>[2]) =>
  request<T>(conn, `/api/arr/${path}`, path.startsWith('seerr/') ? { timeoutMs: SEERR_TIMEOUT_MS, ...init } : init);

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

/**
 * Ask for a movie, or for some seasons of a show. Seerr sends it on to Sonarr or Radarr, with
 * the given quality profile or else the one set in Seerr.
 */
let requestCount = 0;

/** Goes up with every request made, so the Overview knows when its list of requests is out of date. */
export const requestsMade = () => requestCount;

export async function requestMedia(conn: Connection, type: MediaType, id: number, seasons?: number[], profileId?: number) {
  const result = await arr<SeerrRequest>(conn, 'seerr/request', {
    method: 'POST',
    body: JSON.stringify({ mediaType: type, mediaId: id, ...(type === 'tv' ? { seasons } : {}), ...(profileId ? { profileId } : {}) }),
  });
  requestCount++;
  return result;
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
  seriesId?: number;
  movieId?: number;
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
  /** When Sonarr or Radarr grabbed it, as an ISO date. */
  added?: string;
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
  /** The download client's id for it (the torrent hash), for importing it by hand. */
  downloadId?: string;
  /** Sonarr series id or Radarr movie id, for finding another release. */
  arrId?: number;
  /** The season it's for, or the first one when it spans several. */
  seasonNumber?: number;
  /** Every season it covers. */
  seasons: number[];
  title: string;
  /** "Season 3", "S03E04", or the year for a movie. */
  subtitle: string;
  release: string;
  posterUrl?: string;
  tmdbId?: number;
  size: number;
  sizeLeft: number;
  timeLeft?: string;
  /** `blocked`: finished, but Sonarr or Radarr won't import it without being told to. */
  state: 'downloading' | 'queued' | 'paused' | 'importing' | 'blocked' | 'stalled' | 'warning' | 'failed' | 'completed';
  problem?: string;
  /** The first episode it covers, for listing a show's downloads in order. */
  episodeNumber?: number;
  added?: string;
};

const poster = (images: ArrImage[] | undefined) => images?.find((i) => i.coverType === 'poster')?.remoteUrl;
const pad = (n: number) => String(n).padStart(2, '0');

function downloadState(r: QueueRecord): Download['state'] {
  if (r.trackedDownloadStatus === 'error' || r.status === 'failed') return 'failed';
  if (r.trackedDownloadState === 'importBlocked') return 'blocked';
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
  // The whole queue, since Sonarr sorts torrents qBittorrent hasn't started first: a page of 200
  // can be all queued while the ones downloading sit further down. includeSeries would repeat the
  // whole series on every episode (megabytes for a full show), so each series is fetched once.
  const include = app === 'sonarr' ? 'includeEpisode=true' : 'includeMovie=true';
  const res = await arr<{ records: QueueRecord[] }>(conn, `${app}/queue?pageSize=1000&${include}`);
  if (app === 'sonarr') {
    const ids = [...new Set(res.records.flatMap((r) => (r.seriesId ? [r.seriesId] : [])))];
    const series = new Map(
      await Promise.all(
        ids.map((id) =>
          arr<NonNullable<QueueRecord['series']>>(conn, `sonarr/series/${id}`).then(
            (s) => [id, s] as const,
            () => [id, undefined] as const,
          ),
        ),
      ),
    );
    for (const r of res.records) r.series = r.seriesId ? series.get(r.seriesId) : undefined;
  }
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
      downloadId: r.downloadId,
      arrId: r.seriesId ?? r.movieId ?? r.series?.id ?? r.movie?.id,
      seasonNumber: seasons[0] ?? r.seasonNumber,
      seasons: seasons.length ? seasons : r.seasonNumber !== undefined ? [r.seasonNumber] : [],
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
      episodeNumber: episodes.length ? Math.min(...episodes.map((e) => e.episodeNumber)) : undefined,
      added: r.added,
    };
  });
}

/** Everything Sonarr and Radarr are downloading. A side that fails is left out. */
export async function downloads(conn: Connection) {
  const results = await Promise.allSettled([queueOf(conn, 'sonarr'), queueOf(conn, 'radarr')]);
  if (results.every((r) => r.status === 'rejected')) throw (results[0] as PromiseRejectedResult).reason;
  const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  // The order the server keeps qBittorrent's queue in: shows and movies in the order they were
  // first grabbed, and a show's downloads by season and episode.
  const group = (d: Download) => `${d.arr}:${d.arrId ?? d.key}`;
  const first = new Map<string, string>();
  for (const d of all) {
    const added = d.added ?? '';
    const seen = first.get(group(d));
    if (seen === undefined || added < seen) first.set(group(d), added);
  }
  return [...all].sort(
    (a, b) =>
      first.get(group(a))!.localeCompare(first.get(group(b))!) ||
      group(a).localeCompare(group(b)) ||
      (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) ||
      (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0),
  );
}

/**
 * Remove a download, optionally blocklisting the release so it isn't picked again. A blocklisted
 * release makes Sonarr or Radarr search for another, unless `searchAgain` is false (for picking
 * one by hand instead).
 */
export async function removeDownload(
  conn: Connection,
  download: Pick<Download, 'arr' | 'queueIds'>,
  blocklist: boolean,
  searchAgain = true,
) {
  const query = `removeFromClient=true&blocklist=${blocklist}&skipRedownload=${!searchAgain}`;
  for (const id of download.queueIds) {
    await arr(conn, `${download.arr}/queue/${id}?${query}`, { method: 'DELETE' });
  }
}

/** Have Sonarr or Radarr look at finished downloads again now, instead of on their next round. */
export function checkDownloads(conn: Connection, app: Arr) {
  return arr(conn, `${app}/command`, { method: 'POST', body: JSON.stringify({ name: 'RefreshMonitoredDownloads' }) });
}

type ManualImportItem = {
  path: string;
  folderName?: string;
  series?: { id: number };
  episodes?: { id: number }[];
  movie?: { id: number };
  quality: unknown;
  languages: unknown;
  releaseGroup?: string;
  indexerFlags?: number;
  releaseType?: string;
  rejections?: { reason: string; type: 'permanent' | 'temporary' }[];
};

/** Rejections that block an automatic import but are fine to override by hand. */
const OVERRIDABLE = /unable to determine if file is a sample/i;

/**
 * Import a finished download that Sonarr or Radarr held back (often because the release name
 * didn't match the title it was grabbed for), the way Manual Import does. Files they matched to a
 * show and episodes, or a movie, go in; samples, files that aren't an upgrade and the like are
 * skipped. Returns how many files were sent.
 */
export async function importAnyway(conn: Connection, download: Download) {
  if (!download.downloadId) throw new Error("This download can't be imported by hand.");
  const items = await arr<ManualImportItem[]>(
    conn,
    `${download.arr}/manualimport?downloadId=${encodeURIComponent(download.downloadId)}&filterExistingFiles=true`,
  );
  const importable = items.filter(
    (i) =>
      (download.arr === 'sonarr' ? i.series && i.episodes?.length : i.movie) &&
      !i.rejections?.some((r) => r.type === 'permanent' && !OVERRIDABLE.test(r.reason)),
  );
  if (!importable.length) {
    const reasons = [...new Set(items.flatMap((i) => i.rejections?.map((r) => r.reason) ?? []))];
    throw new Error(
      reasons.length
        ? `Nothing in it can be imported: ${reasons.slice(0, 2).join('; ')}.`
        : items.length
          ? "Couldn't tell which episodes or movie the files are."
          : 'No video files found in the download.',
    );
  }
  const files = importable.map((i) => ({
    path: i.path,
    folderName: i.folderName,
    quality: i.quality,
    languages: i.languages,
    releaseGroup: i.releaseGroup,
    indexerFlags: i.indexerFlags ?? 0,
    downloadId: download.downloadId,
    ...(download.arr === 'sonarr'
      ? { seriesId: i.series!.id, episodeIds: i.episodes!.map((e) => e.id), releaseType: i.releaseType }
      : { movieId: i.movie!.id }),
  }));
  await arr(conn, `${download.arr}/command`, {
    method: 'POST',
    body: JSON.stringify({ name: 'ManualImport', importMode: 'auto', files }),
  });
  return { imported: files.length, skipped: items.length - files.length };
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
  /** Episodes a single-episode or multi-episode release covers; empty for a season pack. */
  episodeNumbers?: number[];
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

export type QualityProfile = { id: number; name: string };

export function qualityProfiles(conn: Connection, app: Arr) {
  return arr<QualityProfile[]>(conn, `${app}/qualityprofile`).then((list) => list.map(({ id, name }) => ({ id, name })));
}

// ---------------------------------------------------------------------------------------------
// Library: what Sonarr and Radarr have on disk

export type LibrarySeason = { seasonNumber: number; episodes: number; size: number };

export type LibraryItem = {
  key: string;
  arr: Arr;
  /** Sonarr series id or Radarr movie id. */
  id: number;
  tmdbId?: number;
  title: string;
  year?: number;
  posterUrl?: string;
  size: number;
  /** Shows only: seasons with something on disk. */
  seasons: LibrarySeason[];
  episodes?: number;
};

type SeriesResource = {
  id: number;
  title: string;
  year?: number;
  tmdbId?: number;
  images: ArrImage[];
  statistics?: { sizeOnDisk: number; episodeFileCount: number };
  seasons: { seasonNumber: number; monitored: boolean; statistics?: { sizeOnDisk: number; episodeFileCount: number } }[];
};

type MovieResource = { id: number; title: string; year?: number; tmdbId: number; images: ArrImage[]; sizeOnDisk?: number };

/** Every show and movie with files on disk, biggest first. A side that fails is left out. */
export async function library(conn: Connection) {
  const results = await Promise.allSettled([
    arr<SeriesResource[]>(conn, 'sonarr/series').then((list) =>
      list.map(
        (s): LibraryItem => ({
          key: `sonarr:${s.id}`,
          arr: 'sonarr',
          id: s.id,
          tmdbId: s.tmdbId || undefined,
          title: s.title,
          year: s.year,
          posterUrl: poster(s.images),
          size: s.statistics?.sizeOnDisk ?? 0,
          episodes: s.statistics?.episodeFileCount ?? 0,
          seasons: s.seasons
            .filter((x) => x.statistics?.episodeFileCount)
            .map((x) => ({ seasonNumber: x.seasonNumber, episodes: x.statistics!.episodeFileCount, size: x.statistics!.sizeOnDisk })),
        }),
      ),
    ),
    arr<MovieResource[]>(conn, 'radarr/movie').then((list) =>
      list.map(
        (m): LibraryItem => ({
          key: `radarr:${m.id}`,
          arr: 'radarr',
          id: m.id,
          tmdbId: m.tmdbId,
          title: m.title,
          year: m.year,
          posterUrl: poster(m.images),
          size: m.sizeOnDisk ?? 0,
          seasons: [],
        }),
      ),
    ),
  ]);
  if (results.every((r) => r.status === 'rejected')) throw (results[0] as PromiseRejectedResult).reason;
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).sort((a, b) => b.size - a.size);
}

/** Free and total space on the media drive, as Sonarr sees it. */
export async function mediaDisk(conn: Connection) {
  const disks = await arr<{ path: string; freeSpace: number; totalSpace: number }[]>(conn, 'sonarr/diskspace');
  const disk = disks.find((d) => d.path === '/data');
  return disk && { free: disk.freeSpace, total: disk.totalSpace };
}

/**
 * Remove a download and stop wanting what it was for, so it isn't grabbed again and stops showing
 * as requested: the seasons it covered that have nothing on disk or downloading stop being
 * monitored, and a show or movie left with nothing at all is taken out of Sonarr or Radarr and
 * forgotten by Seerr (which never moves a title back from requested on its own).
 */
export async function dropDownload(conn: Connection, download: Download) {
  await removeDownload(conn, download, false);
  if (download.arrId === undefined) return;
  const include = download.arr === 'sonarr' ? 'includeEpisode=true' : 'includeMovie=true';
  const queue = await arr<{ records: QueueRecord[] }>(conn, `${download.arr}/queue?pageSize=1000&${include}`);
  const left = queue.records.filter((r) => (r.seriesId ?? r.movieId) === download.arrId);

  if (download.arr === 'radarr') {
    const movie = await arr<MovieResource & { hasFile?: boolean }>(conn, `radarr/movie/${download.arrId}`);
    if (movie.hasFile || left.length) return;
    await arr(conn, `radarr/movie/${movie.id}?deleteFiles=false&addImportExclusion=false`, { method: 'DELETE' });
    await forgetInSeerr(conn, 'movie', movie.tmdbId);
    return;
  }

  const series = await arr<SeriesResource>(conn, `sonarr/series/${download.arrId}`);
  const downloading = new Set(left.flatMap((r) => r.episode?.seasonNumber ?? r.seasonNumber ?? []));
  const seasons = series.seasons.map((s) =>
    download.seasons.includes(s.seasonNumber) && !s.statistics?.episodeFileCount && !downloading.has(s.seasonNumber)
      ? { ...s, monitored: false }
      : s,
  );
  if (!series.statistics?.episodeFileCount && !left.length && !seasons.some((s) => s.monitored)) {
    await arr(conn, `sonarr/series/${series.id}?deleteFiles=false&addImportListExclusion=false`, { method: 'DELETE' });
    await forgetInSeerr(conn, 'tv', series.tmdbId);
  } else if (seasons.some((s, i) => s !== series.seasons[i])) {
    await arr(conn, `sonarr/series/${series.id}`, { method: 'PUT', body: JSON.stringify({ ...series, seasons }) });
  }
}

/** Lets the title be asked for again in Seerr, instead of it still showing as available. */
async function forgetInSeerr(conn: Connection, type: MediaType, tmdbId: number | undefined) {
  if (!tmdbId) return;
  const mediaId = (await details(conn, type, tmdbId).catch(() => undefined))?.mediaInfo?.id;
  if (mediaId) await arr(conn, `seerr/media/${mediaId}`, { method: 'DELETE' }).catch(() => undefined);
}

/** Delete a whole show or movie, files and all. */
export async function deleteFromLibrary(conn: Connection, item: LibraryItem) {
  const path =
    item.arr === 'sonarr'
      ? `sonarr/series/${item.id}?deleteFiles=true&addImportListExclusion=false`
      : `radarr/movie/${item.id}?deleteFiles=true&addImportExclusion=false`;
  await arr(conn, path, { method: 'DELETE' });
  await forgetInSeerr(conn, item.arr === 'sonarr' ? 'tv' : 'movie', item.tmdbId);
}

/** Delete one season's files and stop Sonarr watching for it, so it isn't downloaded again. */
export async function deleteSeason(conn: Connection, seriesId: number, seasonNumber: number) {
  const series = await arr<SeriesResource>(conn, `sonarr/series/${seriesId}`);
  const seasons = series.seasons.map((s) => (s.seasonNumber === seasonNumber ? { ...s, monitored: false } : s));
  await arr(conn, `sonarr/series/${seriesId}`, { method: 'PUT', body: JSON.stringify({ ...series, seasons }) });
  const files = await arr<{ id: number; seasonNumber: number }[]>(conn, `sonarr/episodefile?seriesId=${seriesId}`);
  const ids = files.filter((f) => f.seasonNumber === seasonNumber).map((f) => f.id);
  if (ids.length) {
    await arr(conn, 'sonarr/episodefile/bulk', { method: 'DELETE', body: JSON.stringify({ episodeFileIds: ids }) });
  }
}

// ---------------------------------------------------------------------------------------------
// qBittorrent

/** Both in bytes per second. A limit of 0 means none. */
export type SpeedLimit = { speed: number; limit: number };

export function speedLimit(conn: Connection) {
  return request<SpeedLimit>(conn, '/api/qbittorrent/limit');
}

export function setSpeedLimit(conn: Connection, limit: number) {
  return request<SpeedLimit>(conn, '/api/qbittorrent/limit', { method: 'POST', body: JSON.stringify({ limit }) });
}

/** Finished torrents seeding and stopped, and the upload speed in bytes per second. */
export type Seeding = { seeding: number; stopped: number; speed: number; stopWhenDone: boolean };

export function seeding(conn: Connection) {
  return request<Seeding>(conn, '/api/qbittorrent/seeding');
}

/** `seed` starts or stops every finished torrent; `stopWhenDone` stops new ones as they finish. */
export function setSeeding(conn: Connection, change: { seed?: boolean; stopWhenDone?: boolean }) {
  return request<Seeding>(conn, '/api/qbittorrent/seeding', { method: 'POST', body: JSON.stringify(change) });
}

// ---------------------------------------------------------------------------------------------
// Tdarr

/** A file in Tdarr's library, named without its folder or extension. */
export type ConvertedFile = { file: string; show: boolean; oldSize: number; newSize: number; at?: number };

export type Conversions = {
  /** The node finishes the file it's on, then waits. */
  paused: boolean;
  workers: {
    file: string;
    show: boolean;
    percent: number;
    /** "0:01:12". */
    eta: string;
    fps: number;
    oldSize: number;
    estSize: number;
  }[];
  counts: { queued: number; done: number; skipped: number; failed: number };
  savedBytes: number;
  /** The latest conversions, newest first. */
  recent: ConvertedFile[];
  errors: { file: string; show: boolean; at?: number }[];
};

export function conversions(conn: Connection) {
  return request<Conversions>(conn, '/api/tdarr');
}

export function setConversionsPaused(conn: Connection, paused: boolean) {
  return request<Conversions>(conn, '/api/tdarr', { method: 'POST', body: JSON.stringify({ paused }) });
}
