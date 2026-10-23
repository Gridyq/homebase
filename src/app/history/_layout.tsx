import { router, Stack } from 'expo-router';

import { Centered } from '@/miniapps/jellyfin/components';
import { JellyfinSessionProvider, useJellyfinSession } from '@/miniapps/jellyfin/session';

// See src/app/jellyfin/_layout.tsx: a native toolbar button renders as a round Liquid Glass icon.
const backToLauncher = (
  <Stack.Toolbar placement="left">
    <Stack.Toolbar.Button icon="chevron.left" onPress={() => router.dismissTo('/')}>
      Apps
    </Stack.Toolbar.Button>
  </Stack.Toolbar>
);

function HistoryStack() {
  const { loading } = useJellyfinSession();
  if (loading) return <Centered loading />;

  return (
    <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="index" options={{ title: 'Watch History', headerLargeTitle: true }}>
        {backToLauncher}
      </Stack.Screen>
    </Stack>
  );
}

// History comes from Jellyfin, so this shares the Jellyfin mini-app's sign-in.
export default function HistoryLayout() {
  return (
    <JellyfinSessionProvider>
      <HistoryStack />
    </JellyfinSessionProvider>
  );
}
