import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { useKeyedData, type KeyedData } from './use-keyed-data';

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
): KeyedData<T> {
  const { state, foreground } = useKeyedData(load, key, keepPrevious);
  const { refresh } = state;

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

  return state;
}

/**
 * A history screen's data: polled for the range picked, which starts at `initialRange`. Changing
 * the range keeps the old range's data on screen (marked stale) until the new one's arrives.
 */
export function useRangedPolling<T>(initialRange: number, load: (range: number) => Promise<T>, intervalMs: number, key: string) {
  const [range, setRange] = useState(initialRange);
  const polled = usePolling(() => load(range), intervalMs, `${key}|${range}`, { keepPrevious: true });
  return { ...polled, range, setRange };
}
