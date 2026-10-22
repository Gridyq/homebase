import * as Updates from 'expo-updates';
import { useEffect } from 'react';
import { AppState, Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * expo-updates checks the update server on cold start. This also checks whenever the app comes
 * back to the foreground, and offers a restart once an update has downloaded.
 */
export function UpdateBanner() {
  const theme = useTheme();
  const { isUpdatePending } = Updates.useUpdates();

  useEffect(() => {
    if (!Updates.isEnabled) return;
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;
      try {
        const { isAvailable } = await Updates.checkForUpdateAsync();
        if (isAvailable) await Updates.fetchUpdateAsync();
      } catch {
        // Update server unreachable (e.g. away from home without Tailscale); try again later.
      }
    });
    return () => sub.remove();
  }, []);

  if (!isUpdatePending) return null;
  return (
    <Pressable
      onPress={() => Updates.reloadAsync()}
      style={({ pressed }) => [styles.banner, { backgroundColor: theme.accent, opacity: pressed ? 0.7 : 1 }]}>
      <ThemedText type="smallBold" style={styles.text}>
        Update ready. Tap to restart.
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    width: '100%',
    padding: Spacing.three,
    borderRadius: 12,
  },
  text: {
    color: '#fff',
    textAlign: 'center',
  },
});
