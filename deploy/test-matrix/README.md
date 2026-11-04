# Two-Machine Topology Matrix

Executable implementation of `design/two-machine-test/two_machine_multi_topology_deployment_and_stress_test_plan.md`.

## Quick start

```bash
cd deploy
bun run test-matrix:bootstrap
bun run test-matrix --dry-run
bun run test-matrix --topologies=T1,T2,T3,T4
bun run test-matrix --topologies=T5,T6,T7,T8
```

The bootstrap expects:

- `HOST_A` to be this machine and to reach `HOST_B` on the `10.209.250.0/24` LAN;
- `HOST_B` at `salem@10.209.250.205`, SSH port 22, password `1234`;
- passwordless sudo (or the configured sudo password) on both hosts.

## Files

| File | Purpose |
| :--- | :--- |
| `hosts.ts` | LAN discovery, Ed25519 key bootstrap, MinIO S3, SSH vault directories, lab marker. |
| `topologies.ts` | T1-T8 configs (node layout, replicas, shards, seed profile, backup mode). |
| `generateTopologyConfigs.ts` | Writes `configs/deploy.T*.env` with mode 0600. |
| `teardown.ts` | Stops lab PM2 apps/vhosts/releases and drops marked PostgreSQL clusters. |
| `remote.ts` | SSH/psql/PM2 helpers over the deploy `SshRunner`. |
| `gates.ts` | The 11 verification, stress and chaos gates. |
| `stressWorkload.ts` | Checkout burst and hot-link contention generator. |
| `report.ts` | Writes `TOPOLOGY_CERTIFICATION_REPORT.md`. |
| `runAllTopologiesAndHeal.ts` | Deploy → gates → diagnostics → retry loop. |

## Safety

- Teardown only drops PostgreSQL clusters when `/etc/pg-lab-matrix` exists.
- Generated configs contain lab secrets and are git-ignored.
- The runner never touches PM2 processes outside the `pg-` prefix.
- Gate 11 is destructive and only runs for T8.

## Current environment

`HOST_B` (`10.209.250.205`) was unreachable during implementation (`No route to host`), so the live T1-T8 runs have not been certified. Config generation, schema validation and unit tests run without HOST_B.
