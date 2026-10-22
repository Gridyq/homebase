import Constants from 'expo-constants';

/** Jellyfin counts time in ticks of 100ns. */
export const TICKS_PER_SECOND = 10_000_000;

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
  UnplayedItemCount?: number;
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

type ItemsResponse = { Items: BaseItem[]; TotalRecordCount: number };

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

async function request<T>(
  serverUrl: string,
  path: string,
  deviceId: string,
  token: string | undefined,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
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
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new JellyfinError(
      `Couldn't reach ${serverUrl}. Check the address and your network.\n(${reason})`,
    );
  }
  if (res.status === 401) throw new JellyfinError('Your session has expired. Sign in again.', 401);
  if (!res.ok) throw new JellyfinError(`Server returned ${res.status} for ${path}`, res.status);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
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
export function createClient(session: Session) {
  const { serverUrl, userId, accessToken, deviceId } = session;
  const get = <T>(path: string) => request<T>(serverUrl, path, deviceId, accessToken);
  const post = <T>(path: string, body?: unknown) =>
    request<T>(serverUrl, path, deviceId, accessToken, { method: 'POST', body: body ?? {} });

  const itemFields = 'Overview,PrimaryImageAspectRatio,ParentBackdropItemId';

  return {
    session,

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

    libraryItems: (library: BaseItem, startIndex = 0, limit = 60) => {
      const types: Record<string, string> = {
        movies: 'Movie',
        tvshows: 'Series',
        music: 'MusicAlbum',
        boxsets: 'BoxSet',
        musicvideos: 'MusicVideo',
      };
      const type = library.CollectionType ? types[library.CollectionType] : undefined;
      const filter = type ? `&includeItemTypes=${type}&recursive=true` : '';
      return get<ItemsResponse>(
        `/Items?userId=${userId}&parentId=${library.Id}${filter}` +
          `&sortBy=SortName&sortOrder=Ascending&fields=${itemFields}` +
          `&startIndex=${startIndex}&limit=${limit}`,
      );
    },

    children: (parentId: string) =>
      get<ItemsResponse>(
        `/Items?userId=${userId}&parentId=${parentId}&sortBy=SortName&fields=${itemFields}`,
      ).then((r) => r.Items),

    item: (id: string) => get<BaseItem>(`/Items/${id}?userId=${userId}`),

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
     * AVPlayer can't load sidecar subtitle files, so choosing one turns off direct play and
     * the server delivers it inside the HLS stream (or burns it in, for image subtitles).
     */
    playbackInfo: async (itemId: string, subtitleIndex?: number) => {
      const withSubtitles = subtitleIndex !== undefined && subtitleIndex >= 0;
      const info = await post<PlaybackInfoResponse>(`/Items/${itemId}/PlaybackInfo?userId=${userId}`, {
        DeviceProfile: iosDeviceProfile,
        MaxStreamingBitrate: 120_000_000,
        AutoOpenLiveStream: true,
        SubtitleStreamIndex: subtitleIndex,
        EnableDirectPlay: !withSubtitles,
      });
      if (info.ErrorCode) throw new JellyfinError(`Server can't play this item (${info.ErrorCode}).`);
      const source = info.MediaSources[0];
      if (!source) throw new JellyfinError('No playable media found for this item.');

      let url: string;
      let playMethod: 'DirectPlay' | 'Transcode';
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
      return { url, playMethod, mediaSourceId: source.Id, playSessionId: info.PlaySessionId };
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
  MaxStreamingBitrate: 120_000_000,
  MaxStaticBitrate: 120_000_000,
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
    { Format: 'vtt', Method: 'Hls' },
    { Format: 'srt', Method: 'Hls' },
    { Format: 'subrip', Method: 'Hls' },
    { Format: 'ass', Method: 'Encode' },
    { Format: 'ssa', Method: 'Encode' },
    { Format: 'pgssub', Method: 'Encode' },
    { Format: 'dvdsub', Method: 'Encode' },
  ],
};
