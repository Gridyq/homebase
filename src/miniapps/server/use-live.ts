import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import type { Connection } from './api';
import { useKeyedData, type KeyedData } from './use-keyed-data';

/** What `/api/live` can send; each matches the endpoint the screen would otherwise poll. */
export type LiveTopic = 'status' | 'conversions' | 'sessions';

type LiveState<T> = KeyedData<T> & {
  /** Whether values are arriving over the socket rather than by polling. */
  live: boolean;
};

/** React Native's WebSocket takes headers, which the DOM typings it's checked against don't know. */
const NativeWebSocket = WebSocket as unknown as new (
  url: string,
  protocols: undefined,
  options: { headers: Record<string, string> },
) => WebSocket;

/** How long to wait before opening the socket again after it closes, doubling up to the max. */
const RECONNECT_MS = 5000;
const RECONNECT_MAX_MS = 60_000;
/**
 * The server sends something at least every 25 s. A socket quiet for longer has died without
 * closing, as when the phone moves from Wi-Fi to cellular.
 */
const SILENT_MS = 60_000;

/**
 * Like `usePolling`, but the server sends `topic` over a WebSocket as it changes, so the screen
 * keeps up without asking. While the socket is down (an older server, Tailscale reconnecting), it
 * polls with `load` every `fallbackMs` and keeps trying the socket. Only runs while the screen is
 * focused and the app is in the foreground.
 */
export function useLive<T>(conn: Connection, topic: LiveTopic, load: () => Promise<T>, fallbackMs: number): LiveState<T> {
  const key = `${conn.url}|${conn.token}|${topic}`;
  const { state, foreground, generation, accept } = useKeyedData(load, key, false);
  const { refresh } = state;
  const [live, setLive] = useState(false);

  // The socket, reopened after it closes.
  useFocusEffect(
    useCallback(() => {
      if (!foreground) return;
      let stopped = false;
      let socket: WebSocket | undefined;
      let retry: ReturnType<typeof setTimeout>;
      let delay = RECONNECT_MS;
      let heardAt = 0;
      const gen = generation.current;
      // Handlers come off first, so a socket that's been let go can't reach the screen.
      const drop = () => {
        if (!socket) return;
        socket.onmessage = socket.onclose = socket.onerror = null;
        socket.close();
        socket = undefined;
      };
      const reconnect = () => {
        drop();
        setLive(false);
        if (stopped) return;
        retry = setTimeout(open, delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      };
      const open = () => {
        const url = `${conn.url.replace(/^http/i, 'ws')}/api/live?topics=${topic}`;
        socket = new NativeWebSocket(url, undefined, { headers: { Authorization: `Bearer ${conn.token}` } });
        heardAt = Date.now();
        socket.onmessage = (e) => {
          heardAt = Date.now();
          delay = RECONNECT_MS;
          if (gen !== generation.current) return;
          try {
            const message = JSON.parse(String(e.data)) as { topic: string; data: T };
            if (message.topic !== topic) return;
            accept(gen, message.data);
            setLive(true);
          } catch {
            // A message this version doesn't understand.
          }
        };
        socket.onerror = (e) => {
          // A wrong token won't come right by trying again; polling shows the error meanwhile.
          if (/\b401\b/.test(String((e as Event & { message?: string }).message))) {
            stopped = true;
            drop();
            setLive(false);
          }
        };
        socket.onclose = reconnect;
      };
      const watchdog = setInterval(() => {
        if (socket && Date.now() - heardAt > SILENT_MS) reconnect();
      }, 10_000);
      open();
      return () => {
        stopped = true;
        clearTimeout(retry);
        clearInterval(watchdog);
        drop();
        setLive(false);
      };
    }, [foreground, conn.url, conn.token, topic, accept, generation]),
  );

  // Polling, while the socket isn't delivering.
  useFocusEffect(
    useCallback(() => {
      if (!foreground || live) return;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout>;
      const tick = async () => {
        await refresh();
        if (!stopped) timer = setTimeout(tick, fallbackMs);
      };
      tick();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
      // `key` restarts the loop so the new key loads right away.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [foreground, live, fallbackMs, refresh, key]),
  );

  return { ...state, live };
}
