import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioResult } from "./harness";

export interface RunMeta {
  runId: string;
  startedAt: string;
  finishedAt: string;
  commit: string;
  host: string;
  intensity: number;
  budgetFactor: number;
  seed: number;
  destructive: boolean;
}

export const renderReport = (meta: RunMeta, results: ScenarioResult[]): string => {
  const failed = results.filter((result) => result.status === "fail");
  const lines: string[] = [
    `# Deploy stress report ${meta.runId}`,
    "",
    `- commit: \`${meta.commit}\`  host: \`${meta.host}\``,
    `- started ${meta.startedAt}, finished ${meta.finishedAt}`,
    `- intensity x${meta.intensity}, budget factor x${meta.budgetFactor}, seed ${meta.seed}, destructive scenarios ${meta.destructive ? "ENABLED" : "off"}`,
    `- **${results.filter((r) => r.status === "pass").length} passed, ${failed.length} failed, ${results.filter((r) => r.status === "skipped").length} skipped**`,
    "",
    "| scenario | result | time | checks |",
    "| :--- | :--- | ---: | ---: |",
    ...results.map((r) => `| ${r.id} | ${r.status.toUpperCase()} | ${(r.ms / 1000).toFixed(1)}s | ${r.checks.filter((c) => c.ok).length}/${r.checks.length} |`),
    "",
  ];
  for (const result of results) {
    lines.push(`## ${result.id} — ${result.status.toUpperCase()}`, "", result.title, "");
    if (result.skipReason) lines.push(`Skipped: ${result.skipReason}`, "");
    if (result.error) lines.push("```", result.error.slice(0, 3000), "```", "");
    if (result.measures.length > 0) {
      lines.push("| measurement | value |", "| :--- | ---: |", ...result.measures.map((m) => `| ${m.name} | ${m.value} ${m.unit} |`), "");
    }
    const bad = result.checks.filter((c) => !c.ok);
    if (bad.length > 0) lines.push("Failed checks:", "", ...bad.map((c) => `- ${c.name}${c.detail ? ` — ${c.detail}` : ""}`), "");
    if (result.notes.length > 0) lines.push("Notes:", "", ...result.notes.map((note) => `- ${note}`), "");
  }
  return `${lines.join("\n")}\n`;
};

export const writeReport = (dir: string, meta: RunMeta, results: ScenarioResult[]): { markdown: string; json: string } => {
  mkdirSync(dir, { recursive: true });
  const markdown = join(dir, "report.md");
  const json = join(dir, "report.json");
  writeFileSync(markdown, renderReport(meta, results));
  writeFileSync(json, `${JSON.stringify({ meta, results }, null, 2)}\n`);
  return { markdown, json };
};
