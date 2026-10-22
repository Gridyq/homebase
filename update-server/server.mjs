#!/usr/bin/env node
/**
 * Self-hosted update server for Homebase, implementing the Expo Updates protocol v1 (iOS only).
 * No dependencies beyond Node.js.
 *
 * Layout (all next to this file):
 *   keys/private-key.pem               signs manifests; the app only accepts updates signed with it
 *   updates/<runtimeVersion>/<ms>/     one `expo export` output per update, newest wins
 *
 * Publish with `npm run publish-update` from the project root.
 *
 * Spec: https://docs.expo.dev/technical-specs/expo-updates-1/
 */
import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UPDATES_DIR = path.join(ROOT, 'updates');
const KEY_PATH = path.join(ROOT, 'keys', 'private-key.pem');
const PORT = Number(process.env.PORT ?? 8787);
const KEY_ID = 'main';

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  json: 'application/json',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
};

let privateKey;
async function getPrivateKey() {
  privateKey ??= createPrivateKey(await readFile(KEY_PATH, 'utf8'));
  return privateKey;
}

const protocolHeaders = {
  'expo-protocol-version': '1',
  'expo-sfv-version': '0',
  'cache-control': 'private, max-age=0',
};

/** Directory of the newest update for a runtime version, or undefined. */
async function latestUpdate(runtimeVersion) {
  const runtimeDir = safeJoin(UPDATES_DIR, runtimeVersion);
  if (!runtimeDir) return undefined;
  const entries = await readdir(runtimeDir).catch(() => []);
  const newest = entries.filter((e) => /^\d+$/.test(e)).sort((a, b) => Number(a) - Number(b)).at(-1);
  return newest && { dir: path.join(runtimeDir, newest), updateId: newest };
}

/** Join and refuse anything that escapes `base`. */
function safeJoin(base, ...parts) {
  const resolved = path.resolve(base, ...parts);
  return resolved.startsWith(base + path.sep) ? resolved : undefined;
}

function uuidFromHash(input) {
  const h = createHash('sha256').update(input).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function buildManifest({ dir, updateId }, runtimeVersion, baseUrl) {
  const metadataRaw = await readFile(path.join(dir, 'metadata.json'), 'utf8');
  const metadata = JSON.parse(metadataRaw).fileMetadata.ios;
  const expoClient = JSON.parse(await readFile(path.join(dir, 'expoConfig.json'), 'utf8'));

  const describe = async (relPath, ext) => {
    const data = await readFile(path.join(dir, relPath));
    const query = new URLSearchParams({ runtime: runtimeVersion, update: updateId, path: relPath });
    return {
      hash: createHash('sha256').update(data).digest('base64url'),
      key: createHash('md5').update(data).digest('hex'),
      ...(ext ? { fileExtension: `.${ext}` } : {}),
      contentType: ext ? (MIME[ext] ?? 'application/octet-stream') : 'application/javascript',
      url: `${baseUrl}/api/assets?${query}`,
    };
  };

  return {
    id: uuidFromHash(`${runtimeVersion}/${updateId}/${metadataRaw}`),
    createdAt: new Date(Number(updateId)).toISOString(),
    runtimeVersion,
    launchAsset: await describe(metadata.bundle),
    assets: await Promise.all(metadata.assets.map((a) => describe(a.path, a.ext))),
    metadata: {},
    extra: { expoClient },
  };
}

function multipart(parts) {
  const boundary = `homebase-${randomBytes(12).toString('hex')}`;
  const body =
    parts
      .map(({ name, headers = {}, body }) => {
        const head = Object.entries({
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `form-data; name="${name}"`,
          ...headers,
        })
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n');
        return `--${boundary}\r\n${head}\r\n\r\n${body}\r\n`;
      })
      .join('') + `--${boundary}--\r\n`;
  return { contentType: `multipart/mixed; boundary=${boundary}`, body };
}

async function handleManifest(req, res) {
  const platform = req.headers['expo-platform'];
  const runtimeVersion = req.headers['expo-runtime-version'];
  if (req.headers['expo-protocol-version'] !== '1') return send(res, 400, 'Unsupported protocol version');
  if (platform !== 'ios') return send(res, 400, 'Only ios is supported');
  if (!runtimeVersion) return send(res, 400, 'Missing expo-runtime-version');

  const update = await latestUpdate(runtimeVersion);
  if (!update) {
    log(req, `no update for runtime ${runtimeVersion}`);
    res.writeHead(204, protocolHeaders).end();
    return;
  }

  const baseUrl = `http://${req.headers.host}`;
  const manifestJson = JSON.stringify(await buildManifest(update, runtimeVersion, baseUrl));
  const headers = {};
  if (req.headers['expo-expect-signature']) {
    const sig = sign('sha256', Buffer.from(manifestJson), await getPrivateKey()).toString('base64');
    headers['expo-signature'] = `sig="${sig}", keyid="${KEY_ID}"`;
  }

  const { contentType, body } = multipart([
    { name: 'manifest', headers, body: manifestJson },
    { name: 'extensions', body: JSON.stringify({ assetRequestHeaders: {} }) },
  ]);
  log(req, `serving update ${update.updateId} for runtime ${runtimeVersion}`);
  res.writeHead(200, { ...protocolHeaders, 'content-type': contentType }).end(body);
}

async function handleAsset(req, res, url) {
  const runtime = url.searchParams.get('runtime') ?? '';
  const update = url.searchParams.get('update') ?? '';
  const relPath = url.searchParams.get('path') ?? '';
  if (!/^\d+$/.test(update)) return send(res, 400, 'Bad update id');

  const updateDir = safeJoin(UPDATES_DIR, runtime, update);
  const file = updateDir && safeJoin(updateDir, relPath);
  if (!file) return send(res, 400, 'Bad path');

  let data;
  try {
    data = await readFile(file);
  } catch {
    return send(res, 404, 'Not found');
  }

  const ext = path.extname(file).slice(1);
  const meta = JSON.parse(await readFile(path.join(updateDir, 'metadata.json'), 'utf8')).fileMetadata.ios;
  const assetExt = meta.assets.find((a) => a.path === relPath)?.ext ?? ext;
  const contentType = relPath === meta.bundle ? 'application/javascript' : (MIME[assetExt] ?? 'application/octet-stream');

  const headers = { 'content-type': contentType, 'cache-control': 'public, max-age=31536000, immutable' };
  if (/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    data = gzipSync(data);
    headers['content-encoding'] = 'gzip';
  }
  res.writeHead(200, headers).end(data);
}

function send(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain' }).end(text);
}

function log(req, message) {
  console.log(`${new Date().toISOString()} ${req.socket.remoteAddress} ${message}`);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
    if (url.pathname === '/api/manifest') return await handleManifest(req, res);
    if (url.pathname === '/api/assets') return await handleAsset(req, res, url);
    if (url.pathname === '/health') return send(res, 200, 'ok');
    send(res, 404, 'Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, 'Internal error');
  }
}).listen(PORT, () => console.log(`Homebase update server listening on :${PORT}`));
