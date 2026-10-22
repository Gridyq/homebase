# Homebase

A personal iPhone app that contains several mini-apps in one install, so it only uses one of
SideStore's three free app slots. The first mini-app is a Jellyfin client.

Built with Expo (React Native). No Mac needed: GitHub Actions builds an unsigned `.ipa`, and
SideStore signs it with a free Apple ID.

## Installing on your iPhone

1. Set up SideStore on the phone (https://docs.sidestore.io).
2. On GitHub, open **Actions → Build iOS → Run workflow**, choose **Release**, and wait for it
   to finish (about 15–25 minutes).
3. On the iPhone, open the repo's **Releases** page in Safari, download `Homebase-Release.ipa`
   from **latest-release**, then share it to SideStore (or use **+** in SideStore's My Apps tab).
4. Refresh it in SideStore at least once every 7 days.

## Developing from Linux

Build and install the **Debug** configuration once the same way. It's a development build: it
loads JavaScript from your computer instead of having it built in.

```sh
npm install
npx expo start
```

With the phone on the same Wi-Fi, open Homebase and pick your computer from the list (or enter
the URL `npx expo start` prints). Edits reload on the phone as you save. You only need a new
build when native packages or `app.json` change.

Before committing:

```sh
npx tsc --noEmit
npx expo lint
```

## Over-the-air updates

JavaScript changes don't need a new build. The app checks a self-hosted update server
(`update-server/`, running on the Jellyfin PC) when it starts and when it comes back to the
foreground, then shows "Update ready. Tap to restart" on the launcher.

```sh
npm run publish-update
```

- The server runs as a systemd user service: `systemctl --user status homebase-updates`.
  It listens on port 8787, and the app reaches it at `fedora.tail27f991.ts.net` (Tailscale).
  Without Tailscale the app keeps running the last update it downloaded.
- Updates are signed with `update-server/keys/private-key.pem`, which is git-ignored. The app
  rejects anything not signed with it. Back that key up: if it's lost, you need a new build
  with a new certificate.
- Updates only reach builds with the same `version` in `app.json`. When you change native code
  (packages with native code, `app.json` plugins or iOS settings), bump `version` and make a
  new build.

## Adding a mini-app

1. Create its screens in `src/app/<id>/`, with a `_layout.tsx` for its own navigation stack.
2. Put its non-screen code in `src/miniapps/<id>/`.
3. Add an entry to `src/miniapps/registry.ts` so it shows on the launcher.
4. Register its stack in `src/app/_layout.tsx` with `headerShown: false`.

## Jellyfin notes

- The server decides per file whether the phone can play it directly or needs it converted to
  HLS. MKV, DTS/TrueHD audio and ASS/PGS subtitles are converted by the server.
- Audio and subtitle tracks are picked from the system player's menu.
- Playback reports progress, so "Continue watching" stays in sync with other Jellyfin clients.
- Plain `http://` servers are allowed, for home networks.
