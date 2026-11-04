# CrashLands Overlay

The in-game overlay for the CrashLands server on The Isle (Evrima): HUD, hexagon minimap, notifications,
proximity voice with push to talk, and the CrashLands player website in game (F8).

This is the overlay's full source, so anyone can see what it does on their PC.

**Download:** get the zip from the Overlay page on [players.crashlands.online](https://players.crashlands.online).
It updates itself after that.

## What it does on your PC

- Draws a transparent window over The Isle. It does not read or change the game's memory or files.
- Talks only to `players.crashlands.online` (your dino's stats, the minimap, notifications, voice) and, for staff,
  `admin.crashlands.online`.
- Signs you in with Steam through our website. Your session is stored encrypted with Windows' own protection
  (Electron `safeStorage`).
- Reads keyboard/mouse state only for the push-to-talk key you choose (`app/native.cjs`).
- Updates are checked against our own signature (`update-public-key.pem`) before installing.

## Build

```
npm install
npm start          # run it
npm run dist       # build the installer into release/
```

Releases are signed with a private key that is not in this repo (`tools/sign-release.cjs`), so a build you make
yourself won't be accepted by the auto-updater of the official overlay.
