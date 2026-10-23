import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';

/** Goes up each time a call changes something on the server: playback, watched, favorites, playlists. */
let version = 0;

/** Changes made elsewhere (the TV, another phone) don't count up `version`; this old, reload anyway. */
const STALE_MS = 5 * 60_000;

export function noteChange() {
  version++;
}

/**
 * Calls `reload` when the screen comes back into view after something changed here (like coming
 * back from the player), or once what it shows is a few minutes old, rather than on every return.
 */
export function useReloadAfterChanges(reload: () => void) {
  const seen = useRef<{ version: number; at: number }>(undefined);
  useFocusEffect(
    useCallback(() => {
      const now = Date.now();
      const last = seen.current;
      seen.current = { version, at: last && last.version === version && now - last.at < STALE_MS ? last.at : now };
      // The first focus is the screen's own first load.
      if (!last || (last.version === version && now - last.at < STALE_MS)) return;
      reload();
    }, [reload]),
  );
}
