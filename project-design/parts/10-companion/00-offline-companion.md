---
id: companion.offline
title: Offline Android Companion
status: partial
confidence: high
last_verified: 2026-11-07
verified_against: working-tree
code:
  - companion-app/**
  - design/06-ui/pg_companion_offline_android_app.md
design_sources:
  - design/06-ui/pg_companion_offline_android_app.md
  - design/07-guides-and-academy/guide_system_design_and_content.md
  - design/07-guides-and-academy/academy_system_design_and_content.md
tests:
  - companion-app/tests/content.test.ts
  - companion-app/tests/markdown.test.ts
  - companion-app/tests/search.test.ts
  - companion-app/tests/lab-scoring.test.ts
  - companion-app/scripts/check-content.ts
  - companion-app/build-apk.sh
gaps:
  - No Android device or emulator was connected in the build environment; the signed APK was built and verified with apksigner but not installed, so airplane-mode, notification-delivery-after-reboot and real-device performance checks remain.
  - The content-only OTA client is implemented and signed-manifest generation is verified, but no private update endpoint is hosted yet; APK releases carry the latest content by default.
  - Official certification exams, the exam question bank and team view are intentionally excluded. The app provides only practice checks, labs and a practice exam.
  - The five guide simulators are compact offline reimplementations of the admin tools, not a pixel-for-pixel port; their engines are copied from the canonical admin-front logic.
---

# Offline Android Companion

## 1. Purpose and scope

PG Companion (`companion-app/`, application ID `ly.paymentgateway.companion`) is a private,
offline-first Android application containing the complete Admin Interactive Guide and the
learner-facing Employee Academy. It is a new standalone workspace and does not import
runtime code from `admin-front`, `admin-back`, `core-back` or `deploy`.

It exists so staff can read the guide and practise Academy material away from the live admin
portal. It has no login, no server progress sync, no backend calls and no analytics. Official
certification exams are deliberately excluded because their question bank and answer keys
must never leave the server.

The approved blueprint is `design/06-ui/pg_companion_offline_android_app.md`; the
implementation contract is `companion-app/BLUEPRINT.md`.

## 2. Content pipeline

The app mirrors the true content during build:

1. `companion-app/scripts/sync-content.ts` runs the canonical extractors
   `admin-front/scripts/extract-guide-content.ts` and
   `admin-front/scripts/extract-academy-content.ts` with output paths redirected into
   `companion-app/.cache/`.
2. `scripts/build-bundle.ts` validates counts, ids, cross-document links, lesson reading and
   check references, lab references, exam-bank leakage, external URLs and private-key
   markers. It writes `public/content/bundle.json` and `manifest.json`.
3. The exam bank and server catalog stay in `.cache` and are never copied into the app.
4. `scripts/check-content.ts` re-runs the extractors and fails if the committed snapshot is
   stale, or if `admin-front` generated content has drifted.

The current snapshot contains 14 guide books, 128 articles, 151 glossary terms, 25 safeguard
cards, 32 situations, 58 quick answers, 19 error codes, 140 edge cases; and 8 Academy tracks,
11 modules, 50 lessons, 100 practice checks, 16 labs / 92 tasks, 11 drills and 6 learner pages.
The exam bank has 223 questions with keys but is not in the bundle.

## 3. Application

The client is Vue 3 + TypeScript + Vite + Capacitor 8. It uses hash routing, no Vuetify, no
remote UI assets, and a self-contained markdown renderer with callouts, guide links,
glossary auto-linking, heading ids, table/diagram handling and simulator placeholders.

The clarity renderer matches the Admin Guide: parenthetical reference dumps are removed from
sentences and collected into a per-section **Related** tray of typed pills; bare inline links
use a short natural title rather than the full article title; `:::summary` renders an
"In plain words" banner and `:::refs` renders a "Where to go next" footer; and tapping a
guide, screen or playbook pill opens a **reference preview sheet** with a short body,
**Keep reading here** and **Open full page →**. The sheet is dismissible by backdrop,
Escape or its close button.

Screens:

- Today: continue reading, deterministic daily brief, reading rhythm, role reading path.
- Guide: home, book, article reader, glossary, safeguard cards, playbook, 140 edge cases,
  quick answers/error codes, five simulators.
- Academy: tracks, modules, lessons, practice checks, all 16 labs with offline scoring,
  drills, help pages and a practice exam.
- Saved: article/lesson bookmarks, section bookmarks, highlights and notes.
- Search: offline MiniSearch over guide and academy.
- Settings: theme, text size, serif reading font, language/RTL, reading path, reminders,
  export/import, content updates, versions.

Progress, bookmarks, reading positions, highlights, reading days and settings use Capacitor
Preferences. Notes/highlights and downloaded content bundles use Capacitor Filesystem. No
critical state is stored only in WebView localStorage.

## 4. Reminders and reading experience

Reading reminders are opt-in, scheduled with `@capacitor/local-notifications` as inexact,
Doze-friendly one-shot reminders for a rolling window. The app re-arms them on launch/resume
and the plugin restores them after boot. Reminders are skipped when the user already read
that day or the chosen time falls inside quiet hours. Android 13+ notification permission is
requested only when the user enables reminders.

The reading experience avoids punitive streak mechanics. It shows a weekly reading rhythm,
with rest days allowed, a deterministic daily brief, focus mode, bookmarks, highlights,
notes, light/dark/sepia themes, adjustable typography, subtle completion feedback and native
app shortcuts (Continue, Search, Saved, Guide). Android installation is private; the APK and
content bundle must not be published publicly.

## 5. Updates and signing

Content-only updates are signed manifests plus a bundle:

- `bun run content:key` creates the Ed25519 content key in `.keys/` and writes the public key
  to `public/content/public-key.txt`.
- `COMPANION_UPDATE_BASE_URL=... bun run release:content` writes
  `release/content-<hash>.json` and `release/manifest.json` with a signature over the bundle
  SHA-256.
- The client verifies the pinned signature, bundle SHA-256 and bundle schema before writing a
  versioned file and switching the active pointer atomically. A bad update falls back to the
  APK bundle. Content updates are data-only and cannot execute code.

APK releases use a separate long-lived release keystore generated on first local build at
`.keys/companion-release.jks` (password in `.keys/keystore.env`, mode 0600, gitignored).
The same package name and signing key are required for in-place updates. The APK is signed
and verified with `apksigner`; `allowBackup` and cleartext traffic are disabled, and the
exact-alarm permission is removed because reminders are intentionally inexact.

`.github/workflows/companion.yml` builds and tests on content changes, publishes a private
release when the signing secrets are present, and can be run manually. Content OTA needs a
private HTTPS endpoint; if one is not available, APK releases carry the latest content.

## 6. Build

`companion-app/build-apk.sh` (also `bun run apk`) performs content sync, content check,
typecheck, tests, web build, Capacitor sync, Gradle APK build, signing, `apksigner`
verification, copy to `release/` and SHA-256/build-info generation. It detects a JDK 21
installation (including `$HOME/.jdks/temurin-21`), Android SDK platform 36 and build-tools.
`--offline-snapshot`, `--debug`, `--install` and `--skip-tests` are available.

The 2026-11-06 build produced a 3.8 MiB signed APK with SHA-256
`75960424c47ca254a009a4c91156584a8c03a5eaaf15cf7ead245b66d4e1f013`.

## 7. Verification

- `bun run content:check` passes against the canonical extractors.
- `bun run typecheck` passes.
- `bun test` passes 21 tests: content integrity, markdown rendering (including parenthetical
  extraction, summary/refs callouts, section trays and preview-snippet helpers), offline
  search and all 18 published lab-scoring vectors.
- Web Playwright smoke covers 24 routes at 360/390/768 px, light/dark/sepia, English/Arabic
  chrome, with no horizontal overflow or console errors.
- The release APK passes `apksigner verify`; the content manifest signature and bundle
  SHA-256 were independently verified.
- Not run: installation on a physical device or emulator, airplane-mode smoke, notification
  delivery after reboot, and real-device performance measurements.
