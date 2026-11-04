---
id: deploy.planner
title: Host Planner
status: implemented
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - deploy/test-matrix/gates.ts
  - deploy/lib/hostPlanner.ts
  - deploy/lib/configSchema.ts
  - deploy/deploy.ts
  - deploy/lib/firewallConfigurator.ts
design_sources:
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md#1-flexible-1n-compute--storage-topology-model-same-server-vs-fully-distributed
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md#2-complete-deploy-directory-structure
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#6-segment-5--horizontal-node-scaling--multi-host-storage-orchestration-in-deploydeployenv--deploydeployts
tests:
  - deploy/test/testMatrix.test.ts
  - deploy/test/hostPlanner.test.ts
  - deploy/test/hostPlannerScale.test.ts
  - deploy/test/configScale.test.ts
  - deploy/test/exhaustive-deploy-matrix.test.ts
  - deploy/test/rollingDeploy.test.ts
gaps:
  - Remote Nginx upstreams assume every edge backend binds its private IP and the LAN firewall allows the backend port.
  - Storage nodes are listed in the rendered topology even when their management flag is disabled, so the map can imply a managed role that the run will not touch.
  - The planner trusts config validation for port collisions; calling it directly with an invalid config can still produce a plan.
  - PgBouncer roles are cloned from PostgreSQL nodes and can appear as duplicate storage entries with the same node id/private IP.
  - Per-node SSH credentials are not supported; the tier's legacy user/key/sudo fields are shared by every node.
---

# Host Planner

## 1. Purpose and scope

The host planner converts a validated `DeployConfig` into a `DeployPlan`:

- unique hosts keyed by `sshHost:sshPort`;
- per-host roles, services, Nginx sites, certificate bundles, firewall rules and deploy order;
- per-tier node plans for core, admin, merchant and checkout;
- the PostgreSQL/Redis/audit/log/backup storage plan;
- the backup plan and topology label.

It owns grouping and unioning only. It does not validate the raw environment (that is `deploy.topology`), generate certificates (`deploy.pki`), apply firewall rules (`deploy.firewall`) or execute the pipeline (`deploy.pipeline`).

## 2. Design intent (extracted and synthesized from ./design)

The design requires "smart host deduplication": if two roles share an SSH endpoint, they are one machine. The planner must bootstrap that machine once, merge PM2 services, Nginx vhosts, certificate material and UFW rules, and still keep each horizontal node as its own service identity.

Storage roles are independently scalable. A PostgreSQL primary, replicas, PgBouncer, Redis, audit DB, log DB and backup daemon may be dedicated or co-located. The plan must preserve the intended network policy: the database only accepts core/replica/backup sources, the core only accepts edge sources, and edge backends bind their private IP with a LAN-scoped firewall rule so local or remote Nginx upstreams can reach them.

The rendered topology is intended to be the operator's first confirmation that deduplication and node arrays mean what they intended.

## 3. As-built architecture

### 3.1 Target collection

`planHosts()` starts from `findSshConflicts()`. Any endpoint shared by roles with different SSH keys or users aborts planning.

`allTargets()` builds a `RoleTarget` for:

1. every compute node from `buildComputeNodes()`, with its service, Nginx sites and firewall rules;
2. legacy database role (only when `DB_MANAGE_VIA_SSH` and the legacy DB path is active);
3. Fake Rails (only when enabled and configured);
4. managed storage nodes from `storageTargets()`.

A compute node is built from the node array when present, otherwise from the legacy single-host fields. A single-node tier keeps the base service name (`pg-core-back`, `pg-admin-back`, `pg-merchant-back`, `pg-checkout-back`, `pg-fake-rails-back`). A multi-node tier appends `-<slug(nodeId)>` to every node, including the first, so two instances can never share a PM2 name. A node's `servicePort` becomes the service port.

### 3.2 SSH endpoint grouping

The grouping key is `sshHost:sshPort` only. Hostnames, private IPs and role names do not participate. For every target:

- a new host gets the target's service, Nginx sites, certs, firewall and `deployOrder`;
- an existing host appends missing roles, unions certs, merges firewall rules, appends services by unique name, appends Nginx sites by unique site name, and takes the minimum role order.

`ROLE_ORDER` places storage and legacy database first (1), core second (2), Fake Rails third (3), admin fourth (4), merchant fifth (5), checkout sixth (6). Hosts are sorted by `deployOrder` and then by key. This is the order used by `renderTopology` and by compute deployment through the explicit pipeline steps, not a generic host loop.

### 3.3 Service plans

`buildService()` combines the tier's `sourceDir` and `remoteDir` with the node's port and environment:

- core receives `coreEnv()`: database URL, mTLS server material, KMS key, Redis URL, storage environment, `STORAGE_SHARD_COUNT`, Fake Rails and seed flags;
- edge roles receive `edgeEnv()`: core URL list, own client certificate paths, LAN CIDRs for admin, PG-live prefix for merchant, checkout front URL for checkout;
- Fake Rails receives `fakeRailsEnv()`.

Edge environments are built from a base that deliberately excludes `DATABASE_URL`, `KMS_MASTER_KEY` and storage credentials. `NODE_ENV` is forced to `production`. Multi-node services also carry `envFileName`, `releaseSuffix` and `currentLink` so the pipeline can isolate them on disk.

### 3.4 Nginx plans

`buildNginx()` always produces:

- `admin-lan` on `ADMIN_NGINX_LAN_PORT`, SSL by default, server name `ADMIN_DOMAIN`, static root from the admin release;
- `merchant-public` on HTTP/HTTPS ports, with certbot/custom/self-signed mode;
- `checkout-public` on HTTP/HTTPS ports, with certbot/custom/self-signed mode;
- optional `merchant-lan` when `MERCHANT_LAN_PORT > 0`;
- optional `checkout-lan` when `CHECKOUT_LAN_PORT > 0`;
- optional `fake-rails` when enabled.

Nginx plans are filtered per role and attached to the matching compute host(s). The public merchant/checkout vhosts use the configured domains; the LAN vhosts use the node private IP or `_`. The admin vhost is not attached to a non-admin host. Every site carries an `upstreamName` and all local/remote node addresses; the renderer emits a `least_conn` upstream with `max_fails=2 fail_timeout=3s`.

### 3.5 Certificate bundles

`buildCertBundles(role, config)` determines the display bundle for a host role:

- core: `core-server`, plus all four storage client bundle names when any storage feature is enabled;
- admin/merchant/checkout: their own client bundle;
- Fake Rails: `fake-rails-server`;
- backup: `backup-server` and `pg-client`;
- PostgreSQL roles: `pg-client`;
- Redis: `redis-client`;
- audit: `audit-db-client`;
- log: `log-db-client`.

Display bundles are not the same as actual distribution. `certFilesForHost()` in `deploy/lib/pkiManager.ts` filters the generated storage clients by what actually exists and adds `backup-client` for the backup role. The cert bundle display can therefore list a storage client name that was not generated when that storage feature is disabled; the actual upload loop is driven by `certFilesForHost`.

A host that runs several roles receives the union of their bundles. A co-located edge host receives the client certificates for every edge role on that host, in each service's `shared/certs` directory, because `deployService()` calls `certFilesForHost(pki, host.roles)`.

### 3.6 Firewall plans

`buildComputeFirewall()` and `buildStorageFirewall()` produce abstract `FirewallRulePlan` entries (`port`, `proto: "tcp"`, optional source CIDRs, comment). They do not execute `ufw`. The host planner unions them; `deploy/lib/firewallConfigurator.ts` converts them to commands.

The union (`mergeFirewall()`):

- adds a new rule when the port/proto pair is absent;
- if either existing or new rule is unrestricted, deletes `fromCidrs` so the broader rule wins;
- otherwise unions CIDR lists and concatenates comments.

See `deploy.firewall` for the role matrix and command semantics.

### 3.7 Storage plan

`buildStoragePlan()` parses:

- exactly one `PG_PRIMARY_NODE`;
- zero or more `PG_REPLICA_NODES`;
- PgBouncer clones on the primary and every replica when `PGBOUNCER_ENABLED`;
- every `REDIS_NODES` entry;
- one audit node, one log node and one backup node.

It returns both a nested `postgres` view and flat role keys. `storage.nodes` is the concatenation of primary, replicas, PgBouncer clones, Redis, audit, log and backup. PgBouncer clones reuse the underlying node id and private IP with `role: "pgbouncer"`; they are not distinct machines.

`storageTargets()` only creates host targets for enabled management flags:

- PostgreSQL primary/replicas/PgBouncer: `PG_MANAGE_VIA_SSH`;
- Redis: `REDIS_MANAGE_VIA_SSH`;
- audit/log: their `*_MANAGE_VIA_SSH`;
- backup: `BACKUP_ENABLED`.

A configured but unmanaged storage node still appears in `plan.storage` and in the rendered map, but is not bootstrapped, firewalled or provisioned by this run.

### 3.8 Port collisions and validation boundary

The planner relies on `validateDeployConfig()` for collision checks. It does not re-check them. The validation rules relevant to the plan are:

- compute roles on the same SSH endpoint may not claim the same service port;
- a storage listener may not collide with a compute listener on the same endpoint;
- storage roles on the same endpoint may share a port only inside the PostgreSQL family (`pg-primary`, `pg-replica`, `audit-db`, `log-db`); PgBouncer, Redis and backup are separate families;
- PostgreSQL primary/replica private IPs are unique;
- node ids are unique across all lists;
- merchant/checkout/admin LAN and public ports are distinct;
- the two public domains differ;
- core and edge backend ports differ.

If `planHosts()` is called with a hand-built `DeployConfig` that bypassed validation, it can emit a plan with collisions; the pipeline normally calls `loadDeployConfig()` first.

### 3.9 Topology rendering

`renderTopology(plan)` prints:

```text
Topology: <single-host|split|distributed> (N host(s))

  user@sshHost:sshPort  [role, role]
    - pm2 <service> :<port>  (<sourceDir> -> <remoteDir>)
    - nginx <site> :<port>  <serverName>
    - certs <bundle,...>
    - ufw <port><=<cidr|cidr> ...
  storage <role>: <nodeId>@<privateIp>:<port>
```

It is printed in step 1 before any remote command. In `--dry-run` it is the fastest way to verify grouping and node arrays.

### 3.10 Role assignment map

`plan.roles` maps each compute role to the first host that carries it. It is informational; deployment iterates `plan.nodes` and `HostPlan.services`, not `roles`. Storage roles are not included in `roles`.

## 4. Contracts and invariants

- A host key is `sshHost:sshPort`; roles sharing it are one machine and must share SSH user/key/sudo.
- Every compute node gets a distinct service name; duplicate node ids are rejected before planning.
- A host's firewall is the union of its roles' rules; an unrestricted rule widens the result.
- Nginx sites are unique by site name per host.
- Certificates are the union of role bundles for display and the least-privilege set from `certFilesForHost()` for upload.
- Storage plan structure is stable even when management is disabled.
- `plan.topology` depends on unique host count only.
- Edge service env never contains database or KMS material.
- The planner does not mutate the config and does not touch the network.

## 5. Data / API / config / deployment surface

### Types

- `SshTarget`: host, port, user, key path, sudo password.
- `ServicePlan`: name, role, source/remote dir, port, env, optional node id/private IP.
- `NginxPlan`: site, role, template, listen/http/https ports, SSL flag/mode, server name, cert/key paths, static root.
- `FirewallRulePlan`: port, TCP, optional source CIDRs, comment.
- `NodePlan`: node id, role, SSH target, host, private IP, service port, service name, host key.
- `StorageNodePlan`: storage role, node id, SSH fields, private IP, service port.
- `HostPlan`: key, display name, SSH target, roles, services, Nginx sites, certs, firewall, keep releases, deploy order.
- `DeployPlan`: topology, hosts, role map, database view, compute node arrays, storage plan, replicas, backup plan.

### Inputs

All keys are from `deploy.env` (see `deploy.topology`). The planner reads the validated `DeployConfig` only.

## 6. Operational usage

```bash
./deploy/deploy.sh --dry-run
```

Inspect the printed map:

- each SSH endpoint appears once;
- each expected PM2 service appears with the intended port;
- Nginx sites appear on the intended host;
- the cert list matches the role;
- the UFW line shows the intended sources;
- storage lines show the intended roles and private IPs.

Use `--only` and `--nodes` to limit a later real run, but note that the plan is still built for the whole configuration.

## 7. Status and deviations

### Implemented

- SSH endpoint grouping and role union.
- Per-node service names and ports.
- Nginx, certificate and firewall unioning.
- Storage plan for primary/replicas/PgBouncer/Redis/audit/log/backup.
- Topology classification and human-readable rendering.
- Legacy database and Fake Rails targets.
- SSH credential conflict detection.

### Partial

- Storage nodes are displayed even when not managed.
- Certificate display bundles can name storage certs that were not generated.
- The plan has no stable JSON schema or machine-readable output.

### Missing / deferred

- Per-node SSH credentials.
- Independent storage node arrays for multiple audit/log/backup nodes (one each).
- Automatic detection of a port collision at plan time if validation was bypassed.
- A plan diff against the previous run.

### Known bugs / risks

- PgBouncer clones duplicate storage node ids/IPs in `storage.nodes`; consumers that assume uniqueness by node id can be confused.
- A host with several roles gets the union of their client certificates; the service-level least privilege is host-level, not process-level.
- `renderTopology` does not mark unmanaged storage as unmanaged.
- If a role is configured but its management flag is off, the host may not exist in `plan.hosts` while its storage entry appears in the map.

## 8. Verification and tests

```bash
cd deploy && bun run typecheck && bun test test/hostPlanner.test.ts test/hostPlannerScale.test.ts test/configScale.test.ts test/exhaustive-deploy-matrix.test.ts
```

The suites cover five-host, two-host and single-host scenarios; firewall source sets; edge env isolation; multi-IP core SAN planning; node arrays; Fake Rails; and topology rendering. They do not require remote hosts.

## 9. Source references

### Old design sections

- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` sections 1-2.
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` section 6.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 5, firewall union intent.

### Code paths

- `deploy/lib/hostPlanner.ts`: all planning, grouping and rendering.
- `deploy/lib/configSchema.ts`: input schema and validation.
- `deploy/deploy.ts`: plan consumption and deployment units.
- `deploy/lib/firewallConfigurator.ts`: rule-to-command conversion.
- `deploy/lib/pkiManager.ts`: actual least-privilege certificate distribution.

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`

## 10. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.

## 11. Multi-instance isolation (2026-11-03)

- A multi-node tier names every PM2 process with the node id (`pg-core-back-core-1`, `pg-core-back-core-2`); a single-node tier keeps the historical unsuffixed name.
- Every service carries `envFileName`, `releaseSuffix` and `currentLink`. The pipeline writes `shared/.env.<nodeId>`, `releases/<nodeId>/<timestamp>` and `current-<nodeId>`.
- `NginxPlan` carries `upstreamName` and `upstreamServers`. The renderer emits `upstream` blocks with `least_conn` and `max_fails=2 fail_timeout=3s` over all local and remote nodes.
- Edge backends bind the node private IP instead of loopback. The planner adds a LAN-scoped firewall rule for each edge backend port so a remote Nginx upstream can reach it.
- Replica read URLs use the replica's own PostgreSQL port, not a single PgBouncer port that would point a co-located replica back at the primary.
