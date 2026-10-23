import { ActionSheetIOS, Alert } from 'react-native';

import type { BaseItem, JellyfinClient, RemoteSession } from './api';
import { episodeLabel } from './components';

import { errorText } from '@/utils/error-text';


const sessionLabel = (s: RemoteSession) => [s.UserName, s.DeviceName ?? s.Client].filter(Boolean).join(' · ');

const where = (s: RemoteSession) => `${s.UserName ?? 'their'}${s.UserName ? '’s' : ''} ${s.DeviceName ?? s.Client ?? 'device'}`;

const resumeTicks = (item: BaseItem) => (item.UserData?.Played ? 0 : (item.UserData?.PlaybackPositionTicks ?? 0));

/** The first episode someone hasn't finished, or the first one if they've seen them all. */
const firstUnwatched = (episodes: BaseItem[]) => episodes.find((e) => !e.UserData?.Played) ?? episodes[0];

/**
 * What to start for the person using `session`: a show or season picks up where they are in it,
 * and a movie or episode resumes from their own position.
 */
async function whatToPlay(client: JellyfinClient, forUserId: string, item: BaseItem) {
  if (item.Type === 'Playlist') {
    const entries = await client.playlistItems(item.Id);
    return { itemIds: entries.filter((e) => e.MediaType === 'Video').map((e) => e.Id), startTicks: 0, title: item.Name };
  }
  let target: BaseItem | undefined;
  if (item.Type === 'Series') {
    target =
      (await client.nextUpFor(forUserId, item.Id)) ?? firstUnwatched(await client.episodesFor(forUserId, item.Id));
  } else if (item.Type === 'Season' && item.SeriesId) {
    target = firstUnwatched(await client.episodesFor(forUserId, item.SeriesId, item.Id));
  } else {
    target = await client.itemFor(forUserId, item.Id);
  }
  if (!target) return undefined;
  const title = target.Type === 'Episode' ? [target.SeriesName, episodeLabel(target), target.Name].filter(Boolean).join(' · ') : target.Name;
  return { itemIds: [target.Id], startTicks: resumeTicks(target), title };
}

/** Pick one of the Jellyfin apps open on someone's iPhone, iPad or computer, and start `item` on it. */
export async function playOnDevice(client: JellyfinClient, item: BaseItem) {
  let sessions: RemoteSession[];
  try {
    sessions = (await client.remoteSessions()).filter((s) => s.UserId && s.DeviceId !== client.session.deviceId);
  } catch (e) {
    Alert.alert("Couldn't load devices", errorText(e));
    return;
  }
  const controllable = sessions.filter((s) => s.SupportsMediaControl);
  const others = sessions.filter((s) => !s.SupportsMediaControl);
  const othersNote = others.length
    ? `${others.map(sessionLabel).join(', ')} can't be started remotely (the Roku app doesn't support it). Share a playlist with them instead.`
    : undefined;

  if (!controllable.length) {
    Alert.alert(
      'No devices to play on',
      othersNote ?? 'The Jellyfin app needs to be open on their iPhone, iPad or computer for it to show up here.',
    );
    return;
  }

  const options = controllable.map(
    (s) => sessionLabel(s) + (s.NowPlayingItem ? ` — watching ${s.NowPlayingItem.SeriesName ?? s.NowPlayingItem.Name}` : ''),
  );
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: `Play “${item.Name}” on`,
      message: othersNote,
      options: [...options, 'Cancel'],
      cancelButtonIndex: options.length,
    },
    async (index) => {
      const session = controllable[index];
      if (!session?.UserId) return;
      try {
        const play = await whatToPlay(client, session.UserId, item);
        if (!play?.itemIds.length) {
          Alert.alert('Nothing to play', `There's nothing in “${item.Name}” to play yet.`);
          return;
        }
        await client.playOnSession(session.Id, play.itemIds, play.startTicks);
        Alert.alert(`Playing on ${where(session)}`, play.title);
      } catch (e) {
        Alert.alert(`Couldn't play on ${where(session)}`, errorText(e));
      }
    },
  );
}
