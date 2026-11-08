# PG Companion — implementation blueprint

This workspace implements the approved blueprint in
[`../design/06-ui/pg_companion_offline_android_app.md`](../design/06-ui/pg_companion_offline_android_app.md).

**App:** PG Companion (`ly.paymentgateway.companion`)
**Platform:** Android first, Capacitor 8 + Vue 3 + TypeScript + Vite
**Content:** full Guide and learner Academy, generated from the canonical extractors at build time
**Updates:** signed content-only OTA + signed APK releases
**Distribution:** private release channel + Obtainium, never public

## Non-negotiables

1. The app works in airplane mode. No login, no backend, no live Academy API.
2. Guide and Academy content is generated, never retyped into components.
3. The exam question bank and answer keys never enter the bundle or the APK.
4. `public/content/` is a reproducible snapshot of the canonical extractor output.
5. The build fails if the content snapshot is stale, malformed or contains secrets/external URLs.
6. Progress and bookmarks use Capacitor Preferences; notes/highlights and updated bundles use Filesystem.
7. Content OTA is data only and is signed; it cannot execute code.
8. The same release keystore must sign every APK so updates preserve data.
9. The APK and content bundle are internal material and must not be published publicly.
10. The app never uses a punitive streak, unread badge or guilt-based reminder.

## Runtime layout

```text
src/
  app/          application shell, router, theme, i18n
  content/      bundle loading, types, selectors, search
  features/     guide, academy, search, saved, today, settings, updates, reminders, tools
  lib/          markdown, storage, progress, motion, haptics
  components/   shared mobile primitives
```

## Content pipeline

```bash
bun run content:sync    # extractors -> .cache -> public/content/bundle.json + manifest.json
bun run content:check   # fail if public/content is stale or invalid
```

The extractors are `../admin-front/scripts/extract-*-content.ts`, invoked with output paths
redirected into `companion-app/.cache`. The companion build never writes into `admin-front`
or `core-back`.

## Build

```bash
./build-apk.sh                 # sync content, check, typecheck, test, web build, APK, verify
./build-apk.sh --debug         # debug APK
./build-apk.sh --offline-snapshot
./build-apk.sh --install       # adb install -r after build
bun run apk                    # wrapper around build-apk.sh
```

Requirements: Bun, Node 22+, JDK 21, Android SDK platform 36 and build-tools 36.

## Release identity

- APK: `release/PG-Companion-<version>-<contentHash7>.apk`
- Checksums: `release/SHA256SUMS`
- Build metadata: `release/build-info.json`
- Content manifest: `public/content/manifest.json`

## Verification

```bash
bun run typecheck
bun test
bun run build
./build-apk.sh --debug
```

Device smoke: airplane mode, open Guide and Academy, search, bookmark, run a lab, restart
the app and confirm progress, then test reminders and the update path.

## Signing and update keys

- Local APK signing: `./build-apk.sh` creates `companion-app/.keys/companion-release.jks`
  on first use and prints a reminder to back it up. The generated password lives in
  `.keys/keystore.env` (0600, gitignored).
- Content signing: `bun run content:key` creates `.keys/content-signing.env` and writes the
  pinned public key to `public/content/public-key.txt`.
- Signed content update: `COMPANION_UPDATE_BASE_URL=... bun run release:content`.
- The app never embeds an APK signing key or a content private key.

## Current verification state

- Content parity, typecheck, 16 unit tests, web build, Capacitor sync, release APK build,
  `apksigner` verification and signature/manifest verification all pass.
- No Android device or emulator is connected in the build environment, so on-device
  installation, reminder delivery across reboot, and airplane-mode smoke testing are the
  remaining manual release checks.
