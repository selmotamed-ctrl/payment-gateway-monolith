import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GateResult, TopologyRunResult } from "./types";

const statusCell = (gates: GateResult[]): string => {
  if (gates.length === 0) return "not run";
  return gates.every((gate) => gate.status === "PASSED") ? "PASSED" : "FAILED";
};

export const renderCertificationReport = (results: TopologyRunResult[]): string => {
  const lines = [
    "# Two-Machine Multi-Topology Certification Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "| Topology | Name | Deploy | Gates | Gate status |",
    "| :--- | :--- | :--- | :--- | :--- |",
  ];
  for (const result of results) {
    lines.push(`| ${result.topology} | ${result.name} | ${result.deploy.ok ? "PASSED" : "FAILED"} (${result.deploy.durationMs}ms) | ${result.gates.length}/11 | ${statusCell(result.gates)} |`);
  }
  lines.push("", "## Gate detail", "");
  for (const result of results) {
    lines.push(`### ${result.topology} — ${result.name}`, "");
    lines.push(`Started: ${result.startedAt} · Finished: ${result.finishedAt}`, "");
    for (const gate of result.gates) {
      lines.push(`- **Gate ${gate.gate} ${gate.name}** — ${gate.status} (${gate.durationMs}ms)`);
      for (const entry of gate.checks) {
        lines.push(`  - ${entry.ok ? "PASS" : "FAIL"} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
      }
      if (gate.error) lines.push(`  - error: ${gate.error}`);
    }
    lines.push("");
  }
  lines.push("## Ledger invariant", "");
  lines.push("Every completed topology gate verifies double-entry drift and `gl_account_shards == journal_lines`. A non-zero drift is a hard failure.");
  return `${lines.join("\n")}\n`;
};

export const writeCertificationReport = (results: TopologyRunResult[]): string => {
  const path = join(import.meta.dirname, "TOPOLOGY_CERTIFICATION_REPORT.md");
  writeFileSync(path, renderCertificationReport(results));
  return path;
};
