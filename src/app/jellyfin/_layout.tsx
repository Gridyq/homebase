import { router, Stack } from 'expo-router';

import { Centered } from '@/miniapps/jellyfin/components';
import { JellyfinSessionProvider, useJellyfinSession } from '@/miniapps/jellyfin/session';
import { JellyfinSettingsProvider } from '@/miniapps/jellyfin/settings';

// A native toolbar button renders as a round Liquid Glass icon; a custom headerLeft view gets
// stretched into a pill around its text. An element, not a component: Stack.Screen only picks up a
// Stack.Toolbar that is its direct child.
const backToLauncher = (
  <Stack.Toolbar placement="left">
    <Stack.Toolbar.Button icon="chevron.left" onPress={() => router.dismissTo('/')}>
      Apps
    </Stack.Toolbar.Button>
  </Stack.Toolbar>
);

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
    <JellyfinSessionProvider>
      <JellyfinSettingsProvider>
        <JellyfinStack />
      </JellyfinSettingsProvider>
    </JellyfinSessionProvider>
  );
}
