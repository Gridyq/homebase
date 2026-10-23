import { router, Stack } from 'expo-router';

import { Centered } from '@/miniapps/jellyfin/components';
import { useServerConnection } from '@/miniapps/server/connection';

// See src/app/jellyfin/_layout.tsx: a native toolbar button renders as a round Liquid Glass icon.
const backToLauncher = (
  <Stack.Toolbar placement="left">
    <Stack.Toolbar.Button icon="chevron.left" onPress={() => router.dismissTo('/')}>
      Apps
    </Stack.Toolbar.Button>
  </Stack.Toolbar>
);

// Downloads run on the home server's status service, so this shares the Server mini-app's
// connection.
export default function VideosLayout() {
  const { loading } = useServerConnection();
  if (loading) return <Centered loading />;

  return (
    <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="index" options={{ title: 'Videos', headerLargeTitle: true }}>
        {backToLauncher}
      </Stack.Screen>
    </Stack>
  );
}
