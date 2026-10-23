import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** A screen that's loading, or that failed to, with a way to try again. */
export function Centered({ loading, error, onRetry }: { loading?: boolean; error?: Error; onRetry?: () => void }) {
  const theme = useTheme();
  return (
    <View style={[styles.centered, { backgroundColor: theme.background }]}>
      {loading ? <ActivityIndicator /> : null}
      {error ? (
        <>
          <ThemedText themeColor="textSecondary" style={{ textAlign: 'center' }}>
            {error.message}
          </ThemedText>
          {onRetry ? <Button title="Try again" onPress={onRetry} /> : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    gap: Spacing.three,
  },
});
