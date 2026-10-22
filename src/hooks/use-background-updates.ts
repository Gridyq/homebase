import * as Updates from 'expo-updates';
import { usePathname } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

/**
 * expo-updates checks the update server on cold start. This also checks whenever the app comes
 * back to the foreground, and switches to a downloaded update when the app goes to the background,
 * so the restart happens out of sight instead of flashing a reload screen.
 */
export function useBackgroundUpdates() {
  const theme = useTheme();
  const pathname = usePathname();
  const { isUpdatePending } = Updates.useUpdates();

  useEffect(() => {
    if (!Updates.isEnabled) return;
    const sub = AppState.addEventListener('change', async (state) => {
      if (state === 'active') {
        try {
          const { isAvailable } = await Updates.checkForUpdateAsync();
          if (isAvailable) await Updates.fetchUpdateAsync();
        } catch {
          // Update server unreachable (e.g. away from home without Tailscale); try again later.
        }
      } else if (state === 'background' && isUpdatePending && !pathname.includes('/player/')) {
        // Not while the player is open: video keeps playing in the background and in PiP.
        // The reload screen is normally hidden by then; match the app in case it's caught on return.
        Updates.reloadAsync({
          reloadScreenOptions: { backgroundColor: theme.background, spinner: { enabled: false }, fade: true },
        }).catch(() => {});
      }
    });
    return () => sub.remove();
  }, [isUpdatePending, pathname, theme.background]);
}
