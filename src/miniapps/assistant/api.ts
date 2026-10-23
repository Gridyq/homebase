import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import { fetch } from 'expo/fetch';

import { loadImagePicker } from '@/miniapps/drop/api';
import { refused, request, ServerError, unreachable, type Connection } from '@/miniapps/server/api';

/**
 * The status server's Assistant endpoints. Chats are kept on the server and answered by a model
 * running there, which it starts on the first question and stops when it's been idle a while.
 */

export type AssistantModel = {
  id: string;
  name: string;
  /** Can think a question through before answering. */
  thinking: boolean;
  /** Can look at photos. */
  vision: boolean;
  state: 'running' | 'starting' | 'stopped';
};

export type AssistantState = { models: AssistantModel[]; gameMode: boolean };

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  /** Photo ids, for a question that came with photos. */
  images?: string[];
  reasoning?: string;
  /** What it looked at on the server before answering, in order. */
  steps?: { label: string }[];
  model?: string;
  at: number;
  /** Still being written. */
  pending?: boolean;
  /** Stopped before it finished. */
  stopped?: boolean;
  /** Ran into the length limit. */
  cutOff?: boolean;
  error?: string;
};

export type Chat = {
  id: string;
  title: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

export type ChatSummary = {
  id: string;
  title: string;
  model?: string;
  updatedAt: number;
  preview: string;
  answering: boolean;
};

export type AnswerEvent =
  | { type: 'status'; text: string }
  | { type: 'reasoning' | 'content'; text: string }
  | { type: 'step'; label: string }
  | { type: 'done'; message: ChatMessage }
  | { type: 'error'; error: string };

export function assistantState(conn: Connection) {
  return request<AssistantState>(conn, '/api/assistant');
}

export function listChats(conn: Connection) {
  return request<ChatSummary[]>(conn, '/api/assistant/chats');
}

/** Undefined for a chat that hasn't been started yet. */
export async function getChat(conn: Connection, id: string) {
  try {
    return await request<Chat>(conn, `/api/assistant/chats/${id}`);
  } catch (e) {
    if (e instanceof ServerError && e.status === 404) return undefined;
    throw e;
  }
}

export function deleteChat(conn: Connection, id: string) {
  return request<{ ok: true }>(conn, `/api/assistant/chats/${id}`, { method: 'DELETE' });
}

export function stopAnswer(conn: Connection, id: string) {
  return request<{ ok: true }>(conn, `/api/assistant/chats/${id}/stop`, { method: 'POST' });
}

/** A fresh id for a chat; the server makes the chat when the first question arrives. */
export function newChatId() {
  return Crypto.randomUUID();
}

/**
 * Asks a question and calls `onEvent` with each piece of the answer as it's written. The server
 * keeps going if this connection drops, so a dropped stream can be picked up with getChat.
 */
export async function ask(
  conn: Connection,
  id: string,
  question: { text: string; images: string[]; model?: string; think: boolean },
  onEvent: (event: AnswerEvent) => void,
  signal?: AbortSignal,
) {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(`${conn.url}/api/assistant/chats/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(question),
      signal,
    });
  } catch (e) {
    throw unreachable(conn, e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) throw refused(res.status, await res.json().catch(() => undefined));
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line) onEvent(JSON.parse(line));
  }
  // The last event, if the stream ended without a newline after it.
  buffer += decoder.decode();
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}

/** Most photos one question can carry. */
export const PHOTOS_PER_QUESTION = 4;

/** Sends a photo ahead of the question it goes with; the server keeps a smaller copy. */
export async function uploadPhoto(conn: Connection, uri: string) {
  let result;
  try {
    result = await new File(uri).upload(`${conn.url}/api/assistant/images`, {
      httpMethod: 'POST',
      headers: { Authorization: `Bearer ${conn.token}` },
    });
  } catch (e) {
    throw unreachable(conn, e instanceof Error ? e.message : String(e));
  }
  let body: { id?: string; error?: string } | undefined;
  try {
    body = JSON.parse(result.body);
  } catch {}
  if (result.status < 200 || result.status >= 300 || !body?.id) throw refused(result.status, body);
  return body.id;
}

/** For expo-image: a photo the server keeps, which never changes once saved. */
export function photoSource(conn: Connection, id: string) {
  return { uri: `${conn.url}/api/assistant/images/${id}`, headers: { Authorization: `Bearer ${conn.token}` }, cacheKey: `assistant-photo-${id}` };
}

/** False on builds made before the photo picker was added. */
export const canAddPhotos = () => !!loadImagePicker();

/** Photos from the library or the camera, as local file URIs. */
export async function pickPhotos(from: 'library' | 'camera', limit: number): Promise<string[]> {
  const ImagePicker = loadImagePicker();
  if (!ImagePicker) return [];
  if (from === 'camera') {
    const { granted } = await ImagePicker.requestCameraPermissionsAsync();
    if (!granted) throw new Error('Homebase isn’t allowed to use the camera. Turn it on in Settings › Homebase.');
    const shot = await ImagePicker.launchCameraAsync({ mediaTypes: 'images', quality: 0.8 });
    return shot.canceled ? [] : shot.assets.map((a) => a.uri);
  }
  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: 'images',
    allowsMultipleSelection: true,
    selectionLimit: limit,
    quality: 0.8,
    // JPEG rather than HEIC, which the server can't read.
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  });
  return picked.canceled ? [] : picked.assets.slice(0, limit).map((a) => a.uri);
}
