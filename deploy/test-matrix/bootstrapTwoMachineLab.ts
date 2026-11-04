#!/usr/bin/env bun
import { bootstrapSshAndLabAccess, discoverLabHosts } from "./hosts";
import { writeTopologyConfigs } from "./generateTopologyConfigs";

const main = (): void => {
  const lab = bootstrapSshAndLabAccess();
  const paths = writeTopologyConfigs(lab);
  console.log(`lab ready: HOST_A=${lab.hostALanIp} HOST_B=${lab.hostBLanIp}`);
  console.log(`topology configs: ${paths.length} written`);
};

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export { discoverLabHosts };
