import { Image } from 'expo-image';
import { router } from 'expo-router';
import { ActionSheetIOS, Alert, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { errorText } from '@/utils/error-text';

import {
  JellyfinError,
  sameId,
  TICKS_PER_SECOND,
  type BaseItem,
  type JellyfinClient,
  type PlaylistShare,
  type User,
} from './api';
import { useReloadAfterChanges } from './changes';
import { episodeLabel, formatRuntime, itemHref } from './components';
import { playOnDevice } from './remote-play';
import { useIsAdmin, useJellyfin } from './session';
import { useAsync } from './use-async';


/** Ask which playlist to add an item to (or to start a new one), then add it. */
export async function addToPlaylist(client: JellyfinClient, item: BaseItem) {
  let playlists: BaseItem[];
  try {
    playlists = await client.playlists();
  } catch (e) {
    Alert.alert("Couldn't load playlists", errorText(e));
    return;
  }
  const options = [...playlists.map((p) => p.Name), 'New playlist…'];
  ActionSheetIOS.showActionSheetWithOptions(
    { title: `Add “${item.Name}” to`, options: [...options, 'Cancel'], cancelButtonIndex: options.length },
    (index) => {
      const playlist = playlists[index];
      if (playlist) {
        client.addToPlaylist(playlist.Id, [item.Id]).then(
          () => Alert.alert(`Added to ${playlist.Name}`),
          (e) => Alert.alert("Couldn't add to the playlist", errorText(e)),
        );
      } else if (index === playlists.length) {
        Alert.prompt('New playlist', undefined, (name) => {
          if (!name?.trim()) return;
          client.createPlaylist(name.trim(), [item.Id]).then(
            () => Alert.alert(`Added to ${name.trim()}`),
            (e) => Alert.alert("Couldn't create the playlist", errorText(e)),
          );
        });
      }
    },
  );
}

/** Pick who a playlist is shared with and whether they can change it. Reopens after each change. */
export async function sharePlaylist(client: JellyfinClient, playlist: BaseItem) {
  let users: User[];
  let shares: PlaylistShare[];
  try {
    [users, shares] = await Promise.all([client.users(), client.playlistShares(playlist.Id)]);
  } catch (e) {
    const forbidden = e instanceof JellyfinError && e.status === 403;
    Alert.alert("Couldn't load people", forbidden ? 'Only a server admin can share playlists with people.' : errorText(e));
    return;
  }
  const people = users.filter((u) => !sameId(u.Id, client.session.userId));
  if (!people.length) {
    Alert.alert('Nobody to share with', 'Add more users on the Jellyfin server first.');
    return;
  }
  const shareOf = (user: User) => shares.find((s) => sameId(s.UserId, user.Id));
  const options = people.map((u) => {
    const share = shareOf(u);
    return `${u.Name} — ${share ? (share.CanEdit ? 'can watch and edit' : 'can watch') : 'not shared'}`;
  });
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: `Share “${playlist.Name}”`,
      message: 'It shows up in their Playlists on every Jellyfin app, including Roku.',
      options: [...options, 'Done'],
      cancelButtonIndex: options.length,
    },
    (index) => {
      const user = people[index];
      if (!user) return;
      const shared = !!shareOf(user);
      const choices = ['Can watch', 'Can watch and edit', shared ? 'Stop sharing' : undefined].filter(
        (c): c is string => !!c,
      );
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: user.Name,
          options: [...choices, 'Cancel'],
          cancelButtonIndex: choices.length,
          destructiveButtonIndex: shared ? choices.length - 1 : undefined,
        },
        async (i) => {
          const choice = choices[i];
          if (!choice) return sharePlaylist(client, playlist);
          const rest = shares.filter((s) => !sameId(s.UserId, user.Id));
          const next =
            choice === 'Stop sharing' ? rest : [...rest, { UserId: user.Id, CanEdit: choice === 'Can watch and edit' }];
          try {
            await client.setPlaylistShares(playlist.Id, next);
          } catch (e) {
            Alert.alert(`Couldn't share with ${user.Name}`, errorText(e));
            return;
          }
          sharePlaylist(client, playlist);
        },
      );
    },
  );
}

function playEntry(playlistId: string, entry: BaseItem) {
  router.push({
    pathname: '/jellyfin/player/[id]',
    params: {
      id: entry.Id,
      start: String((entry.UserData?.PlaybackPositionTicks ?? 0) / TICKS_PER_SECOND),
      playlist: playlistId,
      ...(entry.PlaylistItemId ? { entry: entry.PlaylistItemId } : {}),
    },
  });
}

/** A playlist's entries in order: play from any of them, and reorder or remove them. */
export function PlaylistEntries({ playlist }: { playlist: BaseItem }) {
  const client = useJellyfin();
  const isAdmin = useIsAdmin();
  const theme = useTheme();
  const gutter = useGutter();
  const { width, height } = useWindowDimensions();
  const { data: entries, reload } = useAsync(() => client.playlistItems(playlist.Id), `playlist:${playlist.Id}`);
  const thumbWidth = Math.min(width, height) * 0.32;

  // Pick up watched state and resume points after coming back from the player.
  useReloadAfterChanges(reload);

  const change = async (action: () => Promise<unknown>, failure: string) => {
    try {
      await action();
    } catch (e) {
      Alert.alert(failure, errorText(e));
    }
    reload();
  };

  const entryActions = (entry: BaseItem, index: number) => {
    const count = entries?.length ?? 0;
    const options = [
      'Details',
      index > 0 ? 'Move up' : undefined,
      index < count - 1 ? 'Move down' : undefined,
      'Remove from playlist',
    ].filter((o): o is string => !!o);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: entry.Name,
        options: [...options, 'Cancel'],
        cancelButtonIndex: options.length,
        destructiveButtonIndex: options.indexOf('Remove from playlist'),
      },
      (i) => {
        const choice = options[i];
        const entryId = entry.PlaylistItemId;
        if (choice === 'Details') router.push(itemHref(entry));
        if (!entryId) return;
        if (choice === 'Move up' || choice === 'Move down') {
          const to = index + (choice === 'Move up' ? -1 : 1);
          change(() => client.movePlaylistItem(playlist.Id, entryId, to), "Couldn't move it");
        } else if (choice === 'Remove from playlist') {
          change(() => client.removeFromPlaylist(playlist.Id, [entryId]), "Couldn't remove it");
        }
      },
    );
  };

  const deletePlaylist = () =>
    Alert.alert(`Delete “${playlist.Name}”?`, 'Only the playlist goes; what was in it stays in your library.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          client.deleteItem(playlist.Id).then(
            () => router.back(),
            (e) => Alert.alert("Couldn't delete the playlist", errorText(e)),
          ),
      },
    ]);

  if (!entries) return null;
  const firstVideo = entries.find((e) => e.MediaType === 'Video');

  return (
    <View style={[styles.section, gutter]}>
      {firstVideo ? <Button title="Play all" onPress={() => playEntry(playlist.Id, firstVideo)} /> : null}
      {isAdmin ? (
        <View style={styles.buttons}>
          {firstVideo ? (
            <View style={styles.button}>
              <Button title="Play on…" variant="secondary" onPress={() => playOnDevice(client, playlist)} />
            </View>
          ) : null}
          <View style={styles.button}>
            <Button title="Share…" variant="secondary" onPress={() => sharePlaylist(client, playlist)} />
          </View>
        </View>
      ) : null}
      {!entries.length ? (
        <ThemedText themeColor="textSecondary">
          Nothing here yet. Add movies or episodes from their pages with “+ Playlist”.
        </ThemedText>
      ) : null}
      {entries.map((entry, index) => {
        const thumb = client.imageUrl(entry, { height: 270 });
        const progress = entry.UserData?.PlayedPercentage;
        const caption = [
          entry.Type === 'Episode' ? [entry.SeriesName, episodeLabel(entry)].filter(Boolean).join(' · ') : entry.ProductionYear,
          formatRuntime(entry.RunTimeTicks),
          entry.UserData?.Played && 'Watched',
        ].filter(Boolean);
        return (
          <Pressable
            key={entry.PlaylistItemId ?? `${entry.Id}:${index}`}
            onPress={() => (entry.MediaType === 'Video' ? playEntry(playlist.Id, entry) : router.push(itemHref(entry)))}
            onLongPress={() => entryActions(entry, index)}
            style={({ pressed }) => [styles.entry, { opacity: pressed ? 0.6 : 1 }]}>
            <View style={[styles.thumb, { width: thumbWidth, height: (thumbWidth * 9) / 16, backgroundColor: theme.backgroundElement }]}>
              {thumb ? <Image source={thumb} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
              {progress ? <View style={[styles.progress, { width: `${progress}%`, backgroundColor: theme.accent }]} /> : null}
            </View>
            <View style={styles.entryText}>
              <ThemedText numberOfLines={2} style={styles.entryTitle}>
                {entry.Name}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                {caption.join(' · ')}
              </ThemedText>
            </View>
            <Pressable hitSlop={12} onPress={() => entryActions(entry, index)}>
              <ThemedText themeColor="textSecondary">•••</ThemedText>
            </Pressable>
          </Pressable>
        );
      })}
      <Button title="Delete playlist" variant="secondary" onPress={deletePlaylist} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: Spacing.three,
  },
  buttons: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  button: {
    flex: 1,
  },
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  entryText: {
    flex: 1,
    gap: 2,
  },
  entryTitle: {
    fontWeight: 600,
  },
  thumb: {
    borderRadius: 6,
    overflow: 'hidden',
  },
  progress: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    height: 3,
  },
});
