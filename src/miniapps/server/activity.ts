import type { Activity } from '@/miniapps/registry';
import { formatPercent } from '@/utils/format';

import { fetchStatus } from './api';
import { diskName } from './components';
import { loadConnection } from './connection';

const DISK_WARN = 0.9;

/** Only what needs a look: failed services, full disks, game mode. Quiet when all is well. */
export async function serverActivity(): Promise<Activity[]> {
  const conn = await loadConnection();
  if (!conn) return [];
  const status = await fetchStatus(conn);
  const items: Activity[] = [];

  const broken = status.services.filter((s) => s.state === 'failed' || s.health === 'unhealthy');
  if (broken.length) {
    items.push({
      key: 'services',
      title: broken.length === 1 ? `${broken[0].name} isn't working` : `${broken.length} services aren't working`,
      caption: broken.length === 1 ? broken[0].detail : broken.map((s) => s.name).join(', '),
      tone: 'bad',
      href: broken.length === 1 ? { pathname: '/server/service/[id]', params: { id: broken[0].id } } : '/server',
    });
  }

  for (const disk of status.disks) {
    const used = disk.totalBytes ? disk.usedBytes / disk.totalBytes : 0;
    if (used < DISK_WARN) continue;
    items.push({
      key: `disk:${disk.mount}`,
      title: `${diskName(disk.mount)} disk is ${formatPercent(used)} full`,
      fraction: used,
      tone: 'warn',
      href: '/server',
    });
  }

  if (status.gameMode.on) {
    const { game, manual } = status.gameMode;
    items.push({
      key: 'game-mode',
      title: 'Game mode is on',
      caption: manual || !game ? 'Downloads are stopped' : `Downloads are stopped while ${game} runs`,
      tone: 'warn',
      href: '/server',
    });
  }
  return items;
}
