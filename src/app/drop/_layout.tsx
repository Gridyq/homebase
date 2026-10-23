import { Stack } from 'expo-router';

import { backToLauncher } from '@/components/back-to-launcher';
import { Centered } from '@/components/centered';
import { useServerConnection } from '@/miniapps/server/connection';

// Drop goes through the home server's status service, so this shares the Server mini-app's
// connection.
export default function DropLayout() {
  const { loading } = useServerConnection();
  if (loading) return <Centered loading />;

  return (
    <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="index" options={{ title: 'Drop', headerLargeTitle: true }}>
        {backToLauncher}
      </Stack.Screen>
    </Stack>
  );
}
