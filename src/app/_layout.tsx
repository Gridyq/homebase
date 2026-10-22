import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';

import { useBackgroundUpdates } from '@/hooks/use-background-updates';

export default function RootLayout() {
  const colorScheme = useColorScheme();
  useBackgroundUpdates();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="index" options={{ title: 'Apps', headerLargeTitle: true }} />
        <Stack.Screen name="jellyfin" options={{ headerShown: false }} />
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
    </ThemeProvider>
  );
}
