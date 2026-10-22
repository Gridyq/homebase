import * as SecureStore from 'expo-secure-store';

import type { Shortcut } from '@/miniapps/registry';

import { episodeLabel } from './components';
import type { BaseItem } from './api';
import { SESSION_KEY } from './session';

const LAST_PLAYED_KEY = 'jellyfin.lastPlayed';

/** What the player was showing when it closed, so the launcher can offer to pick it up again. */
type LastPlayed = {
  id: string;
  title: string;
  subtitle?: string;
  startSeconds: number;
  subtitleLang?: string;
};

export function saveLastPlayed(item: BaseItem, startSeconds: number, subtitleLang?: string) {
  // A trailer isn't something you'd come back to.
  if (item.Type === 'Trailer') return;
  const label = episodeLabel(item);
  const value: LastPlayed = {
    id: item.Id,
    title: item.SeriesName ?? item.Name,
    subtitle: item.SeriesName ? [label, item.Name].filter(Boolean).join(' · ') : undefined,
    startSeconds: Math.floor(startSeconds),
    subtitleLang,
  };
  SecureStore.setItemAsync(LAST_PLAYED_KEY, JSON.stringify(value)).catch(() => undefined);
}

export function clearLastPlayed() {
  SecureStore.deleteItemAsync(LAST_PLAYED_KEY).catch(() => undefined);
}

export async function jellyfinShortcuts(): Promise<Shortcut[]> {
  // Jellyfin's screens other than login are only reachable while signed in.
  if (!(await SecureStore.getItemAsync(SESSION_KEY))) return [];

  const shortcuts: Shortcut[] = [];
  const raw = await SecureStore.getItemAsync(LAST_PLAYED_KEY);
  if (raw) {
    const last: LastPlayed = JSON.parse(raw);
    shortcuts.push({
      title: last.startSeconds > 0 ? `Resume ${last.title}` : `Play ${last.title}`,
      subtitle: last.subtitle,
      icon: 'play.fill',
      href: {
        pathname: '/jellyfin/player/[id]',
        params: {
          id: last.id,
          start: String(last.startSeconds),
          ...(last.subtitleLang ? { subtitleLang: last.subtitleLang } : {}),
        },
      },
    });
  }
  shortcuts.push({ title: 'Settings', icon: 'gearshape', href: '/jellyfin/settings' });
  return shortcuts;
}
