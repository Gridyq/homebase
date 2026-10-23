import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

/** What `usePolling` and `useLive` have in common: data for a key, and whether it's current. */
export type KeyedData<T> = {
  /** Last good value; kept through failed loads so the screen doesn't blank out. */
  data: T | undefined;
  /** Error from the latest load, cleared by the next value that arrives. */
  error: Error | undefined;
  /**
   * `data` isn't current: it's from before the app was last in the background, or (with
   * `keepPrevious`) from an earlier key. Cleared by the next value that arrives.
   */
  stale: boolean;
  /** Load again now. */
  refresh: () => Promise<void>;
};

/**
 * The state behind `usePolling` and `useLive`. Changing `key` drops the old data (or, with
 * `keepPrevious`, marks it stale) and ignores anything that comes back for the old key.
 * `accept(gen, value)` takes a value from elsewhere (a socket), if `gen` is still current.
 */
export function useKeyedData<T>(load: () => Promise<T>, key: string, keepPrevious: boolean) {
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

  const accept = useCallback((gen: number, next: T) => {
    if (gen !== generation.current) return;
    setData(next);
    setError(undefined);
    setStale(false);
  }, []);

  const refresh = useCallback(async () => {
    const gen = generation.current;
    try {
      accept(gen, await loadRef.current());
    } catch (e) {
      if (gen !== generation.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
      setStale(false);
    }
  }, [accept]);

  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      setForeground(s === 'active');
      // Whatever was on screen may be hours old by the time the app comes back.
      if (s !== 'active') setStale(true);
    });
    return () => sub.remove();
  }, []);

  const state: KeyedData<T> = { data, error, stale: stale && data !== undefined, refresh };
  return { state, foreground, generation, accept };
}
