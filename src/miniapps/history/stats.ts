import { JellyfinError, type BaseItem, type JellyfinClient } from '@/miniapps/jellyfin/api';

export type Period = 'week' | 'month' | 'year' | 'all';

const DAY_MS = 86_400_000;
const PERIOD_DAYS = { week: 7, month: 30, year: 365 } as const;
/** Less than this on an item counts toward time watched, but not as having watched it. */
const WATCHED_SECONDS = 5 * 60;

/** One time you pressed play, as the Playback Reporting plugin logs it. */
type Play = { at: number; itemId: string; type: string; name: string; seconds: number };

/** A show or movie, with everything watched of it in the period. */
export type Title = {
  key: string;
  name: string;
  /** Missing once it's gone from the library. */
  item?: BaseItem;
  seconds: number;
  /** Episodes watched, for a show. */
  episodes: number;
  /** Days it was watched on. */
  days: number;
  last: number;
};

export type RecentPlay = { key: string; title: string; subtitle?: string; at: number; seconds: number; item?: BaseItem };

export type Bucket = { start: number; seconds: number };

export type History = {
  /** When it was worked out. */
  at: number;
  seconds: number;
  episodes: number;
  movies: number;
  shows: number;
  daysWatched: number;
  longestStreak: number;
  /** Days in the period, for an average per day. */
  periodDays: number;
  /** Time watched per day, or per month for a year or more. */
  buckets: Bucket[];
  monthly: boolean;
  /** Time watched by the hour of day it started, midnight first. */
  hours: number[];
  topShows: Title[];
  topMovies: Title[];
  /** Watched on more than one day. */
  rewatched: Title[];
  recent: RecentPlay[];
};

/** The plugin writes "Show - s01e02 - Episode name" for episodes. */
function splitEpisodeName(name: string) {
  const match = /^(.*) - s(\d+)e(\d+) - (.*)$/i.exec(name);
  return match ? { show: match[1], label: `S${Number(match[2])}:E${Number(match[3])}`, episode: match[4] } : undefined;
}

/** The plugin's dates are the server's clock, which is UTC, as "2026-10-23 03:30:01.1234567". */
const parseDate = (s: string) => Date.parse(`${s.replace(' ', 'T').slice(0, 23)}Z`);

const toQueryDate = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

const startOfMonth = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
};

const nameKey = (name: string) => name.trim().toLowerCase();

async function loadPlays(client: JellyfinClient, since: number | undefined): Promise<Play[]> {
  const userId = client.session.userId.replaceAll('-', '').toLowerCase();
  const rows = await client
    .playbackReport(
      'select DateCreated, ItemId, ItemType, ItemName, PlayDuration from PlaybackActivity ' +
        `where lower(replace(UserId, '-', '')) = '${userId.replace(/[^0-9a-f]/g, '')}' and ItemType <> 'Audio'` +
        (since !== undefined ? ` and DateCreated >= '${toQueryDate(since)}'` : '') +
        ' order by DateCreated',
    )
    .catch((e: unknown) => {
      if (e instanceof JellyfinError && e.status === 404) {
        throw new JellyfinError("Watch history needs Jellyfin's Playback Reporting plugin, which isn't installed.");
      }
      if (e instanceof JellyfinError && e.status === 403) {
        throw new JellyfinError('Only a Jellyfin admin can see watch history.');
      }
      throw e;
    });
  return rows.map(([date, itemId, type, name, seconds]) => ({
    at: parseDate(date),
    itemId,
    type,
    name,
    seconds: Number(seconds) || 0,
  }));
}

export async function loadHistory(client: JellyfinClient, period: Period): Promise<History> {
  const now = Date.now();
  const since = period === 'all' ? undefined : startOfDay(now - (PERIOD_DAYS[period] - 1) * DAY_MS);
  // Converting a file to MP4 gives it a new id, so titles are matched by name when the id is gone.
  const [plays, titles] = await Promise.all([loadPlays(client, since), client.titles()]);
  const byId = new Map(titles.map((t) => [t.Id, t]));
  const byName = new Map(titles.map((t) => [`${t.Type}:${nameKey(t.Name)}`, t]));

  const titleMap = new Map<string, Title & { itemIds: Set<string>; dayKeys: Set<number> }>();
  const watchedEpisodes = new Set<string>();
  const watchedMovies = new Set<string>();
  const perItem = new Map<string, number>();
  const days = new Set<number>();
  const hours = Array<number>(24).fill(0);
  let seconds = 0;

  for (const p of plays) perItem.set(p.itemId, (perItem.get(p.itemId) ?? 0) + p.seconds);

  for (const p of plays) {
    seconds += p.seconds;
    const day = startOfDay(p.at);
    days.add(day);
    hours[new Date(p.at).getHours()] += p.seconds;

    const episode = p.type === 'Episode' ? splitEpisodeName(p.name) : undefined;
    const isMovie = p.type === 'Movie';
    if (!episode && !isMovie) continue;
    const watched = (perItem.get(p.itemId) ?? 0) >= WATCHED_SECONDS;
    if (watched) (episode ? watchedEpisodes : watchedMovies).add(p.itemId);

    const name = episode ? episode.show : p.name;
    const key = `${episode ? 'Series' : 'Movie'}:${nameKey(name)}`;
    let title = titleMap.get(key);
    if (!title) {
      const item = episode ? byName.get(key) : (byId.get(p.itemId) ?? byName.get(key));
      title = { key, name: item?.Name ?? name, item, seconds: 0, episodes: 0, days: 0, last: 0, itemIds: new Set(), dayKeys: new Set() };
      titleMap.set(key, title);
    }
    title.seconds += p.seconds;
    title.last = Math.max(title.last, p.at);
    if (watched) {
      title.itemIds.add(p.itemId);
      title.dayKeys.add(day);
    }
  }

  const all = [...titleMap.values()].map(({ itemIds, dayKeys, ...t }) => ({
    ...t,
    episodes: t.key.startsWith('Series:') ? itemIds.size : 0,
    days: dayKeys.size,
  }));
  const bySeconds = (a: Title, b: Title) => b.seconds - a.seconds;

  const first = plays[0]?.at ?? now;
  const periodStart = since ?? startOfDay(first);
  const periodDays = Math.max(1, Math.round((startOfDay(now) - periodStart) / DAY_MS) + 1);

  return {
    at: now,
    seconds,
    episodes: watchedEpisodes.size,
    movies: watchedMovies.size,
    shows: all.filter((t) => t.key.startsWith('Series:') && t.episodes).length,
    daysWatched: days.size,
    longestStreak: longestStreak(days),
    periodDays,
    ...buckets(plays, periodStart, now, periodDays > 62),
    hours,
    topShows: all.filter((t) => t.key.startsWith('Series:')).sort(bySeconds).slice(0, 5),
    topMovies: all.filter((t) => t.key.startsWith('Movie:')).sort(bySeconds).slice(0, 5),
    rewatched: all.filter((t) => t.key.startsWith('Movie:') && t.days > 1).sort((a, b) => b.days - a.days),
    recent: recent(plays, byId, byName),
  };
}

function longestStreak(days: Set<number>) {
  let best = 0;
  for (const day of days) {
    // Only count from the first day of a run. Noon steps over daylight saving changes.
    if (days.has(startOfDay(day - DAY_MS / 2))) continue;
    let length = 1;
    let next = startOfDay(day + DAY_MS * 1.5);
    while (days.has(next)) {
      length++;
      next = startOfDay(next + DAY_MS * 1.5);
    }
    best = Math.max(best, length);
  }
  return best;
}

function buckets(plays: Play[], start: number, now: number, monthly: boolean) {
  const starts: number[] = [];
  if (monthly) {
    for (let t = startOfMonth(start); t <= now; t = startOfMonth(t + 32 * DAY_MS)) starts.push(t);
  } else {
    for (let t = startOfDay(start); t <= now; t = startOfDay(t + DAY_MS * 1.5)) starts.push(t);
  }
  const result: Bucket[] = starts.map((s) => ({ start: s, seconds: 0 }));
  let i = 0;
  for (const p of plays) {
    while (i + 1 < starts.length && p.at >= starts[i + 1]) i++;
    if (p.at >= starts[0]) result[i].seconds += p.seconds;
  }
  return { buckets: result, monthly };
}

/** Latest first. Pausing and coming back logs a play each time, so back-to-back plays of one item merge. */
function recent(plays: Play[], byId: Map<string, BaseItem>, byName: Map<string, BaseItem>): RecentPlay[] {
  const merged: (Play & { end: number })[] = [];
  for (const p of plays) {
    const last = merged.at(-1);
    if (last && last.itemId === p.itemId && p.at - last.end < 2 * 60 * 60_000) {
      last.seconds += p.seconds;
      last.end = p.at + p.seconds * 1000;
    } else {
      merged.push({ ...p, end: p.at + p.seconds * 1000 });
    }
  }
  return merged
    .filter((p) => p.seconds >= 60)
    .slice(-15)
    .reverse()
    .map((p, i) => {
      const episode = p.type === 'Episode' ? splitEpisodeName(p.name) : undefined;
      const item =
        byId.get(p.itemId) ?? byName.get(`${episode ? 'Series' : p.type}:${nameKey(episode?.show ?? p.name)}`);
      return {
        key: `${p.itemId}:${p.at}:${i}`,
        title: episode?.show ?? p.name,
        subtitle: episode ? `${episode.label} · ${episode.episode}` : undefined,
        at: p.at,
        seconds: p.seconds,
        item,
      };
    });
}

/** "12h 5m", "45m", or whole hours past 100. */
export function formatWatchTime(seconds: number) {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  if (h >= 100) return `${h}h`;
  return h ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}

const PARTS_OF_DAY = [
  { name: 'late at night', hours: [22, 23, 0, 1, 2, 3, 4] },
  { name: 'in the morning', hours: [5, 6, 7, 8, 9, 10, 11] },
  { name: 'in the afternoon', hours: [12, 13, 14, 15, 16] },
  { name: 'in the evening', hours: [17, 18, 19, 20, 21] },
];

/** When most of the watching happens, such as "in the evening". */
export function favoriteTimeOfDay(hours: number[]) {
  const scored = PARTS_OF_DAY.map((p) => ({ name: p.name, seconds: p.hours.reduce((sum, h) => sum + hours[h], 0) }));
  const best = scored.reduce((a, b) => (b.seconds > a.seconds ? b : a));
  return best.seconds ? best.name : undefined;
}
