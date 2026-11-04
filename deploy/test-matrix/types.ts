export type TopologyId = "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7" | "T8";

export interface LabHostsConfig {
  hostALanIp: string;
  hostASshUser: string;
  hostASudoPass: string;
  hostBLanIp: string;
  hostBSshUser: string;
  hostBSudoPass: string;
  sshKeyPath: string;
}

export interface TopologyMatrixSpec {
  id: TopologyId;
  name: string;
  description: string;
  glShardCount: 16 | 32;
  seedProfile: "COMPACT" | "STANDARD";
  backupMode: "wal-g" | "barman";
  buildEnv: (lab: LabHostsConfig) => Record<string, string>;
}

export interface GateCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export type GateStatus = "PASSED" | "FAILED" | "SKIPPED";

export interface GateResult {
  gate: number;
  name: string;
  status: GateStatus;
  checks: GateCheck[];
  durationMs: number;
  error?: string;
}

export interface TopologyRunResult {
  topology: TopologyId;
  name: string;
  configPath: string;
  deploy: { ok: boolean; durationMs: number; output: string };
  gates: GateResult[];
  passed: boolean;
  startedAt: string;
  finishedAt: string;
}
