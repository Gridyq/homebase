import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { Connection } from './api';

/** What `/api/live` can send; each matches the endpoint the screen would otherwise poll. */
export type LiveTopic = 'status' | 'conversions' | 'sessions';

type LiveState<T> = {
  /** Last good value, from the socket or a poll. */
  data: T | undefined;
  /** Error from the latest poll, cleared by the next value that arrives. */
  error: Error | undefined;
  /** `data` is from before the app was last in the background. */
  stale: boolean;
  /** Whether values are arriving over the socket rather than by polling. */
  live: boolean;
  /** Load again now. */
  refresh: () => Promise<void>;
};

/** React Native's WebSocket takes headers, which the DOM typings it's checked against don't know. */
const NativeWebSocket = WebSocket as unknown as new (
  url: string,
  protocols: undefined,
  options: { headers: Record<string, string> },
) => WebSocket;

/** How long to wait before opening the socket again after it closes. */
const RECONNECT_MS = 5000;

/**
 * Like `usePolling`, but the server sends `topic` over a WebSocket as it changes, so the screen
 * keeps up without asking. While the socket is down (an older server, Tailscale reconnecting), it
 * polls with `load` every `fallbackMs` and keeps trying the socket. Only runs while the screen is
 * focused and the app is in the foreground.
 */
export function useLive<T>(conn: Connection, topic: LiveTopic, load: () => Promise<T>, fallbackMs: number): LiveState<T> {
  const key = `${conn.url}|${conn.token}|${topic}`;
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [stale, setStale] = useState(false);
  const [live, setLive] = useState(false);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  // Results that come back for an earlier key are ignored.
  const generation = useRef(0);
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setData(undefined);
    setError(undefined);
    setStale(false);
  }
  useEffect(() => {
    generation.current++;
  }, [key]);

  const refresh = useCallback(async () => {
    const gen = generation.current;
    try {
      const next = await loadRef.current();
      if (gen !== generation.current) return;
      setData(next);
      setError(undefined);
      setStale(false);
    } catch (e) {
      if (gen !== generation.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
      setStale(false);
    }
  }, []);

  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      setForeground(s === 'active');
      if (s !== 'active') setStale(true);
    });
    return () => sub.remove();
  }, []);

  // The socket, reopened after it closes.
  useFocusEffect(
    useCallback(() => {
      if (!foreground) return;
      let stopped = false;
      let socket: WebSocket | undefined;
      let retry: ReturnType<typeof setTimeout>;
      const gen = generation.current;
      const open = () => {
        const url = `${conn.url.replace(/^http/i, 'ws')}/api/live?topics=${topic}`;
        socket = new NativeWebSocket(url, undefined, { headers: { Authorization: `Bearer ${conn.token}` } });
        socket.onmessage = (e) => {
          if (gen !== generation.current) return;
          try {
            const message = JSON.parse(String(e.data)) as { topic: string; data: T };
            if (message.topic !== topic) return;
            setData(message.data);
            setError(undefined);
            setStale(false);
            setLive(true);
          } catch {
            // A message this version doesn't understand.
          }
        };
        socket.onclose = () => {
          setLive(false);
          if (!stopped) retry = setTimeout(open, RECONNECT_MS);
        };
      };
      open();
      return () => {
        stopped = true;
        clearTimeout(retry);
        socket?.close();
        setLive(false);
      };
    }, [foreground, conn.url, conn.token, topic]),
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

  return { data, error, stale: stale && data !== undefined, live, refresh };
}
