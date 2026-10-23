import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';

/** Goes up each time a call changes something on the server: playback, watched, favorites, playlists. */
let version = 0;

export function noteChange() {
  version++;
}

/**
 * Calls `reload` when the screen comes back into view after something changed (like coming back
 * from the player), rather than on every return.
 */
export function useReloadAfterChanges(reload: () => void) {
  const seen = useRef(version);
  useFocusEffect(
    useCallback(() => {
      if (seen.current === version) return;
      seen.current = version;
      reload();
    }, [reload]),
  );
}
