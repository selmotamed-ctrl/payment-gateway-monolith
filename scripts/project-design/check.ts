#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const required = [
  "project-design/INDEX.md",
  "project-design/PROJECT_DESIGN.md",
  "project-design/STATUS.md",
  "project-design/TRACKER.md",
  "project-design/GLOSSARY.md",
  "project-design/DECISIONS.md",
  "project-design/appendices/design-source-map.md",
  "project-design/appendices/stale-claims-register.md",
  "AGENTS.md",
  "opencode.json",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursor/rules/project-design.mdc",
  ".windsurfrules",
  ".github/copilot-instructions.md",
];

let failed = false;
for (const path of required) {
  if (!existsSync(join(ROOT, path))) {
    console.error(`missing required design/instruction file: ${path}`);
    failed = true;
  }
}

const staleFiles = [
  "admin-front/SCALING_FEATURE.md",
  "merchant-front/SCALING_FEATURE.md",
  "checkout-front/SCALING_FEATURE.md",
  "admin-front/notes.md",
  "merchant-front/notes.md",
  "checkout-front/notes.md",
];
for (const path of staleFiles) {
  if (existsSync(join(ROOT, path))) {
    console.error(`stale documentation still present: ${path}`);
    failed = true;
  }
}

const generated = Bun.spawnSync(["bun", "scripts/project-design/build.ts", "--check"], {
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
});
if ((generated.exitCode ?? 1) !== 0) failed = true;

const sourceMap = existsSync(join(ROOT, "project-design/appendices/design-source-map.md"))
  ? readFileSync(join(ROOT, "project-design/appendices/design-source-map.md"), "utf8")
  : "";
const designFiles = [
  "design/payment_gateway_final_design-v5.md",
  "design/payment-gateway-refined-design-v4.1.md",
  "design/Dynamic-Payment-Gateway-Management-Design-v2.md",
  "design/opencode_technical_delivery_design.md",
  "design/payment_gateway_deployment_and_guides_architecture.md",
  "design/performance-efficiency/storage_driver_postgres18_backup_and_scaling_architecture.md",
  "design/performance-efficiency/deep_search_plugin_architecture_plan.md",
  "design/synthetic_operational_data_seeder_architecture.md",
  "design/fake_payment_rails_service_architecture.md",
  "design/complete_zero_to_hero_guides_and_academy_specification.md",
  "design/guide_system_design_and_content (2).md",
  "design/ui/portal_ui_abstraction_and_modern_fintech_redesign.md",
  "design/ui/portal_ui_abstraction_and_modern_fintech_redesign_2.md",
  "design/ui/portal_ui_implementation_plan.md",
  "design/master_exhaustive_test_plan_for_opencode.md",
  "design/Voucher-Provider-Management-System-Technical-Design.md",
  "design/voucher-system-raw-design.md",
  "design/smart_ai_rail_and_voucher_onboarding_plan.md",
  "design/fixes/_0001_operator_cases.md",
  "design/session-ses_e8c2.md",
];
for (const file of designFiles) {
  if (!sourceMap.includes(file)) {
    console.error(`design source not mapped: ${file}`);
    failed = true;
  }
}

if (failed) {
  console.error("project-design check failed");
  process.exit(1);
}
console.log("project-design check passed");
