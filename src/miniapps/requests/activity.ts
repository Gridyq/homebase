import type { Activity } from '@/miniapps/registry';
import { loadConnection } from '@/miniapps/server/connection';

import { conversions, downloads, type Download } from './api';
import { displayName, formatEta, formatTimeLeft } from './components';

const TROUBLE: Download['state'][] = ['failed', 'warning', 'stalled', 'blocked'];

/** Downloads and conversions under way, for the launcher. */
export async function requestsActivity(): Promise<Activity[]> {
  const conn = await loadConnection();
  if (!conn) return [];
  // Either can be off (game mode, conversions paused); show whatever answers.
  const [queue, converting] = await Promise.allSettled([downloads(conn), conversions(conn)]);
  const items: Activity[] = [];

  const all = queue.status === 'fulfilled' ? queue.value.filter((d) => d.state !== 'completed') : [];
  if (all.length) {
    const trouble = all.filter((d) => TROUBLE.includes(d.state));
    const lead = all.find((d) => d.state === 'downloading') ?? all[0];
    const size = all.reduce((n, d) => n + d.size, 0);
    const left = all.reduce((n, d) => n + d.sizeLeft, 0);
    const timeLeft = lead.state === 'downloading' ? formatTimeLeft(lead.timeLeft) : undefined;
    items.push({
      key: 'downloads',
      title: trouble.length
        ? `${trouble.length} download${trouble.length === 1 ? ' needs' : 's need'} attention`
        : all.length === 1
          ? `Downloading ${lead.title}`
          : `Downloading ${all.length} items`,
      caption: [`${lead.title} ${lead.subtitle}`, timeLeft && `${timeLeft} left`].filter(Boolean).join(' · '),
      fraction: size ? 1 - left / size : undefined,
      tone: trouble.some((d) => d.state === 'failed') ? 'bad' : trouble.length ? 'warn' : 'good',
      href: '/requests',
    });
  }

  const conv = converting.status === 'fulfilled' ? converting.value : undefined;
  const worker = conv?.workers[0];
  if (conv && worker) {
    items.push({
      key: 'conversions',
      title: `Converting ${displayName(worker.file)}`,
      caption: [
        `${Math.round(worker.percent)}%`,
        formatEta(worker.eta),
        conv.counts.queued ? `${conv.counts.queued} waiting` : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
      fraction: worker.percent / 100,
      tone: conv.paused ? 'warn' : 'good',
      href: '/requests/conversions',
    });
  }
  return items;
}
