import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LabConfig } from "./labConfig";
import type { LabSecrets } from "./labSecrets";
import type { ResolvedIntensity } from "./intensity";
import type { DerivedTopology } from "./topologyDerivation";
import { renderEnvFile, renderTopologyEnv } from "./topologies";

export const DEFAULT_CONFIGS_DIR = join(import.meta.dirname, "configs");

export const configPathFor = (config: LabConfig, topology: DerivedTopology, directory = DEFAULT_CONFIGS_DIR): string =>
  join(directory, config.lab.name, `deploy.${topology.slug}.env`);

/**
 * Writes one deploy.env per selected topology with mode 0600 under the
 * git-ignored `configs/<lab>/` directory. The files contain runtime secrets
 * (generated lab secrets and, if used, the sudo password from the env var)
 * and are never committed.
 */
export const writeTopologyConfigs = (input: {
  config: LabConfig;
  topologies: DerivedTopology[];
  secrets: LabSecrets;
  intensity: ResolvedIntensity;
  sudoPassword: string;
  directory?: string;
}): Map<string, string> => {
  const directory = input.directory ?? DEFAULT_CONFIGS_DIR;
  mkdirSync(join(directory, input.config.lab.name), { recursive: true, mode: 0o700 });
  const paths = new Map<string, string>();
  for (const topology of input.topologies) {
    const path = configPathFor(input.config, topology, directory);
    writeFileSync(path, renderEnvFile(renderTopologyEnv({ ...input, topology })), { mode: 0o600 });
    chmodSync(path, 0o600);
    paths.set(topology.id, path);
  }
  return paths;
};
