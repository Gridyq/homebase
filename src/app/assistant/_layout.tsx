import { Stack } from 'expo-router';

import { backToLauncher } from '@/components/back-to-launcher';
import { Centered } from '@/components/centered';
import { useServerConnection } from '@/miniapps/server/connection';

// The model runs on the home server and its status service keeps the chats, so this shares the
// Server mini-app's connection.
export default function AssistantLayout() {
  const { loading } = useServerConnection();
  if (loading) return <Centered loading />;

  return (
    <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="index" options={{ title: 'Assistant', headerLargeTitle: true }}>
        {backToLauncher}
      </Stack.Screen>
      <Stack.Screen name="[id]" options={{ title: '' }} />
    </Stack>
  );
}
