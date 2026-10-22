import type { Href } from 'expo-router';

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
};

export const miniApps: MiniApp[] = [
  {
    id: 'jellyfin',
    name: 'Jellyfin',
    description: 'Movies, shows and more from your server',
    glyph: '▶',
    color: '#7B4FD6',
    href: '/jellyfin',
  },
];
