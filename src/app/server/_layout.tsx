import { router, Stack } from 'expo-router';

import { Centered } from '@/miniapps/jellyfin/components';
import { ServerConnectionProvider, useServerConnection } from '@/miniapps/server/connection';

// Opening the pairing link from a cold start lands on `connect`; keep the dashboard under it so
// saving can go back to it.
export const unstable_settings = { initialRouteName: 'index' };

// See src/app/jellyfin/_layout.tsx: a native toolbar button renders as a round Liquid Glass icon.
const backToLauncher = (
  <Stack.Toolbar placement="left">
    <Stack.Toolbar.Button icon="chevron.left" onPress={() => router.dismissTo('/')}>
      Apps
    </Stack.Toolbar.Button>
  </Stack.Toolbar>
);

function ServerStack() {
  const { loading } = useServerConnection();
  if (loading) return <Centered loading />;

  return (
    <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="index" options={{ title: 'Server', headerLargeTitle: true }}>
        {backToLauncher}
      </Stack.Screen>
      <Stack.Screen name="connect" options={{ title: 'Connection' }} />
    </Stack>
  );
}

export default function ServerLayout() {
  return (
    <ServerConnectionProvider>
      <ServerStack />
    </ServerConnectionProvider>
  );
}
