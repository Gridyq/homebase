import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

type PollingState<T> = {
  /** Last good value; kept through failed polls so the screen doesn't blank out. */
  data: T | undefined;
  /** Error from the latest poll, cleared by the next successful one. */
  error: Error | undefined;
  /** Load again now, without waiting for the next tick. */
  refresh: () => Promise<void>;
};

/**
 * Call `load` every `intervalMs` while the screen is focused and the app is in the foreground.
 * Waits for each call to finish before scheduling the next, so a slow server doesn't pile up
 * requests. Changing `key` drops the old data and starts over.
 */
export function usePolling<T>(load: () => Promise<T>, intervalMs: number, key: string): PollingState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  // Counts up on every key change, so results that come back for an old key are ignored.
  const generation = useRef(0);
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setData(undefined);
    setError(undefined);
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
    } catch (e) {
      if (gen !== generation.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, []);

  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setForeground(s === 'active'));
    return () => sub.remove();
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!foreground) return;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout>;
      const tick = async () => {
        await refresh();
        if (!stopped) timer = setTimeout(tick, intervalMs);
      };
      tick();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
      // `key` restarts the loop so the new key loads right away.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [foreground, intervalMs, refresh, key]),
  );

  return { data, error, refresh };
}
