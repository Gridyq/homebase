import { Alert, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Button, Chip } from '@/miniapps/jellyfin/components';
import { useJellyfin, useJellyfinSession } from '@/miniapps/jellyfin/session';
import { BITRATE_OPTIONS, useJellyfinSettings } from '@/miniapps/jellyfin/settings';

export default function JellyfinSettings() {
  const client = useJellyfin();
  const { signOut } = useJellyfinSession();
  const { settings, update } = useJellyfinSettings();
  const theme = useTheme();
  const gutter = useGutter();

  const confirmSignOut = () =>
    Alert.alert(`Sign out of ${client.session.serverName}?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: signOut },
    ]);

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.content, gutter]}>
      <BitratePicker
        title="Quality on Wi-Fi"
        value={settings.wifiBitrate}
        onChange={(value) => update({ wifiBitrate: value })}
      />
      <BitratePicker
        title="Quality on cellular"
        value={settings.cellularBitrate}
        onChange={(value) => update({ cellularBitrate: value })}
      />
      <ThemedText type="small" themeColor="textSecondary">
        Videos above the limit are converted by the server to a smaller stream. Takes effect the next time you
        start playing.
      </ThemedText>

      <View style={styles.account}>
        <ThemedText type="smallBold">Account</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {client.session.userName} on {client.session.serverName}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {client.session.serverUrl}
        </ThemedText>
        <Button title="Sign out" variant="secondary" onPress={confirmSignOut} />
      </View>
    </ScrollView>
  );
}

function BitratePicker({
  title,
  value,
  onChange,
}: {
  title: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <View style={styles.picker}>
      <ThemedText type="smallBold">{title}</ThemedText>
      <View style={styles.chips}>
        {BITRATE_OPTIONS.map((o) => (
          <Chip key={o.value} label={o.label} selected={value === o.value} onPress={() => onChange(o.value)} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.four,
  },
  picker: {
    gap: Spacing.two,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  account: {
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
});
