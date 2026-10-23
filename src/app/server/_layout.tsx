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
      <Stack.Screen name="memory" options={{ title: 'Memory' }} />
      <Stack.Screen name="processes" options={{ title: 'Processes' }} />
      <Stack.Screen name="gpu" options={{ title: 'Graphics Card' }} />
      <Stack.Screen name="trends" options={{ title: 'Trends' }} />
      <Stack.Screen name="reliability" options={{ title: 'Reliability' }} />
      <Stack.Screen name="cpu" options={{ title: 'CPU' }} />
      <Stack.Screen name="drives" options={{ title: 'Drives' }} />
      <Stack.Screen name="drive/[id]" options={{ title: '' }} />
      <Stack.Screen name="network" options={{ title: 'Network' }} />
      <Stack.Screen name="device/[name]" options={{ title: '' }} />
      <Stack.Screen name="power" options={{ title: 'Power' }} />
      <Stack.Screen name="storage" options={{ title: 'Media Drive' }} />
      <Stack.Screen name="tailscale" options={{ title: 'Tailscale' }} />
      <Stack.Screen name="updates" options={{ title: 'Updates' }} />
      <Stack.Screen name="service/[id]" options={{ title: '' }} />
      <Stack.Screen name="logs/[id]" options={{ title: 'Logs' }} />
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
