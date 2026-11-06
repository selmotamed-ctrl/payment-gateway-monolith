---
id: deploy.firewall
title: Firewall Policy and Application
status: partial
confidence: high
last_verified: 2026-11-05
verified_against: 5a24f6f+working-tree
code:
  - deploy/lib/firewallConfigurator.ts
  - deploy/lib/hostPlanner.ts
  - deploy/lib/osDetector.ts
  - deploy/lib/sshRunner.ts
  - deploy/deploy.ts
design_sources:
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md#5-host-aware-ufw-firewall--network-isolation-provisioning
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md#6-ordered-14-step-multi-host-deployment-pipeline
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#23-reverse-proxy-nginx--caddy-topology
tests:
  - deploy/test/hostPlanner.test.ts
  - deploy/test/hostPlannerScale.test.ts
  - deploy/test/exhaustive-deploy-matrix.test.ts
  - deploy/test/fakeRails.test.ts
  - deploy/test/security-regressions.test.ts
gaps:
  - Firewall application is not verified after the fact; the deploy only reads `ufw status verbose` for the log.
  - If `ufw` cannot be installed, the deploy warns and continues without a firewall.
  - PgBouncer's isolated role plan has no SSH rule, although the current plan only emits it on a PostgreSQL host that already contributes one.
  - The Fake Rails allowlist includes the legacy CHECKOUT_PRIVATE_IP but not every CHECKOUT_NODES private IP.
  - All rules are TCP only; no explicit UDP policy is generated.
---

# Firewall Policy and Application

## 1. Purpose and scope

This part owns the host-aware UFW policy: the abstract rules derived by the planner, the merge behavior for co-located roles, the exact `ufw` commands, installation and application order.

It does not own the host plan, the service bind addresses or the Nginx `allow`/`deny` rules, although the two layers share `LAN_ALLOWED_CIDRS` and the same private IPs.

## 2. Design intent (extracted and synthesized from ./design)

Every host gets a default-deny inbound policy. Only role-specific ports are opened, and private services are restricted to the private IPs that need them:

- database only from core (and replicas/backup);
- core only from the three edge tiers;
- admin only from the LAN;
- merchant/checkout public ports open, backends loopback-only;
- storage services only from core, backup and peer storage nodes;
- backup daemon only from core and, for WAL ingest (`PUT /v1/wal`), the PostgreSQL primary and dedicated audit hosts.

If several roles share a host, the rules are the union of the role rules. The SSH rule is always emitted first and `ufw --force enable` is last, so a failed rule cannot lock the operator out.

## 3. As-built architecture

### 3.1 Base policy

`baseUfwCommands()` emits, in order:

```text
ufw default deny incoming
ufw default allow outgoing
ufw default deny routed
```

Every rule is `tcp`. No UDP rule is generated. The base policy is applied before role rules.

### 3.2 Rule model

`FirewallRulePlan` has:

- `port`;
- `proto: "tcp"`;
- optional `fromCidrs`;
- a human-readable comment.

`ufwCommandsForRule()`:

- if `fromCidrs` is absent or empty: `ufw allow <port>/tcp comment <comment>`;
- otherwise one command per CIDR: `ufw allow from <cidr> to any port <port> proto tcp comment <comment>`.

CIDRs are not coalesced or deduplicated at command generation; the planner's union deduplicates source lists.

### 3.3 Role matrix

`buildComputeFirewall()`:

| Role | Opened ports | Sources |
| :--- | :--- | :--- |
| `db` (legacy) | SSH, `DB_PORT` | DB port only from every core private IP. |
| `core` | SSH, core service port | Core port only from every admin/merchant/checkout private IP (node arrays or legacy). |
| `admin` | SSH, `ADMIN_NGINX_LAN_PORT` | Admin vhost only from `LAN_ALLOWED_CIDRS`. Backend `ADMIN_BACK_PORT` is not opened; it binds loopback. |
| `merchant` | SSH, `MERCHANT_HTTP_PORT`, `MERCHANT_HTTPS_PORT` when SSL, `MERCHANT_LAN_PORT` when > 0 | HTTP/HTTPS unrestricted; LAN port from `LAN_ALLOWED_CIDRS`. Backend port is not opened. |
| `checkout` | SSH, `CHECKOUT_HTTP_PORT`, `CHECKOUT_HTTPS_PORT` when SSL, `CHECKOUT_LAN_PORT` when > 0 | HTTP/HTTPS unrestricted; LAN port from `LAN_ALLOWED_CIDRS`. Backend port is not opened. |
| `fake-rails` | SSH, `FAKE_RAILS_NGINX_PORT` | From `FAKE_RAILS_ALLOWED_CIDRS`, every core private IP, and the legacy `CHECKOUT_PRIVATE_IP` when set. |

`buildStorageFirewall()`:

| Role | Opened ports | Sources |
| :--- | :--- | :--- |
| `pg-primary` | SSH, PostgreSQL port, PgBouncer port when enabled | PostgreSQL from replicas + backup + core (core omitted when PgBouncer is enabled); PgBouncer from core. |
| `pg-replica` | SSH, PostgreSQL port, PgBouncer port when enabled | PostgreSQL from the other PostgreSQL nodes + backup + core (core omitted when PgBouncer is enabled); PgBouncer from core. |
| `pgbouncer` | PgBouncer port | Core only. |
| `redis` | SSH, Redis port | Core + backup. |
| `audit-db` | SSH, PostgreSQL port | Core + backup. |
| `log-db` | SSH, PostgreSQL port | Core + backup. |
| `backup` | SSH, `BACKUP_DAEMON_PORT` | Core only. |

The `core` rule does not include Fake Rails or backup IPs: the core initiates backup calls and Fake Rails calls outbound, so neither needs inbound access to core.

The Fake Rails rule uses `allCorePrivateIps(config)` but only `CHECKOUT_PRIVATE_IP`, not the checkout node-array IPs. On a multi-node checkout tier, additional checkout nodes may not be able to reach Fake Rails unless they are also in `FAKE_RAILS_ALLOWED_CIDRS`.

### 3.4 Co-located hosts and union

`HostPlan.firewall` starts as the first target's rules and is merged with each additional role's rules by `mergeFirewall()`:

- same port/proto: union the CIDR lists;
- if either rule is unrestricted, remove the source restriction so the broader access wins;
- concatenate comments with `; `.

Examples:

- core + admin on one host: core port restricted to all edge IPs, admin LAN port restricted to the LAN, both SSH rules collapse to one port;
- merchant + checkout on one host: public HTTP/HTTPS likely produce one unrestricted rule per port after merging; both LAN ports are separate;
- PostgreSQL primary + audit + log on one host: all three may share port 5432 because they are in the same PostgreSQL family (this is checked by config validation, not by the merge).

The union can widen access. A role that opens a port publicly (merchant/checkout HTTP/HTTPS) makes that port public for the entire host, including any co-located role. Port collisions are rejected before planning when they cross families.

### 3.5 Application

`applyFirewall()`:

1. Builds the complete command list.
2. Requires an SSH rule whose port equals `host.ssh.port`; otherwise it refuses to enable UFW.
3. In dry-run, logs every `ufw` command through the runner and returns.
4. Checks whether `ufw` exists.
5. If absent, detects the OS (`deploy/lib/osDetector.ts`) and installs `ufw` with `apt-get` or `pacman`.
6. Re-checks; if still absent, logs a warning and skips firewall application.
7. Runs every command with sudo in order, with `ufw --force enable` last.
8. `deploy.ts` reads back `ufw status verbose` and prints the first 12 lines.

The installer supports Debian/Ubuntu-family and Arch-family hosts. Unknown OSes get no automatic install.

### 3.6 When rules are applied

`deploy.ts` applies the firewall only when:

- `--fresh` or `DEPLOY_MODE=fresh`, or
- `--enforce-firewall`.

`--update` alone skips bootstrap and firewall changes. `--dry-run` prints commands without executing them.

## 4. Contracts and invariants

- Default inbound is deny.
- The SSH port is always allowed before UFW is enabled; enabling without an SSH rule is refused.
- Only TCP rules are generated.
- Private services are source-restricted by private IPs or LAN CIDRs.
- Backend ports (`4101`, `4102`, `4103`, core `4000`) are not publicly opened.
- An unrestricted rule wins over a restricted rule for the same port on a co-located host.
- `LAN_ALLOWED_CIDRS` is shared by admin UFW rules, LAN vhost UFW rules and Nginx allow rules.
- The firewall is the outer network ring; mTLS and core authorization are independent inner controls.
- `--update` is not a firewall reconciliation mode; use `--enforce-firewall`.

## 5. Data / API / config / deployment surface

### Inputs

| Key | Meaning |
| :--- | :--- |
| `LAN_ALLOWED_CIDRS` | Admin and LAN vhost sources. |
| `FAKE_RAILS_ALLOWED_CIDRS` | Additional Fake Rails sources. |
| `CORE_NODES` / `CORE_PRIVATE_IP` | Core sources and core host identity. |
| `ADMIN_NODES` / `MERCHANT_NODES` / `CHECKOUT_NODES` and legacy private IPs | Edge sources for core. |
| `PG_PRIMARY_NODE`, `PG_REPLICA_NODES`, `PGBOUNCER_ENABLED`, `BACKUP_NODE` | Storage rule sources. |
| `REDIS_NODES`, `AUDIT_DB_NODE`, `LOG_DB_NODE` | Storage rule sources. |
| `BACKUP_DAEMON_PORT` | Backup control-plane port. |
| `FAKE_RAILS_NGINX_PORT` | Fake Rails ingress port. |
| `*_HTTP_PORT`, `*_HTTPS_PORT`, `*_LAN_PORT`, `ADMIN_NGINX_LAN_PORT` | Public and LAN listeners. |

### Generated artifacts

- `HostPlan.firewall`: abstract rules used by the deployment audit and the renderer.
- UFW commands in `deploy/lib/firewallConfigurator.ts`.
- `ufw status verbose` readback in the deployment log.

## 6. Operational usage

```bash
# Re-apply the plan after changing private IPs or ports
./deploy/deploy.sh --update --enforce-firewall

# Preview without executing
./deploy/deploy.sh --dry-run

# Inspect a host
ssh <host> 'sudo ufw status verbose'
```

If a host becomes unreachable after a firewall change, use the provider console. The SSH rule should prevent lockout, but a wrong `*_SSH_PORT`, an external security group, or a missing route can still block access.

## 7. Status and deviations

### Implemented

- Default-deny inbound, allow outgoing, deny routed.
- Role-specific source restrictions for compute and storage.
- Co-located union with unrestricted-rule precedence.
- SSH-rule prerequisite before enabling UFW.
- OS-aware UFW installation.
- Enable-last ordering.
- Dry-run command logging.
- Post-apply status readback.

### Partial

- Application is best-effort: no firewall is installed if the package manager is unknown or installation fails.
- Rules are not reconciled or diffed against a previously applied set; a stale rule from an older plan remains.
- The readback is printed, not parsed as a gate.

### Missing / deferred

- UDP policy.
- IPv6-specific rules.
- Automatic removal of obsolete rules.
- A per-host firewall diff or rollback.
- An explicit Fake Rails allowlist union for every checkout node.

### Known bugs / risks

- A broad rule from one co-located role widens the same port for every role on that host.
- Fake Rails may reject checkout traffic from additional `CHECKOUT_NODES` private IPs because only the legacy `CHECKOUT_PRIVATE_IP` is unioned.
- The isolated `pgbouncer` rule set contains no SSH rule. In the current plan PgBouncer is emitted on a PostgreSQL host, which supplies SSH; a future standalone PgBouncer plan would be refused by `applyFirewall()`.
- The firewall does not protect against a compromised host on an allowed source CIDR; mTLS and core authorization are still required.
- `--update` does not enforce the current policy, which can leave an old, wider rule in place.

## 8. Verification and tests

```bash
cd deploy && bun run typecheck && bun test test/hostPlanner.test.ts test/hostPlannerScale.test.ts test/exhaustive-deploy-matrix.test.ts test/fakeRails.test.ts
```

Covered:

- single-host union includes core, admin and public ports;
- database port sources are restricted to core;
- core port sources are the three edge private IPs;
- merchant public HTTP/HTTPS plus LAN port rules;
- LAN listeners can be HTTP;
- Fake Rails sources and ports;
- exhaustive matrix rule generation.

Not covered:

- a real `ufw` apply on a remote host;
- rule persistence across reboot;
- removal of stale rules;
- provider-level firewall interaction.

## 9. Source references

### Old design sections

- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 5, firewall matrix.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 6, step 4.
- `design/01-platform-architecture/payment_gateway_final_design-v5.md` section 2.3, reverse proxy exposure.

### Code paths

- `deploy/lib/firewallConfigurator.ts`: command building and apply.
- `deploy/lib/hostPlanner.ts`: role rules and union.
- `deploy/lib/osDetector.ts`: package-manager detection.
- `deploy/lib/sshRunner.ts`: sudo command execution.
- `deploy/deploy.ts`: when the firewall runs and the status readback.

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`

## 10. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.

## Security hardening (2026-11-05)

The Fake Rails nginx vhost now also applies `allow`/`deny` rules from `FAKE_RAILS_ALLOWED_CIDRS` (the application-level check compares `socket.remoteAddress`, not `X-Forwarded-For`). All six nginx templates set `server_tokens off` and `limit_req` with `limit_req_status 429`. UFW rules are unchanged.
