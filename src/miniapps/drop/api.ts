import { requireOptionalNativeModule } from 'expo';
import { Directory, File, Paths } from 'expo-file-system';

import { request, type Connection } from '@/miniapps/server/api';

/**
 * The status server's Drop endpoints. Files sent from the phone land in a folder on the PC
 * (~/Downloads/Homebase), and whatever is in that folder can be fetched back.
 */

export type DropFile = { name: string; size: number; modified: number };
export type DropFolder = { folder: string; files: DropFile[] };

export function listDrop(conn: Connection) {
  return request<DropFolder>(conn, '/api/drop');
}

/** A lone link opens in the PC's browser; anything else goes on its clipboard. */
export function sendText(conn: Connection, text: string) {
  return request<{ action: 'opened' | 'copied' }>(conn, '/api/drop/text', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export function deleteDropFile(conn: Connection, name: string) {
  return request<{ ok: true }>(conn, fileUrl(name), { method: 'DELETE' });
}

const fileUrl = (name: string) => `/api/drop/files/${encodeURIComponent(name)}`;
const auth = (conn: Connection) => ({ Authorization: `Bearer ${conn.token}` });
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Resolves to the name it was saved under, which gets " (2)" when the name was taken. */
export async function uploadFile(conn: Connection, file: File, name: string, onProgress: (fraction: number) => void) {
  let result;
  try {
    result = await file.upload(`${conn.url}${fileUrl(name)}`, {
      httpMethod: 'PUT',
      headers: auth(conn),
      // Typed as numbers, but the native side sends Int64s, which arrive as BigInts.
      onProgress: ({ bytesSent, totalBytes }) => totalBytes > 0 && onProgress(Number(bytesSent) / Number(totalBytes)),
    });
  } catch (e) {
    throw new Error(`Can't reach ${conn.url} (${reason(e)}). Is Tailscale connected?`);
  }
  let body: { name?: string; error?: string } | undefined;
  try {
    body = JSON.parse(result.body);
  } catch {}
  if (result.status === 401) throw new Error('The server rejected the token. Check it in Settings.');
  if (result.status < 200 || result.status >= 300) throw new Error(body?.error ?? `The server answered ${result.status}.`);
  return body?.name ?? name;
}

/** Downloads into the cache, replacing an earlier copy. */
export async function downloadFile(conn: Connection, name: string, onProgress: (fraction: number) => void) {
  const folder = new Directory(Paths.cache, 'drop');
  folder.create({ idempotent: true, intermediates: true });
  try {
    return await File.downloadFileAsync(`${conn.url}${fileUrl(name)}`, new File(folder, name), {
      headers: auth(conn),
      idempotent: true,
      onProgress: ({ bytesWritten, totalBytes }) =>
        totalBytes > 0 && onProgress(Number(bytesWritten) / Number(totalBytes)),
    });
  } catch (e) {
    throw new Error(`Couldn't download ${name} (${reason(e)}).`);
  }
}

export type Picked = { file: File; name: string };

export async function pickFiles(): Promise<Picked[]> {
  const picked = await File.pickFileAsync({ multipleFiles: true });
  return picked.canceled ? [] : picked.result.map((file) => ({ file, name: file.name }));
}

// expo-image-picker came after the first builds; requiring it without its native module is a
// fatal error, so check first (see src/miniapps/jellyfin/settings.tsx).
let imagePicker: typeof import('expo-image-picker') | null | undefined;
function loadImagePicker() {
  if (imagePicker === undefined) {
    imagePicker = requireOptionalNativeModule('ExponentImagePicker')
      ? // eslint-disable-next-line @typescript-eslint/no-require-imports
        (require('expo-image-picker') as typeof import('expo-image-picker'))
      : null;
  }
  return imagePicker;
}

/** False on builds made before the photo picker was added. */
export const canPickPhotos = () => !!loadImagePicker();

export async function pickPhotos(): Promise<Picked[]> {
  const ImagePicker = loadImagePicker();
  if (!ImagePicker) return [];
  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
  });
  if (picked.canceled) return [];
  return picked.assets.map((asset) => {
    const file = new File(asset.uri);
    return { file, name: asset.fileName ?? file.name };
  });
}
