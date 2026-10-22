#!/usr/bin/env node
/**
 * Export the current JavaScript as an over-the-air update and hand it to the local update
 * server (update-server/). Phones pick it up the next time Homebase starts.
 *
 * Only JavaScript and assets ship this way. If you changed native code (added a package with
 * native code, edited app.json plugins/ios settings), bump "version" in app.json and make a
 * new build instead; updates only reach builds with the same version.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEP = 5;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npx = (args, opts = {}) => execFileSync('npx', args, { cwd: root, encoding: 'utf8', ...opts });
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const published = (dir) =>
  readdirSync(dir)
    .filter((d) => /^\d+$/.test(d))
    .sort((a, b) => Number(a) - Number(b));

const { runtimeVersion } = JSON.parse(npx(['expo-updates', 'runtimeversion:resolve', '--platform', 'ios']));
const runtimeDir = path.join(root, 'update-server', 'updates', runtimeVersion);
const updateId = String(Date.now());
const staging = path.join(runtimeDir, `.${updateId}`);

mkdirSync(runtimeDir, { recursive: true });
const commit = git(['rev-parse', 'HEAD']);
const dirty = git(['status', '--porcelain']) !== '';
const notes = releaseNotes();

npx(['expo', 'export', '--platform', 'ios', '--output-dir', staging], { stdio: 'inherit' });
// The app reads `extra.homebase` to show "What's new" after it switches to this update.
const expoConfig = JSON.parse(npx(['expo', 'config', '--type', 'public', '--json']));
expoConfig.extra = { ...expoConfig.extra, homebase: { commit, notes } };
writeFileSync(path.join(staging, 'expoConfig.json'), JSON.stringify(expoConfig));
// Move into place in one step so the server never sees a half-written update.
renameSync(staging, path.join(runtimeDir, updateId));

const old = published(runtimeDir).slice(0, -KEEP);
for (const dir of old) rmSync(path.join(runtimeDir, dir), { recursive: true, force: true });

console.log(`\nPublished update ${updateId} for runtime ${runtimeVersion}.`);
console.log('Open Homebase on your phone to download it; it switches over the next time you leave the app.');

// Ping the phone through the self-hosted ntfy server. Tapping the notification opens Homebase,
// which downloads the update as it comes to the foreground and applies it once it's left again.
try {
  const res = await fetch(process.env.NTFY_URL ?? 'http://localhost:2586/Homebase', {
    method: 'POST',
    headers: { Title: 'Homebase update ready', Tags: 'arrows_counterclockwise', Click: 'homebase://' },
    body: [...notes, 'Open Homebase to download it; it switches over the next time you leave the app.'].join('\n'),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  console.log('Sent ntfy notification.');
} catch (e) {
  console.warn(`Couldn't send ntfy notification: ${e.message}`);
}

/** Commit subjects since the previous update, newest first. */
function releaseNotes() {
  let previous;
  try {
    const last = published(runtimeDir).at(-1);
    previous = last && JSON.parse(readFileSync(path.join(runtimeDir, last, 'expoConfig.json'), 'utf8')).extra?.homebase?.commit;
  } catch {
    // No earlier update, or one published before release notes existed.
  }
  let subjects = [];
  if (previous && previous !== commit) {
    try {
      subjects = git(['log', '--no-merges', '--format=%s', `${previous}..HEAD`]).split('\n').filter(Boolean);
    } catch {
      // The previous commit is gone (rebased away); fall back to the latest one.
    }
  }
  if (!subjects.length && previous !== commit) subjects = [git(['log', '-1', '--format=%s'])];
  if (dirty) subjects.unshift('Work in progress (uncommitted changes)');
  return subjects.slice(0, 20);
}
