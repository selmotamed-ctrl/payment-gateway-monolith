# Guide, Academy and Companion clarity overhaul: finalized plan and outcome

Status: **executed 2026-11-07**. This file replaces the first draft of the plan, which contained about 2,000 lines of
"drop-in" code and article replacements written against an older snapshot (94 articles, 45 lessons, five services).
The canonical record of what shipped is `project-design/parts/03-admin-front/03-guide-and-academy.md` (including the
authoring standard in section 10) and `project-design/TRACKER.md`.

## 1. Is the plan worth it?

**The diagnosis: yes. The verbatim replacements: no.**

The owner's observation was right: Books 0 and 1 are easy and the reading gets harder from Book 2. Measured on the
128-article tree, the cause is not long sentences (the average was already 12 words). It is four things:

| # | Cause | Evidence |
| :--- | :--- | :--- |
| 1 | Cross-references injected whole titles into sentences, and reference pointers in parentheses broke the thought. | A bare `[[a:id]]` rendered a 10 to 15 word title in the middle of a sentence. |
| 2 | From Book 2 on, articles are **tables and identifiers without a story**: `b02-04`, `b02-05`, `b02-06`, `b04-05`, `b06-03`, `b06-05`, `b06-15`, `b06-17`, `b09-07`, `b12-05`. | 26 of 101 articles held a sentence over 28 words; most Book 5 to 12 articles open with a table or a list of code names. |
| 3 | No orientation layer for the CEO or the newcomer: 22 of 128 articles had an "In plain words" summary. | Readers had to read to the end to learn the point. |
| 4 | Academy lessons were 150 to 250 word flashcards (40 of 50), so a learner had to open the Guide to pass the quiz. | Median lesson body 180 words, worked example 20 to 30 words. |

The draft's **reader changes** (extract pointer parentheticals into a per-section tray, `:::summary`, `:::refs`,
a preview popover) were adopted and are implemented in both readers.

The draft's **article and lesson replacements were rejected**. Checked against the code they were wrong in ways that
would have taught staff false things: five services instead of seven; merchant lifecycle states that do not exist;
"fourteen states" mixed with thirteen; ids and titles that do not exist in the 128-article tree. Applying them would
also have deleted current topics and broken cross-references. Every article was instead rewritten from the live text
and the live code.

## 2. Research behind the authoring standard

* **ISO 24495-1:2023 (plain language)**: readers must be able to find, understand and use what they need. Most of the
  standard is structure and findability, not word choice.
* **Worked-example effect (cognitive load theory)**: novices learn faster from a concrete example than from an abstract rule.
* **Expertise-reversal effect**: the same scaffolding slows experts down. So articles are *layered*: the summary and
  tables serve the expert, the story and example serve the newcomer, and nobody has to read both.
* **Readers**: most are Arabic speakers reading English, so short sentences, no idioms, one name per concept.

The resulting standard (article anatomy, sentence rules, link rules, shared cast, "facts are sacred") is in
`project-design/parts/03-admin-front/03-guide-and-academy.md`, section 10.

## 3. What was done

1. **Readers** (earlier pass, kept): Related trays, short inline labels, `:::summary` and `:::refs` callouts, preview popover
   (Admin Guide) and preview sheet (Companion). The clarity script keeps inline links labelled.
2. **101 Guide articles rewritten** (Books 2 and 4 to 12): each opens with a two-sentence summary and a plain-language
   opening, then short sections, a worked example where numbers or sequences matter, and the original reference tables
   (every row kept). Book 13 (pure lookup), Books 0, 1 and 3 (already easy) were not touched.
3. **40 Academy lessons rewritten** into self-contained 350 to 600 word tutorials (all 50 lessons are now in this form).
   Headings, check ids, "Read now" links and counts are unchanged; every correct answer and the reason each wrong
   option is wrong is taught in the lesson.
4. **Process** (this is what makes the result trustworthy): 13 parallel writers, each validated mechanically
   (`check_block`: header unchanged, every link target kept, widgets kept, headings, no dropped numbers or code terms);
   then 10 independent review runs (including the nine lessons from the earlier pass, whose text proved the least reliable) who compared old and new text and checked suspicious claims in the code; then fixers.
   Review found **21 HIGH and about 67 MED** problems that the mechanical validator could not see (invented behaviour,
   wrong example roles, misleading analogies). All were fixed or kept as the original wording.

## 4. Measured result (Books 2 and 4 to 12, 101 articles)

| Measure | Before | After |
| :--- | :--- | :--- |
| Average sentence length | 12.0 words | 10.1 words |
| Flesch reading ease | 48 | 59 |
| Parenthetical asides per 100 words | 1.2 | 0.3 |
| Articles with a sentence over 28 words | 26 | 4 |
| Longest sentence | 49 words | 32 words |
| Articles with an "In plain words" summary (of 128) | 22 | 101 |
| Words in those articles (average) | 194 | 374 |

Length roughly doubled on purpose: the added words are the explanation, the example and the "what you do" steps.

## 5. Factual errors found and fixed while rewriting

| Where | Old claim | Corrected to | Evidence |
| :--- | :--- | :--- | :--- |
| `b02-07` | The database has 64 tables | 76 models, regrouped into seven groups | `core-back/prisma/schema.prisma` |
| `b02-04`, `b05-01` summaries | Merchant states include FROZEN / TERMINATED | PENDING, ACTIVE, SUSPENDED, REJECTED, CLOSED (FROZEN is a wallet status) | `enum MerchantStatus` |
| `b02-05` | Sadad sends us messages through inbound callbacks | Sadad is asked by the core; it has no webhook | `project-design/parts/06-fake-rails/01-protocol-matrix.md` |
| `b08-02` | `COMMISSION_RECEIVABLE` is per merchant | One per platform | `LedgerPoster.ts` (`ACCOUNT_SCOPING`) |
| `b12-05`, `b12-07`, `l-m10-3`, quiz `q-m10-107`/`q-m10-110` | A failed end-to-end check returns to the previous release automatically; rollback is one link switch | No automatic rollback. The new release stays current, the previous one stays on disk, and a manual rollback also restarts the backend from the previous release folder | `deploy/README.md` sections 7 and 12; `deploy.ts` |
| `l-m1-1` worked example | A "Pending to Available" balance flow and a 2 LYD "gateway fee" | Only facts the Guide states (partner confirms, platform verifies and books, settlement and reconciliation follow) | `b01-01`, `b08-*` |

## 6. Open decisions for the owner (text and code disagree; wording kept as the original)

1. **Cash-outs (`b08-07`)**: the Guide describes a second Finance user approving the subtraction. The code lets one
   actor process a cash-out straight to `COMPLETE` (`executeCashout`; documented in `parts/01-core-back/04-governance-compliance.md`).
   This is a policy question (maker-checker is a project invariant) as much as a documentation one.
2. **Ledger drift (`b08-05`, `b08-06`, `b08-07`, `l-m9-2`, a quiz and exam text)**: the Guide says drift stops automatic payouts.
   `LedgerInvariantWorker` only opens a P1 case; nothing found halts payouts.
3. **Commission profiles (`b08-03`)**: the Guide says changes need approval; the governance part says creation is a direct route.
4. **Circuit-breaker counting**: `b06-08`, `b06-11` and a check question word it three ways; the code uses a per-error flag
   (`counts_toward_breaker`, `specSchema.ts`).
5. **Smaller**: `b06-15` says "twenty integrations" and lists 21 rows; `b12-05` keeps the "twelve-step" title while the tool runs 14
   steps; `b12-03` says "four certificates" but the tool creates more; `b06-11` calls WEIGHTED a "share of traffic" but the
   resolver only sorts by weight; `b09-*` says a suppression "may" carry an expiry while the exam says "must".
6. **Not rewritten**: Books 0, 1, 3 and 13 have no "In plain words" banner. Add one if you want every article uniform.

## 7. Verification

`bun scripts/overhaul-guide-and-academy-clarity.ts --check`; `cd admin-front && bun run content:guide && bun run content:academy &&
bun run type-check && bun run test:unit && bun run build`; `cd companion-app && bun run content:sync && bun run content:check &&
bun run typecheck && bun test && bun run build`; `cd tests && bunx vitest run unit`; `bun scripts/project-design/build.ts --check`.
Results are in `project-design/TRACKER.md` (verification log, 2026-11-07).
