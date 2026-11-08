# PG Companion — Offline Android Guide and Academy

**Status:** implemented blueprint (built 2026-11-06)
**Canonical behaviour:** `project-design/parts/10-companion/00-offline-companion.md`
**Implementation:** `companion-app/`

## 1. Purpose

PG Companion is a private, offline-first Android application that carries the complete
Admin Interactive Guide and the learner-facing Employee Academy. It is built for staff who
need to read the guide and practise Academy material away from the live admin portal.

The companion:

- mirrors the true guide and academy content from the canonical design sources at build time;
- bundles that content inside the APK so every screen works in airplane mode;
- supports signed, content-only updates without reinstalling the APK;
- publishes signed APK releases through a private channel for app-shell updates;
- never connects to `core-back`, `admin-back`, the production database or the live Academy API;
- never ships the Academy exam question bank or answer keys.

## 2. Locked product decisions

| Decision | Value |
| :--- | :--- |
| App name | PG Companion |
| Android package | `ly.paymentgateway.companion` |
| Platform | Android first; Capacitor 8 + Vue 3 + TypeScript + Vite |
| Content | Complete Guide and complete learner Academy, including practice checks, labs and simulators |
| Official exams | Server-only; excluded from the APK. The app offers a clearly labelled practice exam |
| Updates | Signed content-only OTA plus signed APK releases |
| Distribution | Private release channel + Obtainium; never public |
| Language | English content, bilingual English/Arabic UI chrome, RTL-ready |
| Reading extras | Bookmarks, highlights, notes, reading rhythm, daily brief, focus mode, reminders |
| Build | One command produces a signed, verified APK with the latest content |

## 3. Canonical content source

The content is authored in:

- `design/07-guides-and-academy/guide_system_design_and_content.md`
- `design/07-guides-and-academy/academy_system_design_and_content.md`

The canonical extractors live in:

- `admin-front/scripts/extract-guide-content.ts`
- `admin-front/scripts/extract-academy-content.ts`

The companion build runs those extractors with redirected output:

```text
GUIDE_OUTPUT_DIR=companion-app/.cache/guide
ACADEMY_OUTPUT_DIR=companion-app/.cache/academy
ACADEMY_EXAM_BANK_PATH=companion-app/.cache/exam-bank.json
ACADEMY_CATALOG_PATH=companion-app/.cache/catalog.json
```

The extractors must not write into `admin-front` or `core-back` during a companion build.
The generated exam bank and server catalog are discarded; the exam bank is never copied into
the application bundle.

### 3.1 Content pipeline

```text
design/07-guides-and-academy/*.md
        |
        v
canonical extractors (output redirected into companion-app/.cache)
        |
        v
scripts/build-bundle.ts
  - validates ids, references, counts and links
  - rejects exam-bank leakage
  - rejects external URLs, private keys and credential-shaped strings
  - computes content hash
  - writes public/content/bundle.json and manifest.json
        |
        v
Vite build -> dist/ -> Capacitor sync -> Android assets -> APK
```

`public/content/` is the committed content snapshot. It makes the app independently
buildable and gives the APK reproducible content. `bun run content:check` re-runs the
extractors into a temporary directory and fails if the snapshot is stale.

### 3.2 Bundle shape

```ts
interface CompanionBundle {
  schema: 1;
  meta: {
    contentVersion: string;
    contentHash: string;
    guideSourceSha256: string;
    academyContentHash: string;
    generatedAt: string;
    counts: Record<string, number>;
  };
  guide: {
    books: Book[];
    articles: Article[];
    glossary: Term[];
    cards: Card[];
    playbook: Situation[];
    paths: ReadingPath[];
    faq: QuickAnswer[];
    data: GuideData;
    errorCodes: ErrorCode[];
    edgeCases: EdgeCase[];
  };
  academy: {
    meta: AcademyMeta;
    tracks: Track[];
    modules: Module[];
    lessons: Lesson[];
    checks: Question[];
    labs: Lab[];
    drills: Drill[];
    pages: AcademyPage[];
    examBlueprints: ExamBlueprintPublic[];
  };
}
```

The bundle excludes `exam-bank.json`, server catalog state, admin route/context data and
any non-learner operational state.

## 4. Application architecture

```text
companion-app/
  package.json
  bun.lock
  capacitor.config.ts
  build-apk.sh
  public/content/
    bundle.json
    manifest.json
  scripts/
    sync-content.ts
    build-bundle.ts
    check-content.ts
    build-apk.ts
  src/
    app/
    content/
    features/guide/
    features/academy/
    features/search/
    features/saved/
    features/today/
    features/settings/
    features/updates/
    features/reminders/
    features/tools/
    lib/markdown/
    lib/storage/
    lib/i18n/
    lib/motion/
  android/
  tests/
```

### 4.1 Runtime

- Vue 3 + TypeScript. No Vuetify and no remote UI runtime.
- `vue-router` with hash history for robust Capacitor navigation.
- Android back button handled through `@capacitor/app`.
- All content loaded from `public/content/bundle.json` or a verified updated bundle.
- Markdown rendered with the same `markdown-it` options and custom rules as the admin Guide:
  - `html: false`, `linkify: false`
  - callouts
  - internal guide links
  - glossary auto-linking
  - stable heading ids
  - table wrappers
  - diagram fences
  - widget placeholders
- Search uses MiniSearch over the loaded bundle. It is built lazily on first search.
- Progress, bookmarks, settings and reading positions are stored with Capacitor Preferences.
- Notes, highlights and downloaded content bundles are stored with Capacitor Filesystem.
- No critical state is stored only in WebView `localStorage`.

### 4.2 Navigation

Bottom navigation:

- **Today** — continue reading, daily brief, reading rhythm.
- **Guide** — books, reference catalogues, reading paths, tools.
- **Academy** — tracks, lessons, labs, practice exam, drills.
- **Saved** — bookmarks, highlights and notes.
- **Search** — global offline search.

Settings, content version and update controls live behind the top-bar menu.

## 5. Feature scope

### 5.1 Guide

- Guide home with continue reading, role reading path, books and reference shortcuts.
- Book page with progress and ordered articles.
- Article reader with markdown, callouts, tables, code, glossary links, table of contents,
  previous/next article, read state, bookmark, reading position and focus mode.
- Glossary A–Z with aliases, Arabic terms and related terms.
- Safeguard cards with risk filters and checklists.
- Situation playbook with linked articles and edge cases.
- Searchable, grouped 140-case edge-case catalogue.
- Quick answers and error codes integrated into search and reference.
- Five simulators: transform pipeline, signature lab, ledger explorer, visible rails and
  payment states.

### 5.2 Academy

- Track selection; Foundation plus role tracks.
- Modules, lesson pages, reading lists and practice checks.
- All 16 labs with offline scoring for choice, multi, ledger, order, checklist and numeric
  tasks.
- Lab briefing, progress, best score and critical-error handling.
- Drills and learner help pages.
- Practice exam built from practice checks and labs, explicitly labelled as practice.
- Official exam card explaining that certification requires the live Admin Academy.
- Offline practice record and completion progress.

### 5.3 Reading experience

- Bookmarks: saved articles/lessons, section bookmarks and resume links.
- Highlights and notes with local persistence and export.
- Reading rhythm: days read this week, not a punitive streak.
- Daily brief: deterministic short article, glossary term and safeguard card selected from
  the user's reading path.
- Focus mode: reading surface without app chrome.
- Light, dark and sepia themes; adjustable font size and line height; optional serif font.
- Calm comprehension streak: no loss aversion, no countdowns, no red badges.
- Gentle haptic and spring-motion celebration when an article or lesson is completed.
- Export/import of progress, bookmarks, highlights and notes.

### 5.4 Explicitly out of scope

- Official exam question bank, grading, badges and team view.
- Server progress sync.
- Real payment, merchant or admin actions.
- Authentication.
- Analytics or crash reporting.
- Public distribution.

## 6. Reminders

- Reminders are opt-in and requested only after the user has read something.
- The user chooses a preferred time: morning, lunch, evening or custom.
- Default reminder time is 20:00 local time.
- At most one reminder per day.
- If the user has already read that day, the next reminder is cancelled.
- Quiet hours default to 22:00–07:00.
- Scheduling uses `@capacitor/local-notifications` with:
  - `isExactNotification: false` — no special "Alarms & reminders" permission;
  - `allowWhileIdle: true` — reasonable Doze delivery;
  - a small rolling window of one-shot notifications, re-armed on launch and resume;
  - plugin boot restoration plus an app-launch re-arm as a safety net.
- Android 13+ notification permission is requested only when reminders are enabled.
- Notification copy is warm, specific and never guilt-based. Examples:
  - "Your bookmark is waiting — a five-minute read."
  - "Continue Book 8: Money & the Ledger."
  - "A short read for today: the visible-rails formula."
  - "The guide is here when you have a quiet moment."
- Actions: open last read, snooze one day, open reminder settings.
- If permission is denied, the app remains fully functional and shows a calm settings card.

## 7. Enjoyment design

Research on reading and habit apps shows that streaks can motivate but can also demotivate
after a break, and that fear-based engagement damages the underlying habit. The companion
therefore uses calm technology principles:

- no infinite feed;
- no social/leaderboard layer;
- no unread counts or red badges;
- no progress metrics inside the reading surface;
- no urgency or loss-aversion copy;
- progress is available at the edges and in the Today screen.

Delight comes from craft:

- generous typography and reading measure;
- true dark and warm sepia themes;
- subtle Material 3 Expressive spring motion and haptics;
- a quiet completion moment;
- a deterministic daily brief;
- highlighting and reflective notes;
- a reading rhythm that tolerates rest days.

Optional stretch features, only after the core is complete:

- Android home-screen "continue reading" widget;
- highlight review (Readwise-style resurfacing);
- Android app shortcuts.

## 8. Updates and distribution

### 8.1 Content-only update

- Manifest is signed with Ed25519; the public key is pinned in the APK.
- Bundle is verified by SHA-256 before parsing.
- Bundle schema and content ids are validated before activation.
- Update is written to a new versioned file and the active pointer is switched only after
  validation.
- Built-in content is immutable; a broken update falls back to it.
- No executable code is delivered by content updates.

Because private GitHub release assets need authentication, the app never embeds a GitHub
token. Content OTA uses a configurable private HTTPS endpoint when one is available. When it
is not, APK releases carry the latest content and Obtainium handles app updates.

### 8.2 APK update

- Signed with a long-lived release keystore.
- Same package name and signing key are required for in-place updates.
- Distributed through a private GitHub release channel and Obtainium, or by direct APK
  install.
- Android requires the user to confirm installation; there is no silent self-update.

## 9. Security and reliability

- `allowBackup=false`; progress is exported manually.
- Cleartext traffic disabled; no `server.url`; bundled assets only.
- Release WebView debugging disabled.
- Strict CSP; no remote assets.
- Minimal permissions: notifications, boot restore and internet only when the updater is
  enabled.
- No secrets, credentials, exam keys or external content URLs in the bundle.
- Content validation rejects private-key markers, credential-shaped strings and external
  URLs.
- The APK and content bundle are internal material and must not be published publicly.

## 10. One-command build

`companion-app/build-apk.sh` (also `bun run apk`) performs:

1. toolchain checks;
2. `content:sync` — run canonical extractors and rebuild the bundle;
3. `content:check` — prove the snapshot is current;
4. dependency install if required;
5. typecheck and tests;
6. Vite build;
7. Capacitor sync;
8. Gradle APK build;
9. signing and `apksigner` verification;
10. copy to `release/PG-Companion-<version>-<hash>.apk`;
11. write `SHA256SUMS` and `build-info.json`;
12. optional `adb install -r` with `--install`.

Options: `--debug`, `--offline-snapshot`, `--install`, `--skip-tests`.

## 11. Verification

- Extractor parity and content validation.
- Markdown rendering of every article and lesson.
- Search smoke tests.
- Lab scoring vectors.
- Reminder scheduling/cancellation.
- Signed update acceptance and tamper rejection.
- Bookmark/highlight re-anchoring after content changes.
- Web build and Android APK build.
- Airplane-mode device smoke test.
- Accessibility, layout and performance checks.

## 12. Isolation

All application code and generated artifacts live under `companion-app/`.

No runtime code in `admin-front`, `core-back`, `admin-back` or `deploy` is changed. The
extractors are invoked as build tools with redirected output. Documentation changes are
recorded in the canonical project-design part and tracker.

## 13. Implementation order

1. Content pipeline and bundle.
2. Runtime content/search/markdown/progress.
3. Guide reading and reference surfaces.
4. Academy learning, labs and simulators.
5. Android shell, APK and one-command build.
6. Reminders, daily brief, reading rhythm and polish.
7. Signed content updates and CI release path.
8. Tests, hardening, documentation and release.


---

## 14. As-built verification (2026-11-06)

The implementation was built end to end from a clean content extraction. The release APK
`PG-Companion-1.0.88-c16fb55-release.apk` is 3.8 MiB, signed and verified with `apksigner`;
its SHA-256 is `75960424c47ca254a009a4c91156584a8c03a5eaaf15cf7ead245b66d4e1f013`.
The Ed25519-signed content manifest and bundle SHA-256 were independently verified.
Typecheck, 16 unit tests, the web build, content parity, and a 24-route web layout sweep at
360/390/768 px in light/dark/sepia and English/Arabic chrome passed with no overflow or
console errors. No Android device or emulator was connected, so on-device installation,
airplane-mode, notification delivery after reboot and real-device performance are recorded
as open gaps in `parts/10-companion/00-offline-companion.md`.
