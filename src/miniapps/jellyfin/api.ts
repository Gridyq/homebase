import Constants from 'expo-constants';

/** Jellyfin counts time in ticks of 100ns. */
export const TICKS_PER_SECOND = 10_000_000;

/** Highest bitrate we ever ask for: effectively "original quality". */
export const MAX_BITRATE = 120_000_000;

const CLIENT_NAME = 'Homebase';
const CLIENT_VERSION = Constants.expoConfig?.version ?? '1.0.0';

export type Session = {
  serverUrl: string;
  serverName: string;
  userId: string;
  userName: string;
  accessToken: string;
  deviceId: string;
};

export type UserData = {
  PlaybackPositionTicks?: number;
  PlayedPercentage?: number;
  Played?: boolean;
  IsFavorite?: boolean;
  UnplayedItemCount?: number;
};

export type Person = {
  Id: string;
  Name: string;
  Role?: string;
  Type: 'Actor' | 'Director' | 'Writer' | 'Producer' | 'GuestStar' | string;
  PrimaryImageTag?: string;
};

export type Chapter = {
  StartPositionTicks: number;
  Name?: string;
  ImageTag?: string;
};

/** Scrub preview thumbnails, packed into tile images of `TileWidth` x `TileHeight` thumbnails. */
export type TrickplayInfo = {
  Width: number;
  Height: number;
  TileWidth: number;
  TileHeight: number;
  ThumbnailCount: number;
  /** Milliseconds between thumbnails. */
  Interval: number;
};

export type BaseItem = {
  Id: string;
  Name: string;
  Type: string;
  CollectionType?: string;
  Overview?: string;
  ProductionYear?: number;
  RunTimeTicks?: number;
  OfficialRating?: string;
  CommunityRating?: number;
  SeriesId?: string;
  SeriesName?: string;
  SeasonId?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  ParentBackdropItemId?: string;
  ParentBackdropImageTags?: string[];
  PrimaryImageAspectRatio?: number;
  MediaType?: string;
  IsFolder?: boolean;
  UserData?: UserData;
  MediaSources?: MediaSource[];
  Genres?: string[];
  Taglines?: string[];
  People?: Person[];
  Chapters?: Chapter[];
  RemoteTrailers?: { Url: string; Name?: string }[];
  LocalTrailerCount?: number;
  /** By media source id, then thumbnail width. */
  Trickplay?: Record<string, Record<string, TrickplayInfo>>;
  /** Playlist entries only: identifies this entry, for removing or moving it. */
  PlaylistItemId?: string;
};

export type LibrarySort = 'SortName' | 'DateCreated' | 'PremiereDate' | 'CommunityRating';

export type LibraryQuery = {
  sortBy: LibrarySort;
  descending: boolean;
  unwatched: boolean;
  favorites: boolean;
  genreId?: string;
};

export const DEFAULT_LIBRARY_QUERY: LibraryQuery = {
  sortBy: 'SortName',
  descending: false,
  unwatched: false,
  favorites: false,
};

export type MediaStream = {
  Index: number;
  Type: 'Video' | 'Audio' | 'Subtitle' | string;
  Language?: string;
  DisplayTitle?: string;
  IsDefault?: boolean;
  IsForced?: boolean;
  IsExternal?: boolean;
  IsTextSubtitleStream?: boolean;
};

export type ItemsResponse = { Items: BaseItem[]; TotalRecordCount: number };

export type User = {
  Id: string;
  Name: string;
  Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean; IsHidden?: boolean };
  /** Sent back whole when changing a setting: the server replaces the user's configuration. */
  Configuration?: { EnableNextEpisodeAutoPlay?: boolean } & Record<string, unknown>;
};

export type PlaylistShare = { UserId: string; CanEdit: boolean };

/** Someone's open Jellyfin app, as the server sees it. */
export type RemoteSession = {
  Id: string;
  UserId?: string;
  UserName?: string;
  Client?: string;
  DeviceName?: string;
  DeviceId?: string;
  /** Whether it takes "play this" commands. The Roku app doesn't. */
  SupportsMediaControl?: boolean;
  NowPlayingItem?: BaseItem;
};

/** Ids come back with or without dashes depending on the endpoint. */
export const sameId = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.replace(/-/g, '').toLowerCase() === b.replace(/-/g, '').toLowerCase();

export type MediaSource = {
  Id: string;
  SupportsDirectPlay: boolean;
  SupportsDirectStream: boolean;
  TranscodingUrl?: string;
  MediaStreams?: MediaStream[];
  DefaultSubtitleStreamIndex?: number;
};

type PlaybackInfoResponse = {
  MediaSources: MediaSource[];
  PlaySessionId: string;
  ErrorCode?: string;
};

export class JellyfinError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function normalizeServerUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url;
}

function authHeader(deviceId: string, token?: string): string {
  const parts = [
    `Client="${CLIENT_NAME}"`,
    `Device="iPhone"`,
    `DeviceId="${deviceId}"`,
    `Version="${CLIENT_VERSION}"`,
  ];
  if (token) parts.push(`Token="${token}"`);
  return `MediaBrowser ${parts.join(', ')}`;
}

/** Without one, a server that's out of reach (Tailscale down) leaves screens spinning for a minute or more. */
const TIMEOUT_MS = 15_000;
const TITLES_FRESH_MS = 10 * 60_000;

type CallOptions = { method?: string; body?: unknown; timeoutMs?: number };

async function request<T>(
  serverUrl: string,
  path: string,
  deviceId: string,
  token: string | undefined,
  init: CallOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${serverUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: authHeader(deviceId, token),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
  } catch (e) {
    const reason = controller.signal.aborted ? 'timed out' : e instanceof Error ? e.message : String(e);
    throw new JellyfinError(
      `Couldn't reach ${serverUrl}. Check the address and your network.\n(${reason})`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) throw new JellyfinError('Your session has expired. Sign in again.', 401);
  if (!res.ok) throw new JellyfinError(`Server returned ${res.status} for ${path}`, res.status);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  try {
    return (text ? JSON.parse(text) : undefined) as T;
  } catch {
    throw new JellyfinError(`The server's answer for ${path} wasn't readable. Is this a Jellyfin server?`, res.status);
  }
}

export async function getPublicServerInfo(serverUrl: string, deviceId: string) {
  return request<{ ServerName: string; Version: string; Id: string }>(
    serverUrl,
    '/System/Info/Public',
    deviceId,
    undefined,
  );
}

export async function signIn(
  serverUrl: string,
  username: string,
  password: string,
  deviceId: string,
): Promise<Session> {
  const info = await getPublicServerInfo(serverUrl, deviceId);
  let auth: { User: { Id: string; Name: string }; AccessToken: string };
  try {
    auth = await request(serverUrl, '/Users/AuthenticateByName', deviceId, undefined, {
      method: 'POST',
      body: { Username: username, Pw: password },
    });
  } catch (e) {
    if (e instanceof JellyfinError && e.status === 401) {
      throw new JellyfinError('Wrong username or password.', 401);
    }
    throw e;
  }
  return {
    serverUrl,
    serverName: info.ServerName,
    userId: auth.User.Id,
    userName: auth.User.Name,
    accessToken: auth.AccessToken,
    deviceId,
  };
}

/** API calls bound to a signed-in session. */
/** `onUnauthorized` runs when the server no longer accepts the session's token. */
export function createClient(session: Session, onUnauthorized?: () => void) {
  const { serverUrl, userId, accessToken, deviceId } = session;
  const call = <T>(path: string, init?: CallOptions) =>
    request<T>(serverUrl, path, deviceId, accessToken, init).catch((e: unknown) => {
      if (e instanceof JellyfinError && e.status === 401) onUnauthorized?.();
      throw e;
    });
  const get = <T>(path: string) => call<T>(path);
  const post = <T>(path: string, body?: unknown) => call<T>(path, { method: 'POST', body: body ?? {} });

  const itemFields = 'Overview,PrimaryImageAspectRatio,ParentBackdropItemId';
  let me: Promise<User> | undefined;
  let titles: { at: number; list: Promise<BaseItem[]> } | undefined;

  return {
    session,

    /** Asked once per sign-in. Sharing, "Play on…" and other people's settings are for admins only. */
    isAdmin: () => {
      me ??= get<User>('/Users/Me');
      me.catch(() => (me = undefined));
      return me.then((u) => !!u.Policy?.IsAdministrator);
    },

    signOut: () => post<void>('/Sessions/Logout').catch(() => undefined),

    libraries: () => get<ItemsResponse>(`/UserViews?userId=${userId}`).then((r) => r.Items),

    resume: () =>
      get<ItemsResponse>(
        `/UserItems/Resume?userId=${userId}&mediaTypes=Video&limit=20&fields=${itemFields}`,
      ).then((r) => r.Items),

    nextUp: () =>
      get<ItemsResponse>(`/Shows/NextUp?userId=${userId}&limit=20&fields=${itemFields}`).then(
        (r) => r.Items,
      ),

    favorites: () =>
      get<ItemsResponse>(
        `/Items?userId=${userId}&filters=IsFavorite&recursive=true` +
          `&includeItemTypes=Movie,Series,Episode,BoxSet,MusicVideo&sortBy=SortName&limit=40&fields=${itemFields}`,
      ).then((r) => r.Items),

    libraryItems: (library: BaseItem, query: LibraryQuery, startIndex = 0, limit = 60) => {
      const types: Record<string, string> = {
        movies: 'Movie',
        tvshows: 'Series',
        music: 'MusicAlbum',
        boxsets: 'BoxSet',
        musicvideos: 'MusicVideo',
        playlists: 'Playlist',
      };
      const type = library.CollectionType ? types[library.CollectionType] : undefined;
      const filter = type ? `&includeItemTypes=${type}&recursive=true` : '';
      const filters = [query.unwatched && 'IsUnplayed', query.favorites && 'IsFavorite'].filter(Boolean);
      // Break ties by name so items with the same date or rating stay in a stable order.
      const sortBy = query.sortBy === 'SortName' ? 'SortName' : `${query.sortBy},SortName`;
      return get<ItemsResponse>(
        `/Items?userId=${userId}&parentId=${library.Id}${filter}` +
          `&sortBy=${sortBy}&sortOrder=${query.descending ? 'Descending' : 'Ascending'}` +
          (filters.length ? `&filters=${filters.join(',')}` : '') +
          (query.genreId ? `&genreIds=${query.genreId}` : '') +
          `&fields=${itemFields}&startIndex=${startIndex}&limit=${limit}`,
      );
    },

    genres: (libraryId: string) =>
      get<ItemsResponse>(`/Genres?userId=${userId}&parentId=${libraryId}&sortBy=SortName`).then((r) => r.Items),

    setPlayed: (itemId: string, played: boolean) =>
      call<UserData>(`/UserPlayedItems/${itemId}?userId=${userId}`, {
        method: played ? 'POST' : 'DELETE',
      }),

    setFavorite: (itemId: string, favorite: boolean) =>
      call<UserData>(`/UserFavoriteItems/${itemId}?userId=${userId}`, {
        method: favorite ? 'POST' : 'DELETE',
      }),

    similar: (itemId: string) =>
      get<ItemsResponse>(`/Items/${itemId}/Similar?userId=${userId}&limit=12&fields=${itemFields}`).then(
        (r) => r.Items,
      ),

    localTrailers: (itemId: string) => get<BaseItem[]>(`/Items/${itemId}/LocalTrailers?userId=${userId}`),

    /** Movies and shows a person appears in. */
    credits: (personId: string) =>
      get<ItemsResponse>(
        `/Items?userId=${userId}&personIds=${personId}&recursive=true&includeItemTypes=Movie,Series` +
          `&sortBy=PremiereDate,SortName&sortOrder=Descending&fields=${itemFields}`,
      ).then((r) => r.Items),

    personImageUrl: (person: Person, height = 300) =>
      person.PrimaryImageTag
        ? `${serverUrl}/Items/${person.Id}/Images/Primary?tag=${person.PrimaryImageTag}&fillHeight=${height}&quality=90`
        : undefined,

    chapterImageUrl: (item: BaseItem, index: number, height = 270) => {
      const tag = item.Chapters?.[index]?.ImageTag;
      return tag ? `${serverUrl}/Items/${item.Id}/Images/Chapter/${index}?tag=${tag}&fillHeight=${height}&quality=90` : undefined;
    },

    /** The smallest set of scrub thumbnails for a media source, and the URL of each tile. */
    trickplay: (item: BaseItem, mediaSourceId: string) => {
      const sizes = item.Trickplay?.[mediaSourceId];
      const info = sizes && Object.values(sizes).sort((a, b) => a.Width - b.Width)[0];
      if (!info?.ThumbnailCount) return undefined;
      const tileUrl = (tile: number) =>
        `${serverUrl}/Videos/${item.Id}/Trickplay/${info.Width}/${tile}.jpg?mediaSourceId=${mediaSourceId}`;
      // The token goes in a header, since expo-image keeps the URL in its disk cache.
      return { info, tileUrl, headers: { Authorization: authHeader(deviceId, accessToken) } };
    },

    playlists: () =>
      get<ItemsResponse>(
        `/Items?userId=${userId}&includeItemTypes=Playlist&recursive=true&sortBy=SortName&fields=${itemFields}`,
      ).then((r) => r.Items),

    /** In playlist order. */
    playlistItems: (playlistId: string) =>
      get<ItemsResponse>(`/Playlists/${playlistId}/Items?userId=${userId}&fields=${itemFields}`).then((r) => r.Items),

    /** Adding a show, season or collection adds everything in it. */
    createPlaylist: (name: string, itemIds: string[]) =>
      post<{ Id: string }>('/Playlists', { Name: name, Ids: itemIds, UserId: userId, MediaType: 'Video' }),

    addToPlaylist: (playlistId: string, itemIds: string[]) =>
      post<void>(`/Playlists/${playlistId}/Items?ids=${itemIds.join(',')}&userId=${userId}`),

    removeFromPlaylist: (playlistId: string, entryIds: string[]) =>
      call<void>(`/Playlists/${playlistId}/Items?entryIds=${entryIds.join(',')}`, {
        method: 'DELETE',
      }),

    movePlaylistItem: (playlistId: string, entryId: string, newIndex: number) =>
      post<void>(`/Playlists/${playlistId}/Items/${entryId}/Move/${newIndex}`),

    /** Admins only (403 otherwise). */
    users: () => get<User[]>('/Users?isDisabled=false'),

    /** Users other than the owner the playlist is shared with. */
    playlistShares: (playlistId: string) => get<PlaylistShare[]>(`/Playlists/${playlistId}/Users`),

    /**
     * Replaces who the playlist is shared with (owner only). Not `/Playlists/{id}/Users/{userId}`:
     * the server looks the playlist up as the person being added, who can't see it yet, and fails.
     */
    setPlaylistShares: (playlistId: string, shares: PlaylistShare[]) =>
      post<void>(`/Playlists/${playlistId}`, { Users: shares }),

    setAutoplay: (user: User, enabled: boolean) =>
      post<void>(`/Users/Configuration?userId=${user.Id}`, { ...user.Configuration, EnableNextEpisodeAutoPlay: enabled }),

    /** Apps opened in the last 16 minutes that this user may control: their own, or everyone's for an admin. */
    remoteSessions: () => get<RemoteSession[]>(`/Sessions?controllableByUserId=${userId}&activeWithinSeconds=960`),

    /**
     * Start playing on another device. With autoplay on for that user, the server queues the
     * rest of the show after a single episode.
     */
    playOnSession: (sessionId: string, itemIds: string[], startTicks = 0) =>
      post<void>(
        `/Sessions/${sessionId}/Playing?playCommand=PlayNow&itemIds=${itemIds.join(',')}` +
          `&startPositionTicks=${Math.round(startTicks)}`,
      ),

    /** An item with someone else's watched state and resume point (admins only). */
    itemFor: (forUserId: string, id: string) => get<BaseItem>(`/Items/${id}?userId=${forUserId}`),

    nextUpFor: (forUserId: string, seriesId: string) =>
      get<ItemsResponse>(`/Shows/NextUp?userId=${forUserId}&seriesId=${seriesId}&limit=1&enableResumable=true`).then(
        (r) => r.Items[0] as BaseItem | undefined,
      ),

    /** A show's episodes in order (one season's, with `seasonId`), with someone else's watched state. */
    episodesFor: (forUserId: string, seriesId: string, seasonId?: string) =>
      get<ItemsResponse>(
        `/Shows/${seriesId}/Episodes?userId=${forUserId}` + (seasonId ? `&seasonId=${seasonId}` : ''),
      ).then((r) => r.Items),

    deleteItem: (itemId: string) =>
      call<void>(`/Items/${itemId}`, { method: 'DELETE' }),

    children: (parentId: string) =>
      get<ItemsResponse>(
        `/Items?userId=${userId}&parentId=${parentId}&sortBy=SortName&fields=${itemFields}`,
      ).then((r) => r.Items),

    item: (id: string) => get<BaseItem>(`/Items/${id}?userId=${userId}`),

    /** Every movie and show, for finding the artwork of something known only by name. */
    /**
     * Every movie and show, for matching History's plays to artwork. The whole library, so it's
     * kept a few minutes instead of fetched on each period switch, and without overviews.
     */
    titles: () => {
      if (!titles || Date.now() - titles.at > TITLES_FRESH_MS) {
        const list = get<ItemsResponse>(
          `/Items?userId=${userId}&recursive=true&includeItemTypes=Movie,Series&fields=PrimaryImageAspectRatio`,
        ).then((r) => r.Items);
        titles = { at: Date.now(), list };
        list.catch(() => {
          if (titles?.list === list) titles = undefined;
        });
      }
      return titles.list;
    },

    /** Runs a query on the Playback Reporting plugin's log of plays. Admins only. */
    playbackReport: (query: string) =>
      post<{ results: string[][] }>('/user_usage_stats/submit_custom_query', {
        CustomQueryString: query,
        ReplaceUserId: false,
      }).then((r) => r.results),

    search: (term: string) =>
      get<ItemsResponse>(
        `/Items?userId=${userId}&searchTerm=${encodeURIComponent(term)}&recursive=true` +
          `&includeItemTypes=Movie,Series,Episode,BoxSet,MusicVideo&limit=60&fields=${itemFields}`,
      ).then((r) => r.Items),

    /** The episode after this one, across season boundaries. */
    nextEpisode: async (episode: BaseItem) => {
      if (!episode.SeriesId) return undefined;
      const r = await get<ItemsResponse>(
        `/Shows/${episode.SeriesId}/Episodes?userId=${userId}&startItemId=${episode.Id}&limit=2`,
      );
      return r.Items.find((i) => i.Id !== episode.Id);
    },

    seasons: (seriesId: string) =>
      get<ItemsResponse>(`/Shows/${seriesId}/Seasons?userId=${userId}`).then((r) => r.Items),

    episodes: (seriesId: string, seasonId: string) =>
      get<ItemsResponse>(
        `/Shows/${seriesId}/Episodes?userId=${userId}&seasonId=${seasonId}&fields=${itemFields}`,
      ).then((r) => r.Items),

    imageUrl: (item: BaseItem, opts: { type?: 'Primary' | 'Backdrop' | 'Thumb'; height?: number } = {}) => {
      const type = opts.type ?? 'Primary';
      let id = item.Id;
      let tag = type === 'Backdrop' ? item.BackdropImageTags?.[0] : item.ImageTags?.[type];
      if (type === 'Backdrop' && !tag && item.ParentBackdropItemId) {
        id = item.ParentBackdropItemId;
        tag = item.ParentBackdropImageTags?.[0];
      }
      if (!tag) return undefined;
      return `${serverUrl}/Items/${id}/Images/${type}?tag=${tag}&fillHeight=${opts.height ?? 450}&quality=90`;
    },

    /**
     * Ask the server how to play an item on iOS. Files AVPlayer can handle are played
     * as-is; everything else comes back as an HLS stream the server converts live.
     *
     * `subtitleIndex` picks a subtitle stream (-1 for none; omit for the server's default).
     * Subtitles embedded in an MP4 (mov_text) play directly, with every embedded track available
     * to switch between; anything else (sidecar files, subtitles in MKV) makes the server deliver
     * the chosen one inside the HLS stream (or burn it in, for image subtitles).
     *
     * `maxBitrate` caps the stream; files above it are converted down instead of played as-is.
     */
    playbackInfo: async (itemId: string, subtitleIndex?: number, maxBitrate = MAX_BITRATE) => {
      // The server may probe the file first, so this one gets longer.
      const info = await call<PlaybackInfoResponse>(`/Items/${itemId}/PlaybackInfo?userId=${userId}`, {
        method: 'POST',
        timeoutMs: 45_000,
        body: {
          DeviceProfile: { ...iosDeviceProfile, MaxStreamingBitrate: maxBitrate, MaxStaticBitrate: maxBitrate },
          MaxStreamingBitrate: maxBitrate,
          AutoOpenLiveStream: true,
          SubtitleStreamIndex: subtitleIndex,
          EnableDirectPlay: true,
        },
      });
      if (info.ErrorCode) throw new JellyfinError(`Server can't play this item (${info.ErrorCode}).`);
      const source = info.MediaSources[0];
      if (!source) throw new JellyfinError('No playable media found for this item.');

      let url: string;
      let playMethod: 'DirectPlay' | 'Transcode';
      // The key stays in these URLs: an AirPlay receiver fetches them itself, without our
      // headers, and HLS segments rely on the server copying it into the playlists it writes.
      if (source.SupportsDirectPlay || !source.TranscodingUrl) {
        url =
          `${serverUrl}/Videos/${itemId}/stream?static=true&mediaSourceId=${source.Id}` +
          `&playSessionId=${info.PlaySessionId}&api_key=${accessToken}`;
        playMethod = 'DirectPlay';
      } else {
        url = `${serverUrl}${source.TranscodingUrl}`;
        if (!/[?&]api_key=/i.test(url)) url += `&api_key=${accessToken}`;
        playMethod = 'Transcode';
      }
      // In direct play AVPlayer sees the file's own subtitle tracks, in file order.
      const embeddedSubtitles =
        playMethod === 'DirectPlay'
          ? (source.MediaStreams ?? []).filter((s) => s.Type === 'Subtitle' && !s.IsExternal).map((s) => s.Index)
          : undefined;
      return {
        url,
        playMethod,
        mediaSourceId: source.Id,
        playSessionId: info.PlaySessionId,
        embeddedSubtitles,
        defaultSubtitleIndex: source.DefaultSubtitleStreamIndex,
      };
    },

    reportPlayback: (
      phase: 'start' | 'progress' | 'stopped',
      body: {
        ItemId: string;
        MediaSourceId: string;
        PlaySessionId: string;
        PositionTicks: number;
        PlayMethod: string;
        IsPaused?: boolean;
      },
    ) => {
      const path = { start: '/Sessions/Playing', progress: '/Sessions/Playing/Progress', stopped: '/Sessions/Playing/Stopped' }[phase];
      return post<void>(path, { ...body, CanSeek: true }).catch(() => undefined);
    },
  };
}

export type JellyfinClient = ReturnType<typeof createClient>;

/** What AVPlayer on iOS can play without help from the server. */
const iosDeviceProfile = {
  MaxStreamingBitrate: MAX_BITRATE,
  MaxStaticBitrate: MAX_BITRATE,
  MusicStreamingTranscodingBitrate: 384_000,
  DirectPlayProfiles: [
    { Type: 'Video', Container: 'mp4,m4v,mov', VideoCodec: 'h264,hevc', AudioCodec: 'aac,mp3,ac3,eac3,alac,flac' },
    { Type: 'Audio', Container: 'mp3,aac,m4a,m4b,flac,alac,wav' },
  ],
  TranscodingProfiles: [
    {
      Type: 'Video',
      Container: 'mp4',
      Protocol: 'hls',
      Context: 'Streaming',
      VideoCodec: 'hevc,h264',
      AudioCodec: 'aac,ac3,eac3',
      MaxAudioChannels: '6',
      MinSegments: 2,
      BreakOnNonKeyFrames: true,
    },
    { Type: 'Audio', Container: 'aac', Protocol: 'hls', Context: 'Streaming', AudioCodec: 'aac', MaxAudioChannels: '2' },
  ],
  ContainerProfiles: [],
  CodecProfiles: [],
  SubtitleProfiles: [
    { Format: 'mov_text', Method: 'Embed' },
    { Format: 'vtt', Method: 'Hls' },
    { Format: 'srt', Method: 'Hls' },
    { Format: 'subrip', Method: 'Hls' },
    { Format: 'ass', Method: 'Encode' },
    { Format: 'ssa', Method: 'Encode' },
    { Format: 'pgssub', Method: 'Encode' },
    { Format: 'dvdsub', Method: 'Encode' },
  ],
};
