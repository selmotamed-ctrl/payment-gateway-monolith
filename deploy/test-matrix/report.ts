import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./labSecrets";
import type { GateResult, MatrixRunMeta, TopologyRunResult } from "./types";

export const DEFAULT_REPORTS_DIR = join(import.meta.dirname, "reports");

const tally = (gates: GateResult[]) => ({
  passed: gates.filter((gate) => gate.status === "PASSED").length,
  failed: gates.filter((gate) => gate.status === "FAILED").length,
  skipped: gates.filter((gate) => gate.status === "SKIPPED").length,
  notRun: gates.filter((gate) => gate.status === "NOT_RUN").length,
});

/**
 * Markdown report. Unlike the archived report ("2/11" meant "2 gates ran",
 * not "2 passed"), the gate column shows passed/failed/skipped/not-run
 * explicitly, and the header records the config hash and resolved intensity.
 */
export const renderCertificationReport = (meta: MatrixRunMeta, results: TopologyRunResult[]): string => {
  const lines = [
    `# Multi-Machine Topology Certification Report — ${meta.labName}`,
    "",
    `- Run: \`${meta.runId}\` · started ${meta.startedAt} · finished ${meta.finishedAt}`,
    `- Config: \`${meta.configPath}\` · sha256 \`${meta.configHash}\``,
    `- Intensity: \`${meta.intensity.preset}\`${meta.intensity.overridden.length ? ` + overrides (${meta.intensity.overridden.join(", ")})` : ""} · sha256 \`${meta.intensityHash}\``,
    `- Git commit: \`${meta.gitCommit}\``,
    `- Machines: ${meta.machines.map((machine) => `\`${machine.id}\` ${machine.address} [${machine.roles.join(",")}]`).join("; ")}`,
    "",
    "| Topology | Aliases | Family | Deploy | Attempt | Passed | Failed | Skipped | Not run | Verdict |",
    "| :--- | :--- | :--- | :--- | :--- | ---: | ---: | ---: | ---: | :--- |",
  ];
  for (const result of results) {
    const counts = tally(result.gates);
    lines.push(`| ${result.topology.id} | ${result.topology.aliases.join(",") || "-"} | ${result.topology.family} | ${result.deploy.ok ? "OK" : "FAILED"} (${Math.round(result.deploy.durationMs / 1000)}s) | ${result.attempt}/${result.attemptsAllowed} | ${counts.passed} | ${counts.failed} | ${counts.skipped} | ${counts.notRun} | ${result.passed ? "CERTIFIED" : "NOT CERTIFIED"} |`);
  }
  if (meta.skippedFamilies.length > 0) {
    lines.push("", "## Families that produced no topology", "");
    for (const entry of meta.skippedFamilies) lines.push(`- \`${entry.family}\`: ${entry.reason}`);
  }
  lines.push("", "## Resolved intensity", "", "```json", JSON.stringify(meta.intensity, null, 2), "```", "", "## Gate detail", "");
  for (const result of results) {
    lines.push(`### ${result.topology.id} — ${result.topology.name}`, "");
    lines.push(`Started ${result.startedAt} · finished ${result.finishedAt} · machines ${result.topology.machinesUsed.join(", ")}`, "");
    if (!result.deploy.ok) lines.push("Deploy failed; see the JSON report for the redacted deploy output and diagnostics.", "");
    for (const gate of result.gates) {
      lines.push(`- **Gate ${gate.gate} ${gate.id}** — ${gate.status} (${gate.durationMs}ms) — ${gate.name}`);
      for (const entry of gate.checks) {
        lines.push(`  - ${entry.status} ${entry.name}${entry.detail ? ` — ${entry.detail.replace(/\n/g, " ")}` : ""}`);
      }
      if (gate.error) lines.push(`  - note: ${gate.error}`);
    }
    lines.push("");
  }
  lines.push("## Verdict rule", "");
  lines.push("A topology is CERTIFIED only when it deployed, no gate FAILED or was NOT_RUN, and at least one gate PASSED. SKIPPED gates/checks (not applicable or not implemented) are listed and never count as passes. Every money-writing gate asserts zero double-entry drift and `gl_account_shards == journal_lines`.");
  return `${lines.join("\n")}\n`;
};

export const writeCertificationReport = (
  meta: MatrixRunMeta,
  results: TopologyRunResult[],
  options: { directory?: string; knownSecrets?: string[] } = {},
): { markdown: string; json: string } => {
  const directory = join(options.directory ?? DEFAULT_REPORTS_DIR, meta.runId);
  mkdirSync(directory, { recursive: true });
  const markdown = join(directory, "report.md");
  const json = join(directory, "report.json");
  writeFileSync(markdown, redact(renderCertificationReport(meta, results), options.knownSecrets));
  writeFileSync(json, redact(JSON.stringify({ meta, results }, null, 2), options.knownSecrets));
  return { markdown, json };
};
