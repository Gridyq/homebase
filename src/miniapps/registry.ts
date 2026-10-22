import type { Href, Link } from 'expo-router';
import type { ComponentProps } from 'react';

import { jellyfinShortcuts } from './jellyfin/last-played';

/**
 * Every mini-app bundled in the shell. To add one:
 *   1. Put its screens in `src/app/<id>/` (with a `_layout.tsx`).
 *   2. Put its non-route code in `src/miniapps/<id>/`.
 *   3. Add an entry here.
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
};

export type Shortcut = {
  title: string;
  subtitle?: string;
  /** SF Symbol name. */
  icon: NonNullable<ComponentProps<typeof Link.MenuAction>['icon']>;
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
  },
  {
    id: 'server',
    name: 'Server',
    description: 'Health, storage and services on the home server',
    glyph: '▤',
    color: '#12A594',
    href: '/server',
  },
  {
    id: 'requests',
    name: 'Requests',
    description: 'Find movies and shows, and follow their downloads',
    glyph: '↓',
    color: '#E5484D',
    href: '/requests',
  },
  {
    id: 'drop',
    name: 'Drop',
    description: 'Send photos, files, text and links to the PC, and get files back',
    glyph: '⇄',
    color: '#0090FF',
    href: '/drop',
  },
];
