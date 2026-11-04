# Academy content fixes

Append-only log of label and route-map corrections made while implementing the Employee Academy
(`academy_system_design_and_content.md`, Part 0 rule 5). Format for label corrections:
`itemId | old label | new label | file:line`. Only label text is ever changed here; explanations,
option correctness and scores are never edited (behaviour doubts go to `academy_content_questions.md`).

## Guide context-map route names (Academy design §I-5)

| Screen | Change | Reason | Source |
| :--- | :--- | :--- | :--- |
| Academy | Added `AdminAcademyTracks`, `AdminAcademyTrack`, `AdminAcademyModule`, `AdminAcademyLesson`, `AdminAcademyLab`, `AdminAcademyExam`, `AdminAcademyCertificate`, `AdminAcademyTeam`, `AdminAcademyHelp` to `routeNames` in `guide_system_design_and_content.md` §III-F.3 | The Academy now has ten routes; the contextual-help drawer resolves the current route through this map. | `admin-front/src/router/index.ts` |

## Spec corrections (not content)

| Item | Change | Reason |
| :--- | :--- | :--- |
| §II-13 A-3 | "the 14 labs" → "the 15 labs" | §II-2.5 and Part III both define 15 labs. |
| §II-2.6 `Panel` | Added the title-only form | Lab `lab-security-desk/s5` has a panel that is only a scenario statement. |
| §II-1 / §II-7 | Paths mapped to the real repository layout; no migration | `users.academy_progress_json` already exists. |

## Label corrections

<!-- itemId | old label | new label | file:line -->
l-m3-2 | **Details** | **Review** | `admin-front/src/pages/approvals/index.tsx:730`
lab-approval-desk (option "Approve without opening…") | **Details** | **Review** | `admin-front/src/pages/approvals/index.tsx:730`
lab-approval-desk (option "I read the old and new value in…") | **Details** | **Review** | `admin-front/src/pages/approvals/index.tsx:730`
lab-approval-desk (task text) | **Decision Reason** | **Decision reason** | `admin-front/src/pages/approvals/index.tsx:1067`
l-m5-4 (×2) | **Bulk Inquiry** | **Inquire selected** | `admin-front/src/pages/operator-cases/index.tsx:1077`
lab-incident-unknown | **Mark succeeded** | **Resolve as succeeded** | `admin-front/src/pages/operator-cases/[id].tsx:190`
lab-compliance-desk | **Propose** | **Propose resolution** | `admin-front/src/pages/aml/cases/index.tsx:656`
drill-breaker | **Open Circuit Breakers** (Dashboard tile) | **Open breaker** (Route health card) | `admin-front/src/pages/dashboard/index.tsx:509`
