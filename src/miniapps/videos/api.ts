import { request, type Connection } from '@/miniapps/server/api';

/** The status server's video downloads: yt-dlp saves links into Jellyfin's YouTube library. */

export type VideoQuality = 1080 | 720 | 480;

export type VideoJob = {
  id: string;
  url: string;
  quality: VideoQuality;
  state: 'queued' | 'downloading' | 'done' | 'failed' | 'cancelled';
  /** The video's title, or the playlist's for a playlist; known once yt-dlp has looked it up. */
  title?: string;
  channel?: string;
  thumbnail?: string;
  /** The piece downloading now. Video and audio come down separately, so it fills twice. */
  progress?: { bytes: number; total?: number; speed?: number; eta?: number };
  /** For a playlist, the video it's on. */
  item?: { index: number; count: number; title: string };
  /** Saved files, relative to the library folder. */
  files: string[];
  error?: string;
  note?: string;
  createdAt: number;
  finishedAt?: number;
};

export function listVideos(conn: Connection) {
  return request<{ jobs: VideoJob[]; folder: string }>(conn, '/api/videos');
}

export function saveVideo(conn: Connection, url: string, quality: VideoQuality) {
  return request<VideoJob>(conn, '/api/videos', { method: 'POST', body: JSON.stringify({ url, quality }) });
}

export function retryVideo(conn: Connection, id: string) {
  return request<VideoJob>(conn, `/api/videos/${id}/retry`, { method: 'POST' });
}

export function cancelVideo(conn: Connection, id: string) {
  return request<VideoJob>(conn, `/api/videos/${id}/cancel`, { method: 'POST' });
}

/** Takes it off the list; a saved video stays in Jellyfin. */
export function removeVideo(conn: Connection, id: string) {
  return request<{ ok: true }>(conn, `/api/videos/${id}`, { method: 'DELETE' });
}
