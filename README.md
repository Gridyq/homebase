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

## Server mini-app

Shows CPU, memory, GPU, network, temperatures, disks, and the Podman containers and systemd units
on the home server, and can start, stop and restart them. The data comes from the status server,
a Rust program in `status-server-rs/` that keeps its files in `status-server/`. It also serves the
Requests, Drop, Videos and Assistant mini-apps, and sends an ntfy message when a disk passes 90%, a sensor passes 90°C, a service fails,
crashes or is killed for memory, or a drive's SMART health turns bad (and again when it recovers).

Analytics: Memory breaks RAM into programs, kernel and cache and lists every service and app by
memory, CPU or disk traffic (from their cgroups, so cache is counted apart from what programs
hold); Processes lists the top programs; CPU shows each thread's load and clock and how long
programs waited on CPU, memory and drives (pressure stall info); Graphics card (tap the GPU tile)
shows engine load including video encode/decode, video memory, temperatures, power, fan, clocks
and which programs have the card open (from DRM fdinfo); Drives shows SMART health, wear and
temperature from udisks, and who's reading and writing each drive (cgroup `io.stat`); Network
splits traffic by container (each container's own network namespace) and by Tailscale device;
Power adds up the CPU's and graphics card's measured draw into kWh and cost; Reliability counts
crashes, memory kills (kernel OOM killer and systemd-oomd, from the journal) and reboots per
service, with a timeline. Trends and each service, drive and device page chart up to a year, with
reboots, crashes and game mode marked.

History is a reading every 15 seconds, kept a day, with averages kept longer: every 10 minutes for a
week, hourly for a month and every 6 hours for a year. Each tier is `status-server/history-*.jsonl`
and events are `status-server/events.jsonl` (all git-ignored), appended as they come and trimmed
every few hours.

- CPU power comes from the CPU's energy counter (RAPL), which only root can read. A udev rule
  lets the server's user read it, and only that user, since the counter is a known side channel
  (CVE-2020-8694). In `/etc/udev/rules.d/99-homebase-rapl.rules`:
  `SUBSYSTEM=="powercap", KERNEL=="intel-rapl:0", RUN+="/bin/sh -c 'chgrp leonidas /sys%p/energy_uj && chmod 0440 /sys%p/energy_uj'"`
  (it takes effect at the next boot, or run the `chgrp` and `chmod` once by hand).
- It runs as a systemd user service: `systemctl --user status homebase-status`, running
  `~/.local/bin/homebase-status`. To deploy a change: `cargo build --release` in
  `status-server-rs/` (its build output goes to `~/.cache/homebase-status-rs`, outside the project
  so Metro doesn't crawl it), copy `release/homebase-status` from there to `~/.local/bin/`, and
  `systemctl --user restart homebase-status`. It listens on port 8788; open it on the tailnet zone once with
  `sudo firewall-cmd --zone=tailnet --add-port=8788/tcp --permanent && sudo firewall-cmd --reload`.
- Every request needs the token in `status-server/token` (git-ignored, created on first start).
  `npm run status-server -- pair` sends a link through ntfy; tapping it on the phone fills in the
  app's connection settings. The link holds a one-time code (good for 10 minutes), not the token.
- Both servers only answer loopback and Tailscale addresses.
- Containers are found on their own; Quadlet ones are controlled through their systemd unit.
  Other units to show are listed in `UNITS` in `status-server-rs/src/usage.rs`.

## Jellyfin notes

- The server decides per file whether the phone can play it directly or needs it converted to
  HLS. MKV, DTS/TrueHD audio and ASS/PGS subtitles are converted by the server.
- Audio and subtitle tracks are picked from the system player's menu.
- Playback reports progress, so "Continue watching" stays in sync with other Jellyfin clients.
- Plain `http://` servers are allowed, for home networks.
