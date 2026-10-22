import { router, Stack } from 'expo-router';
import { Pressable } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import { JellyfinSessionProvider, useJellyfinSession } from '@/miniapps/jellyfin/session';

function BackToLauncher() {
  const theme = useTheme();
  return (
    <Pressable onPress={() => router.dismissTo('/')} hitSlop={12}>
      <ThemedText style={{ color: theme.accent }}>Apps</ThemedText>
    </Pressable>
  );
}

function JellyfinStack() {
  const { loading, client } = useJellyfinSession();
  if (loading) return <Centered loading />;

  return (
    <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Protected guard={!!client}>
        <Stack.Screen
          name="index"
          options={{ title: 'Jellyfin', headerLargeTitle: true, headerLeft: () => <BackToLauncher /> }}
        />
        <Stack.Screen name="library/[id]" options={{ title: '' }} />
        <Stack.Screen name="item/[id]" options={{ title: '' }} />
        <Stack.Screen
          name="player/[id]"
          options={{ presentation: 'fullScreenModal', headerShown: false, animation: 'fade' }}
        />
      </Stack.Protected>
      <Stack.Protected guard={!client}>
        <Stack.Screen
          name="login"
          options={{ title: 'Sign in', headerLeft: () => <BackToLauncher /> }}
        />
      </Stack.Protected>
    </Stack>
  );
}

export default function JellyfinLayout() {
  return (
    <JellyfinSessionProvider>
      <JellyfinStack />
    </JellyfinSessionProvider>
  );
}
