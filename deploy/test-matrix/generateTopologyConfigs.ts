import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LabHostsConfig, TopologyId } from "./types";
import { buildAllTopologySpecs } from "./topologies";

const renderEnv = (env: Record<string, string>): string =>
  `${Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n")}\n`;

export const configPathFor = (id: TopologyId, directory = join(import.meta.dirname, "configs")): string =>
  join(directory, `deploy.${id}.env`);

export const writeTopologyConfigs = (lab: LabHostsConfig, directory = join(import.meta.dirname, "configs")): string[] => {
  mkdirSync(directory, { recursive: true });
  const paths: string[] = [];
  for (const spec of buildAllTopologySpecs()) {
    const path = configPathFor(spec.id, directory);
    writeFileSync(path, renderEnv(spec.buildEnv(lab)), { mode: 0o600 });
    paths.push(path);
  }
  return paths;
};

export { buildAllTopologySpecs } from "./topologies";
export type { TopologyMatrixSpec } from "./types";
