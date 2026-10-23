import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Chip } from '@/components/chip';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import type { User } from '@/miniapps/jellyfin/api';

import { useIsAdmin, useJellyfin, useJellyfinSession } from '@/miniapps/jellyfin/session';
import { BITRATE_OPTIONS, useJellyfinSettings } from '@/miniapps/jellyfin/settings';
import { useAsync } from '@/miniapps/jellyfin/use-async';
import { errorText } from '@/utils/error-text';

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

      <AutoplaySection />

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

/**
 * The server's "play next episode automatically" setting for every user. The Roku and iPhone
 * apps both follow it. Only shown to admins.
 */
function AutoplaySection() {
  const client = useJellyfin();
  const isAdmin = useIsAdmin();
  const { data: users, error, reload } = useAsync(
    () => (isAdmin ? client.users() : Promise.resolve([])),
    `users:${isAdmin}`,
  );
  // Shown as changed right away; the reload afterwards confirms it.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [shownUsers, setShownUsers] = useState(users);
  if (shownUsers !== users) {
    setShownUsers(users);
    setPending({});
  }
  if (!isAdmin) return null;
  if (!users?.length) {
    if (!error) return null;
    return (
      <View style={styles.picker}>
        <ThemedText type="smallBold">Play next episode automatically</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Couldn&apos;t load the people on the server. {error.message}
        </ThemedText>
        <Button title="Try again" variant="secondary" onPress={reload} />
      </View>
    );
  }

  const isOn = (u: User) => pending[u.Id] ?? u.Configuration?.EnableNextEpisodeAutoPlay !== false;
  const set = async (targets: User[], enabled: boolean) => {
    setPending((p) => ({ ...p, ...Object.fromEntries(targets.map((u) => [u.Id, enabled])) }));
    try {
      await Promise.all(targets.map((u) => client.setAutoplay(u, enabled)));
    } catch (e) {
      Alert.alert("Couldn't change autoplay", errorText(e));
    }
    reload();
  };
  const off = users.filter((u) => !isOn(u));

  return (
    <View style={styles.picker}>
      <ThemedText type="smallBold">Play next episode automatically</ThemedText>
      <View style={styles.chips}>
        {users.map((u) => (
          <Chip key={u.Id} label={`${isOn(u) ? '✓ ' : ''}${u.Name}`} selected={isOn(u)} onPress={() => set([u], !isOn(u))} />
        ))}
      </View>
      {off.length > 1 ? <Button title="Turn on for everyone" variant="secondary" onPress={() => set(off, true)} /> : null}
      <ThemedText type="small" themeColor="textSecondary">
        For each person on the server, on every Jellyfin app they use, including Roku. It also lets “Play on…”
        keep going after the first episode.
      </ThemedText>
    </View>
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
