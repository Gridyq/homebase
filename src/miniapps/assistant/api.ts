import * as Crypto from 'expo-crypto';
import { fetch } from 'expo/fetch';

import { request, type Connection } from '@/miniapps/server/api';

/**
 * The status server's Assistant endpoints. Chats are kept on the server and answered by a model
 * running there, which it starts on the first question and stops when it's been idle a while.
 */

export type AssistantModel = {
  id: string;
  name: string;
  /** Can think a question through before answering. */
  thinking: boolean;
  state: 'running' | 'starting' | 'stopped';
};

export type AssistantState = { models: AssistantModel[]; gameMode: boolean };

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
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
    if (e instanceof Error && e.message === 'No such chat') return undefined;
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
  question: { text: string; model?: string; think: boolean },
  onEvent: (event: AnswerEvent) => void,
) {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(`${conn.url}/api/assistant/chats/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(question),
    });
  } catch (e) {
    throw new Error(`Can't reach ${conn.url} (${e instanceof Error ? e.message : String(e)}). Is Tailscale connected?`);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    if (res.status === 401) throw new Error('The server rejected the token. Check it in Settings.');
    throw new Error(body?.error ?? `The server answered ${res.status}.`);
  }
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
}
