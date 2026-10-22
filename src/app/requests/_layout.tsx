import { router, Stack } from 'expo-router';

import { Centered } from '@/miniapps/jellyfin/components';
import { ServerConnectionProvider, useServerConnection } from '@/miniapps/server/connection';

// See src/app/jellyfin/_layout.tsx: a native toolbar button renders as a round Liquid Glass icon.
const backToLauncher = (
  <Stack.Toolbar placement="left">
    <Stack.Toolbar.Button icon="chevron.left" onPress={() => router.dismissTo('/')}>
      Apps
    </Stack.Toolbar.Button>
  </Stack.Toolbar>
);

function RequestsStack() {
  const { loading } = useServerConnection();
  if (loading) return <Centered loading />;

  return (
    <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="index" options={{ title: 'Requests', headerLargeTitle: true }}>
        {backToLauncher}
      </Stack.Screen>
      <Stack.Screen name="[type]/[id]" options={{ title: '' }} />
      <Stack.Screen name="releases" options={{ title: 'Releases' }} />
      <Stack.Screen name="library" options={{ title: 'Library' }} />
    </Stack>
  );
}

// Requests go through the home server's status service, so this shares the Server mini-app's
// connection.
export default function RequestsLayout() {
  return (
    <ServerConnectionProvider>
      <RequestsStack />
    </ServerConnectionProvider>
  );
}
