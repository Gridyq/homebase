import { Stack } from 'expo-router';

import { backToLauncher } from '@/components/back-to-launcher';
import { Centered } from '@/components/centered';
import { useJellyfinSession } from '@/miniapps/jellyfin/session';
import { JellyfinSettingsProvider } from '@/miniapps/jellyfin/settings';

function JellyfinStack() {
  const { loading, client } = useJellyfinSession();
  if (loading) return <Centered loading />;

  return (
    <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Protected guard={!!client}>
        <Stack.Screen name="index" options={{ title: 'Jellyfin', headerLargeTitle: true }}>
          {backToLauncher}
        </Stack.Screen>
        <Stack.Screen name="library/[id]" options={{ title: '' }} />
        <Stack.Screen name="item/[id]" options={{ title: '' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen
          name="player/[id]"
          options={{ presentation: 'fullScreenModal', headerShown: false, animation: 'fade' }}
        />
      </Stack.Protected>
      <Stack.Protected guard={!client}>
        <Stack.Screen name="login" options={{ title: 'Sign in' }}>
          {backToLauncher}
        </Stack.Screen>
      </Stack.Protected>
    </Stack>
  );
}

export default function JellyfinLayout() {
  return (
    <JellyfinSettingsProvider>
      <JellyfinStack />
    </JellyfinSettingsProvider>
  );
}
