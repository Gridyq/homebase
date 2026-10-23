import { Stack } from 'expo-router';

import { backToLauncher } from '@/components/back-to-launcher';
import { Centered } from '@/components/centered';
import { useJellyfinSession } from '@/miniapps/jellyfin/session';

// History comes from Jellyfin, so this shares the Jellyfin mini-app's sign-in.
export default function HistoryLayout() {
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
