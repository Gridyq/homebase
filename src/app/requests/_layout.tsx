import { Stack } from 'expo-router';

import { backToLauncher } from '@/components/back-to-launcher';
import { Centered } from '@/components/centered';
import { useServerConnection } from '@/miniapps/server/connection';

// Requests go through the home server's status service, so this shares the Server mini-app's
// connection.
export default function RequestsLayout() {
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
      <Stack.Screen name="conversions" options={{ title: 'Conversions' }} />
      <Stack.Screen name="cleanup" options={{ title: 'Download cleanup' }} />
    </Stack>
  );
}
