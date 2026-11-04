# Multi-Machine Topology Matrix

Executable implementation of `design/05-testing/multi_machine_topology_and_stress_test_plan.md` (which supersedes `design/90-archive/superseded-testing/two_machine_multi_topology_deployment_and_stress_test_plan.md`). Canonical as-built description: `project-design/parts/08-testing/04-multi-machine-matrix.md` (`testing.multi-machine-matrix`).

## Quick start

```bash
cd deploy
cp test-matrix/machines.example.json test-matrix/machines.local.json   # git-ignored
bun run test-matrix:validate                       # schema + derived topologies, no SSH
export LAB_SUDO_PASS                               # only for ssh.sudo.mode = "password"
bun run test-matrix:plan                           # write + validate 0600 deploy configs
bun run test-matrix:bootstrap                      # key SSH + sudo checks, peer keys, MinIO, vault
bun run test-matrix --topologies=mesh,dmz@lab-b --intensity=smoke
bun run test-matrix:teardown                       # marker-gated cleanup of every machine
```

Use another file with `--config=path` or `LAB_MATRIX_CONFIG=path`. The previous two-machine lab is `machines.two-host-lab.example.json`; its topologies also answer to `T1`–`T8`.

## Before the first run

1. Every machine must accept the lab key without a password: `ssh-copy-id -i <keyPath>.pub -p <port> <user>@<address>`. Bootstrap never types passwords for you and never disables host-key checking.
2. Use passwordless sudo (`"sudo": {"mode": "nopasswd"}`) or export the variable named in `ssh.sudo.passwordEnv`.
3. If the controller is not one of the machines, add its IP/CIDR to `lab.lanCidrs` so admin-back accepts the gate requests.
4. Bootstrap writes `lab.markerFile` (default `/etc/pg-lab-matrix`) on every machine. Teardown refuses machines without it.

## Config at a glance

| Key | Meaning |
| :--- | :--- |
| `ssh` | shared user/port/keyPath/sudo (the deploy engine plans SSH per tier, so it is lab-wide) |
| `machines[]` | `id`, IPv4 `address`, optional `privateIp`/`sshPort`, `roles`, `labels`, `capacity.maxNodesPerTier` |
| roles | `controller`, `app`, `edge`, `db`, `cache`, `logs`, `backup`, `object-store`, `vault` |
| `services` | `objectStore` (MinIO) and `vault` (secondary SSH backup target) |
| `topologies` | `families`, `include`/`exclude` (ids or aliases), `maxPerFamily`, `shardCount` |
| `intensity` | `preset` (`smoke`, `standard`, `soak`, `chaos`, `certification`) + `overrides` |

`machines.schema.json` is generated from the Zod schema (`bun run test-matrix:schema`); editors validate the JSON through its `$schema` key.

## Files

| File | Purpose |
| :--- | :--- |
| `labConfig.ts` | Zod schema, literal-secret guard, config hash, sudo env resolution. |
| `intensity.ts` | Presets, overrides, gate ids, chaos fault types. |
| `topologyDerivation.ts` | Families → topologies, port allocation, T1–T8 aliases, selection. |
| `topologies.ts` | Topology → deploy env for the real deploy engine. |
| `labSecrets.ts` | Per-lab generated secrets (0600, git-ignored) and redaction. |
| `generateTopologyConfigs.ts` | Writes `configs/<lab>/deploy.<topology>.env` (0600). |
| `hosts.ts` | Key/sudo verification, peer keys, MinIO, vault, lab marker. |
| `remote.ts` | SSH/psql/PM2 helpers limited to declared machines; async runner. |
| `teardown.ts` | Marker-gated cleanup. |
| `gates.ts` | The 12 measured gates. |
| `stressWorkload.ts` | Hot-link contention, bursts, open-loop sustained load (achieved TPS). |
| `report.ts` | `reports/<runId>/report.{md,json}` with config hash + intensity. |
| `cli.ts` | `validate`, `plan`, `bootstrap`, `run`, `teardown`, `schema`. |
| `TOPOLOGY_CERTIFICATION_REPORT.md` | Historical report of the 2026-11-03 two-machine T1 run. |

## Safety

- No secret in the JSON or repo; literal `password`/`secret`/`token` keys are rejected.
- Generated configs, lab secrets and reports are git-ignored; reports are redacted.
- The runner never touches PM2 processes outside the `pg-` prefix and acts only on declared machines.
- Destructive chaos (`primary-pitr`) requires `chaos.allowDestructive=true` and is not implemented yet (reported SKIP).
