import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { Centered, ItemRow } from '@/miniapps/jellyfin/components';
import { useJellyfin, useJellyfinSession } from '@/miniapps/jellyfin/session';
import { useAsync } from '@/miniapps/jellyfin/use-async';

export default function JellyfinHome() {
  const client = useJellyfin();
  const { signOut } = useJellyfinSession();
  const theme = useTheme();

  const { data, error, loading, reload } = useAsync(
    () => Promise.all([client.resume(), client.nextUp(), client.libraries()]),
    'home',
  );

  // Refresh "Continue watching" when coming back from the player.
  const focusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedOnce.current) reload();
      focusedOnce.current = true;
    }, [reload]),
  );

  const confirmSignOut = () =>
    Alert.alert(`Sign out of ${client.session.serverName}?`, `Signed in as ${client.session.userName}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: signOut },
    ]);

  const header = (
    <Stack.Screen
      options={{
        headerRight: () => (
          <Pressable onPress={confirmSignOut} hitSlop={12}>
            <ThemedText style={{ color: theme.accent }}>{client.session.userName}</ThemedText>
          </Pressable>
        ),
      }}
    />
  );

  if (!data) {
    return (
      <>
        {header}
        <Centered loading={loading} error={error} onRetry={reload} />
      </>
    );
  }

  const [resume, nextUp, libraries] = data;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}>
      {header}
      <ItemRow title="Continue watching" items={resume} shape="wide" />
      <ItemRow title="Next up" items={nextUp} shape="wide" />
      <ItemRow title="Libraries" items={libraries} shape="wide" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.four,
  },
});
