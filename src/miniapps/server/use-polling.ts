import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

type PollingState<T> = {
  /** Last good value; kept through failed polls so the screen doesn't blank out. */
  data: T | undefined;
  /** Error from the latest poll, cleared by the next successful one. */
  error: Error | undefined;
  /**
   * `data` isn't current: it's from before the app was last in the background, or (with
   * `keepPrevious`) from an earlier key. Cleared by the next poll that answers.
   */
  stale: boolean;
  /** Load again now, without waiting for the next tick. */
  refresh: () => Promise<void>;
};

type PollingOptions = {
  /** While false it doesn't call at all. */
  enabled?: boolean;
  /** Keep showing the old key's data (marked `stale`) until the new key's arrives. */
  keepPrevious?: boolean;
};

/**
 * Call `load` every `intervalMs` while the screen is focused and the app is in the foreground.
 * Waits for each call to finish before scheduling the next, so a slow server doesn't pile up
 * requests. Changing `key` drops the old data and starts over, unless `keepPrevious` is set.
 */
export function usePolling<T>(
  load: () => Promise<T>,
  intervalMs: number,
  key: string,
  { enabled = true, keepPrevious = false }: PollingOptions = {},
): PollingState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [stale, setStale] = useState(false);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  // Counts up on every key change, so results that come back for an old key are ignored.
  const generation = useRef(0);
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    if (keepPrevious) {
      setStale(true);
    } else {
      setData(undefined);
      setStale(false);
    }
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
      // Whatever was on screen may be hours old by the time the app comes back.
      if (s !== 'active') setStale(true);
    });
    return () => sub.remove();
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!foreground || !enabled) return;
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
    }, [foreground, enabled, intervalMs, refresh, key]),
  );

  return { data, error, stale: stale && data !== undefined, refresh };
}
