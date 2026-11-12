import {
  REPORT_ENGINE_VERSION,
  REPORT_SPEC_VERSION,
  REPORT_TRANSCRIPT_VERSION,
  REPORT_CHROME_SPEC_VERSION,
  REPORT_CHROME_TRANSCRIPT_VERSION,
} from "../version";
import type { ReportCompatibilityResult } from "../compatibility/reportCompatibility";
import type { ChromeCompatibilityResult } from "../compatibility/chromeCompatibility";
import { findMigrationGuide } from "./reportMigrationRegistry";

export interface MigrationPromptInput {
  code: string;
  version: number;
  oldSpec: unknown;
  compatibility: ReportCompatibilityResult | ChromeCompatibilityResult;
  targetTranscript: string;
  targetTranscriptVersion: string;
  merchantMode?: boolean;
}

function renderGuide(subject: "REPORT" | "CHROME", compatibility: ReportCompatibilityResult | ChromeCompatibilityResult): string[] {
  const guide = findMigrationGuide(subject, compatibility.storedEngineVersion, REPORT_ENGINE_VERSION);
  if (!guide) {
    return [
      "### Migration Guide",
      "No subject-specific guide is registered for this transition. Use the target transcript and preserve the report semantics exactly.",
    ];
  }
  return [
    "### Migration Guide",
    `Summary: ${guide.summary}`,
    "Breaking changes:",
    ...guide.breakingChanges.map((entry) => `- ${entry}`),
    ...(guide.promptNotes.length ? ["Migration notes:", ...guide.promptNotes.map((entry) => `- ${entry}`)] : []),
  ];
}

function renderCompatibility(compatibility: ReportCompatibilityResult | ChromeCompatibilityResult): string[] {
  return [
    "### Compatibility Finding",
    `Status: ${compatibility.status}`,
    `Reason: ${compatibility.reasonCode ?? "UNKNOWN"}`,
    `Message: ${compatibility.message}`,
    `Stored engine version: ${compatibility.storedEngineVersion ?? "unknown"}`,
    `Stored spec version: ${compatibility.storedSpecVersion ?? "unknown"}`,
    ...(compatibility.issues.length
      ? [
          "Issues:",
          ...compatibility.issues.map(
            (issue) => `- [${issue.code}] ${issue.path}: ${issue.message}`,
          ),
        ]
      : []),
  ];
}

export function buildReportMigrationPrompt(input: MigrationPromptInput): string {
  const compatibility = input.compatibility as ReportCompatibilityResult;
  const dryRunReminder = input.merchantMode
    ? "Verify the migrated spec in Merchant Report Studio; it may only use merchant-safe models, inputs and assets."
    : "Verify the migrated spec in Report Studio; it must pass all five verification layers.";
  return [
    "# Report Descriptor Migration",
    "",
    `You are migrating the stored report \`${input.code}\` version ${input.version} to the current Report Engine contract.`,
    `Target engine version: \`${REPORT_ENGINE_VERSION}\``,
    `Target report spec version: \`${REPORT_SPEC_VERSION}\``,
    `Target authoring transcript version: \`${input.targetTranscriptVersion || REPORT_TRANSCRIPT_VERSION}\``,
    "",
    "Return exactly one complete JSON `REPORT_DESCRIPTOR` object. No markdown fences, no commentary, no partial patch.",
    "",
    "## Rules",
    "- Preserve the report's business meaning, datasets, filters, sections and bilingual intent.",
    "- Preserve `report.code`; `report.version` may stay unchanged because saving creates the next stored version.",
    "- Use only models, columns, relations, operators, transforms, sections, variables and limits from the target transcript.",
    "- Do not invent fields, SQL, external URLs, scripts or secrets.",
    "- Keep `i18n.locales.en` and `i18n.locales.ar` complete.",
    "- Do not author headers/footers inside the report spec. Keep the existing chrome selection mode; chrome is a separate workflow.",
    `- ${dryRunReminder}`,
    "",
    ...renderCompatibility(compatibility),
    "",
    ...renderGuide("REPORT", compatibility),
    "",
    "## Original Stored Spec",
    "```json",
    JSON.stringify(input.oldSpec, null, 2),
    "```",
    "",
    "## Target Authoring Transcript",
    input.targetTranscript,
    "",
    "## Required Output",
    "Return only the migrated JSON object. Before returning, run the target transcript's mandatory self-validation checklist.",
  ].join("\n");
}

export function buildChromeMigrationPrompt(input: MigrationPromptInput): string {
  const compatibility = input.compatibility as ChromeCompatibilityResult;
  return [
    "# Report Header/Footer Migration",
    "",
    `You are migrating the stored header/footer \`${input.code}\` version ${input.version} to the current Report Engine contract.`,
    `Target engine version: \`${REPORT_ENGINE_VERSION}\``,
    `Target chrome spec version: \`${REPORT_CHROME_SPEC_VERSION}\``,
    `Target chrome transcript version: \`${input.targetTranscriptVersion || REPORT_CHROME_TRANSCRIPT_VERSION}\``,
    "",
    "Return exactly one complete JSON `REPORT_CHROME` object. No markdown fences, no commentary, no partial patch.",
    "",
    "## Rules",
    "- Preserve the chrome code and chrome type.",
    "- Preserve the intended visual design, height, first-page behaviour and accent/border style.",
    "- Preserve every locale and translation key; `en` and `ar` remain mandatory.",
    "- Use only variables and fields documented in the target chrome transcript.",
    "- Assets must be declared in `required_assets` and referenced as `asset://asset_key`; no external or data URLs.",
    "- Keep `used_variables` exactly in sync with the template.",
    "- If the original chrome had assets, remind the user to re-attach the asset zip when saving the migrated version.",
    "- Verify the migrated chrome in Chrome Studio or Report Branding and save it as a new version.",
    "",
    ...renderCompatibility(compatibility),
    "",
    ...renderGuide("CHROME", compatibility),
    "",
    "## Original Stored Chrome Spec",
    "```json",
    JSON.stringify(input.oldSpec, null, 2),
    "```",
    "",
    "## Target Chrome Authoring Transcript",
    input.targetTranscript,
    "",
    "## Required Output",
    "Return only the migrated JSON object. Before returning, run the target transcript's mandatory self-validation checklist.",
  ].join("\n");
}
