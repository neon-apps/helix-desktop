# Helix Desktop

Native desktop shell for [Helix](https://helix.neonapps.co) (macOS + Windows).

A thin Electron wrapper around the live web app — no product code, no secrets.
It loads `https://helix.neonapps.co` in a native window and adds:

- Dock / taskbar **unread badge** (mirrors a `(3)` count in the page title, or
  driven explicitly by the web app via `window.helix.setBadge(n)`)
- Real OS **notifications**
- External links open in the system browser
- Remembered window size/position
- Silent **auto-updates** of the shell (via `electron-updater`)

Because the window points at the live site, **every Helix product update ships
instantly** with no app update. Auto-update only kicks in when this shell
itself changes.

Installers + the auto-update feed are published to this repo's **GitHub
Releases**. The repo is public so the (secret-free) `.dmg`/`.exe` are publicly
downloadable by the Helix `/download` page.

## Develop

```bash
npm install
npm start                 # loads production https://helix.neonapps.co
npm run dev               # loads http://localhost:3000 instead
```

## Build installers locally (no publish)

```bash
npm run dist:mac          # → dist/Helix-mac-arm64.dmg, Helix-mac-x64.dmg
npm run dist:win          # → dist/Helix-win-x64.exe   (run on Windows)
```

## Release

Push a version tag; GitHub Actions builds all three targets and publishes the
installers + auto-update feed to Releases:

```bash
npm version patch         # bumps package.json + creates the tag
git push --follow-tags
```

Stable download URLs (used by the Helix `/download` page):

- `https://github.com/neon-apps/helix-desktop/releases/latest/download/Helix-mac-arm64.dmg`
- `https://github.com/neon-apps/helix-desktop/releases/latest/download/Helix-mac-x64.dmg`
- `https://github.com/neon-apps/helix-desktop/releases/latest/download/Helix-win-x64.exe`

## Signing (optional)

Unsigned builds work but show a one-time "unidentified developer" warning. To
sign + notarize, add the `CSC_LINK` / `APPLE_ID` / … secrets and reference them
in `.github/workflows/release.yml`.
