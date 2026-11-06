# PG Companion

Offline Android companion for the Admin Interactive Guide and the learner-facing Employee
Academy. The full design is in
[`../design/06-ui/pg_companion_offline_android_app.md`](../design/06-ui/pg_companion_offline_android_app.md).
The implementation contract is in [`BLUEPRINT.md`](BLUEPRINT.md).

## What it is

- Complete Guide: books, articles, glossary, safeguard cards, playbook, edge cases, quick
  answers, error codes and five simulators.
- Learner Academy: tracks, modules, lessons, practice checks, all labs, drills, help pages
  and an offline practice exam.
- Offline-first: every screen works in airplane mode.
- Bookmarks, highlights, notes, reading rhythm, daily brief and optional reading reminders.
- Signed content-only updates and signed APK releases for private distribution.

Official certification exams stay on the live Admin Academy. Their question bank is never
shipped in the APK.

## Quick start

```bash
bun install
bun run content:sync
bun run dev
```

## Build an APK

```bash
# requires JDK 21, Android SDK 36 and build-tools 36
./build-apk.sh

# local debug build
./build-apk.sh --debug

# install on a connected device
./build-apk.sh --install
```

The signed APK is written to `release/` with a SHA-256 checksum and build metadata.

## Content

Content is extracted from the canonical files in `../design/07-guides-and-academy/` through
the existing admin extractors. The committed snapshot lives in `public/content/`.

```bash
bun run content:sync
bun run content:check
```

## Verification

```bash
bun run typecheck
bun test
bun run build
```

## Distribution warning

The Guide and Academy contain internal operational material. Do not publish the APK,
content bundle or release channel publicly.

## Release signing and content updates

The build script creates a local release keystore on first use at
`companion-app/.keys/companion-release.jks` and stores its generated password in
`companion-app/.keys/keystore.env` (mode 0600, gitignored).

**Back up `companion-app/.keys/`.** The same APK signing key is required for every future
in-place update. Losing it forces an uninstall/reinstall and loses local data.

Content-only updates use a separate Ed25519 key:

```bash
bun run content:key
```

This creates `.keys/content-signing.env` and writes the public key to
`public/content/public-key.txt`. The build pins that public key. To produce a signed
content update:

```bash
COMPANION_UPDATE_BASE_URL=https://updates.example.internal/companion bun run release:content
```

Publish `release/content-*.json` and `release/manifest.json` at that URL. The app verifies
the manifest signature and the bundle SHA-256 before activating it. Updates are data-only;
they cannot execute code.

The CI workflow `.github/workflows/companion.yml` expects these repository secrets for
release builds:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
- `COMPANION_CONTENT_SIGNING_KEY`

and the repository variable `COMPANION_UPDATE_BASE_URL` for content-update publishing.
CI derives and pins the content public key from `COMPANION_CONTENT_SIGNING_KEY` before building.
Without the signing secrets, CI still builds and tests a debug APK artifact.

## Verified build

On 2026-11-06 the full pipeline produced:

```text
release/PG-Companion-1.0.88-c16fb55-release.apk
SHA-256 75960424c47ca254a009a4c91156584a8c03a5eaaf15cf7ead245b66d4e1f013
```

The APK is about 3.8 MiB, signed, and verified with `apksigner`. The environment had no
connected Android device, so installation and on-device reminder/airplane-mode smoke tests
remain for the first device run.
