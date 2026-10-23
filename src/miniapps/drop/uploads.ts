import { useSyncExternalStore } from 'react';

import type { Activity } from '@/miniapps/registry';
import type { Connection } from '@/miniapps/server/api';

import { uploadFile, type Picked } from './api';

/** `picked` is kept so a failed upload can be tried again. */
export type Upload = { id: string; name: string; progress: number; error?: string; picked: Picked };

/**
 * Uploads live here rather than in the Drop screen, so leaving the screen mid-upload doesn't lose
 * track of them: they keep going, and coming back shows where they are and whether any failed.
 */
let uploads: Upload[] = [];
/** Goes up each time an upload finishes, so the screen knows to look at the PC's folder again. */
let finished = 0;
let running = false;
const queue: { conn: Connection; id: string }[] = [];
const listeners = new Set<() => void>();

function set(next: Upload[]) {
  uploads = next;
  listeners.forEach((l) => l());
}

const update = (id: string, change: Partial<Upload>) => set(uploads.map((u) => (u.id === id ? { ...u, ...change } : u)));

// One at a time, so a big video doesn't hold up the photos picked with it for long.
async function run() {
  if (running) return;
  running = true;
  for (let next = queue.shift(); next; next = queue.shift()) {
    const { conn, id } = next;
    const upload = uploads.find((u) => u.id === id);
    if (!upload) continue;
    // The native side reports far more often than the bar can show; each report redraws Drop.
    let shown = { progress: 0, at: 0 };
    const onProgress = (progress: number) => {
      const now = Date.now();
      if (progress < 1 && progress - shown.progress < 0.01 && now - shown.at < 250) return;
      shown = { progress, at: now };
      update(id, { progress });
    };
    try {
      await uploadFile(conn, upload.picked.file, upload.picked.name, onProgress);
      finished++;
      set(uploads.filter((u) => u.id !== id));
    } catch (e) {
      update(id, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  running = false;
}

export function startUploads(conn: Connection, picked: Picked[]) {
  const stamp = Date.now();
  const added = picked.map((p, i) => ({ id: `${stamp}-${i}`, name: p.name, progress: 0, picked: p }));
  set([...uploads, ...added]);
  queue.push(...added.map(({ id }) => ({ conn, id })));
  run();
}

export function retryUpload(conn: Connection, id: string) {
  update(id, { error: undefined, progress: 0 });
  queue.push({ conn, id });
  run();
}

export function dismissUpload(id: string) {
  set(uploads.filter((u) => u.id !== id));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUploads() {
  return {
    uploads: useSyncExternalStore(subscribe, () => uploads),
    finished: useSyncExternalStore(subscribe, () => finished),
  };
}

/** For the launcher's Now list: uploads under way, or ones that failed. */
export async function dropActivity(): Promise<Activity[]> {
  const failed = uploads.filter((u) => u.error);
  const going = uploads.filter((u) => !u.error);
  const items: Activity[] = [];
  if (going.length) {
    items.push({
      key: 'drop:uploading',
      title: going.length === 1 ? `Sending ${going[0].name}` : `Sending ${going.length} files to the PC`,
      fraction: going[0].progress,
      href: '/drop',
    });
  }
  if (failed.length) {
    items.push({
      key: 'drop:failed',
      title: failed.length === 1 ? `${failed[0].name} didn't send` : `${failed.length} files didn't send`,
      caption: failed.length === 1 ? failed[0].error : 'Open Drop to try again',
      tone: 'bad',
      href: '/drop',
    });
  }
  return items;
}
