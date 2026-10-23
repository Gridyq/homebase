import type { Href, Link } from 'expo-router';
import type { ComponentProps } from 'react';

import { dropActivity } from './drop/uploads';
import { jellyfinActivity, jellyfinShortcuts } from './jellyfin/last-played';
import { requestsActivity } from './requests/activity';
import { serverActivity } from './server/activity';

/**
 * Every mini-app bundled in the shell. To add one:
 *   1. Put its screens in `src/app/<id>/` (with a `_layout.tsx`).
 *   2. Put its non-route code in `src/miniapps/<id>/`.
 *   3. Add an entry here.
 *   4. Add it to `src/app/_layout.tsx` with `headerShown: false`, or the launcher's header shows
 *      above the mini-app's own.
 */
export type MiniApp = {
  id: string;
  name: string;
  description: string;
  /** Short glyph shown on the launcher tile. */
  glyph: string;
  color: string;
  href: Href;
  /** Extra entries for the tile's long-press menu, worked out each time the launcher shows. */
  shortcuts?: () => Promise<Shortcut[]>;
  /** What's going on right now, for the launcher's Now list. Empty when there's nothing to say. */
  activity?: () => Promise<Activity[]>;
};

export type Shortcut = {
  title: string;
  subtitle?: string;
  /** SF Symbol name. */
  icon: NonNullable<ComponentProps<typeof Link.MenuAction>['icon']>;
  href: Href;
};

/** A line on the launcher about something under way or needing a look. */
export type Activity = {
  key: string;
  title: string;
  caption?: string;
  /** 0–1; draws a meter. */
  fraction?: number;
  tone?: 'good' | 'warn' | 'bad';
  href: Href;
};

export const miniApps: MiniApp[] = [
  {
    id: 'jellyfin',
    name: 'Jellyfin',
    description: 'Movies, shows and more from your server',
    glyph: '▶',
    color: '#7B4FD6',
    href: '/jellyfin',
    shortcuts: jellyfinShortcuts,
    activity: jellyfinActivity,
  },
  {
    id: 'server',
    name: 'Server',
    description: 'Health, storage and services on the home server',
    glyph: '▤',
    color: '#12A594',
    href: '/server',
    activity: serverActivity,
  },
  {
    id: 'requests',
    name: 'Requests',
    description: 'Find movies and shows, and follow their downloads',
    glyph: '↓',
    color: '#E5484D',
    href: '/requests',
    activity: requestsActivity,
  },
  {
    id: 'drop',
    name: 'Drop',
    description: 'Send photos, files, text and links to the PC, and get files back',
    glyph: '⇄',
    color: '#0090FF',
    href: '/drop',
    activity: dropActivity,
  },
  {
    id: 'videos',
    name: 'Videos',
    description: 'Save YouTube and other web videos to Jellyfin',
    glyph: '⤓',
    color: '#F76B15',
    href: '/videos',
  },
  {
    id: 'assistant',
    name: 'Assistant',
    description: 'Chat with the AI model on the home PC',
    glyph: '✦',
    color: '#8E4EC6',
    href: '/assistant',
  },
  {
    id: 'history',
    name: 'Watch History',
    description: 'What you watched, when, and how much',
    glyph: '◷',
    color: '#D6409F',
    href: '/history',
  },
];
