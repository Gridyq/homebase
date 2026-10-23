import { DarkTheme, DefaultTheme, Stack, ThemeProvider, type ErrorBoundaryProps } from 'expo-router';
import { useEffect } from 'react';
import { ScrollView, StyleSheet, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { useBackgroundUpdates } from '@/hooks/use-background-updates';
import { describeError, installCrashRecorder, sendCrashReport, useCrashReports } from '@/hooks/use-crash-reports';
import { JellyfinSessionProvider } from '@/miniapps/jellyfin/session';
import { ServerConnectionProvider } from '@/miniapps/server/connection';

installCrashRecorder();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  useBackgroundUpdates();
  useCrashReports();
  return (
    // One connection and one sign-in for all the mini-apps, so connecting or signing in from one
    // shows in the others.
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <ServerConnectionProvider>
        <JellyfinSessionProvider>
          <Stack>
            <Stack.Screen name="index" options={{ title: 'Apps', headerLargeTitle: true }} />
            <Stack.Screen name="jellyfin" options={{ headerShown: false }} />
            <Stack.Screen name="server" options={{ headerShown: false }} />
            <Stack.Screen name="requests" options={{ headerShown: false }} />
            <Stack.Screen name="drop" options={{ headerShown: false }} />
            <Stack.Screen name="videos" options={{ headerShown: false }} />
            <Stack.Screen name="assistant" options={{ headerShown: false }} />
            <Stack.Screen name="history" options={{ headerShown: false }} />
            <Stack.Screen
              name="whats-new"
              options={{
                presentation: 'formSheet',
                headerShown: false,
                sheetAllowedDetents: 'fitToContents',
                sheetGrabberVisible: true,
              }}
            />
          </Stack>
        </JellyfinSessionProvider>
      </ServerConnectionProvider>
    </ThemeProvider>
  );
}

/** A screen that failed to render shows what went wrong instead of closing the app. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const theme = useTheme();
  useEffect(() => {
    sendCrashReport(describeError(error)).catch(() => {});
  }, [error]);
  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={styles.error}>
        <ThemedText type="subtitle">Something went wrong</ThemedText>
        <ThemedText selectable>{error.message}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" selectable>
          {error.stack}
        </ThemedText>
        <Button title="Try again" onPress={retry} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  error: {
    padding: Spacing.four,
    gap: Spacing.three,
  },
});
