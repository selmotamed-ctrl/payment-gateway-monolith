import { dirname, resolve } from "node:path";
import type { DeployConfig, HostRole } from "./configSchema";
import type { DeployPlan, HostPlan, NginxPlan, ServicePlan, SshTarget, StorageNodePlan } from "./hostPlanner";
import { probeAuditDb, probeBackupDaemon, probeEdgeToCore, probeLogDb, probeObjectStorage, probePgBouncer, probePgPrimary, probeRedis, type ProbeResult } from "./healthVerifier";
import { selectedComputeUnits, selectedStorage, shouldRun } from "./selection";
import { pgClusterFor } from "../provisioners/postgres18Provisioner";
import { shellQuote } from "./quoting";
import type { SshRunner } from "./sshRunner";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const GIB = 1024 * 1024;

export type PreflightSeverity = "blocking" | "warning" | "info";
export type PreflightStatus = "pass" | "warn" | "fail" | "skip";
export type PortClassification =
  | "free"
  | "managed-current"
  | "managed-orphan"
  | "managed-service"
  | "unmanaged-same-repo"
  | "foreign";

export interface PreflightOptions {
  only: Set<string>;
  nodes?: Set<string>;
  fresh: boolean;
  deployMode: DeployConfig["DEPLOY_MODE"];
  dryRun: boolean;
  stopUnmanaged: boolean;
}

export interface PortListener {
  port: number;
  address: string;
  pid: number;
  process: string;
}

export interface Pm2App {
  name: string;
  pid: number;
  cwd: string;
  status: string;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  user: string;
  elapsed: string;
  command: string;
}

export interface PortExpectation {
  kind: "pm2" | "nginx" | "service";
  role?: string;
  serviceName?: string;
  baseName?: string;
  plannedNames?: string[];
  packageName?: string;
  remoteDir?: string;
  processNames?: string[];
  unit?: string;
  cmdIncludes?: string;
}

export interface HostTarget {
  key: string;
  label: string;
  ssh: SshTarget;
  roles: HostRole[];
  services: ServicePlan[];
}

export interface PortCheck {
  id: string;
  hostKey: string;
  hostLabel: string;
  host: HostTarget;
  port: number;
  description: string;
  expectation: PortExpectation;
}

export interface DependencyCheck {
  id: string;
  kind: "edge-core" | "core-db" | "core-redis" | "core-audit" | "core-log" | "core-backup" | "core-object";
  label: string;
  severity: PreflightSeverity;
  host?: HostPlan;
  role?: "admin" | "merchant" | "checkout";
}

export interface PreflightPlan {
  hosts: HostTarget[];
  ports: PortCheck[];
  dependencies: DependencyCheck[];
  selection: {
    compute: string[];
    storage: string[];
  };
}

export interface PreflightResult {
  id: string;
  label: string;
  kind: "host" | "port" | "dependency";
  status: PreflightStatus;
  severity: PreflightSeverity;
  detail: string;
  host?: string;
  port?: number;
  classification?: PortClassification;
  pid?: number;
  cwd?: string;
  command?: string;
}

export interface PreflightReport {
  results: PreflightResult[];
  blocking: PreflightResult[];
  warnings: PreflightResult[];
  skipped: PreflightResult[];
}

export interface HostSnapshot {
  reachable: boolean;
  sudo: boolean;
  os: string;
  tools: Record<string, boolean>;
  diskFreeKb: Record<string, number>;
  memoryMb: number | null;
  clockSeconds: number | null;
  pm2Apps: Pm2App[];
  processes: ProcessInfo[];
  ports: PortListener[];
  cwds: Map<number, { cwd: string; packageName: string }>;
  nginxTest: string;
  units: Record<string, number>;
  error?: string;
}

const SERVICE_PACKAGE: Record<string, string> = {
  core: "core-back",
  "fake-rails": "fake-rails-back",
  admin: "admin-back",
  merchant: "merchant-back",
  checkout: "checkout-back",
};

const baseServiceName = (service: ServicePlan): string =>
  service.nodeId && service.name.endsWith(`-${service.nodeId}`)
    ? service.name.slice(0, -(service.nodeId.length + 1))
    : service.name;

const plannedNamesFor = (plan: DeployPlan, role: string): string[] =>
  plan.hosts.flatMap((host) => host.services.filter((service) => service.role === role).map((service) => service.name));

const hostTarget = (host: HostPlan): HostTarget => ({
  key: host.key,
  label: `${host.ssh.user}@${host.ssh.host}:${host.ssh.port}`,
  ssh: host.ssh,
  roles: [...host.roles],
  services: host.services,
});

const addHost = (hosts: Map<string, HostTarget>, host: HostPlan): void => {
  if (!hosts.has(host.key)) hosts.set(host.key, hostTarget(host));
};

const addPort = (
  ports: Map<string, PortCheck>,
  host: HostTarget,
  port: number,
  description: string,
  expectation: PortExpectation,
): void => {
  if (!Number.isFinite(port) || port <= 0) return;
  const id = `${host.key}:${port}`;
  if (!ports.has(id)) {
    ports.set(id, { id, hostKey: host.key, hostLabel: host.label, host, port, description, expectation });
  }
};

const nginxPorts = (site: NginxPlan): number[] => {
  const ports = new Set<number>();
  if (site.listenPort > 0) ports.add(site.listenPort);
  if (!site.ssl && site.httpPort > 0) ports.add(site.httpPort);
  if (site.ssl && site.httpsPort > 0) ports.add(site.httpsPort);
  return [...ports];
};

const pgRole = (role: StorageNodePlan["role"]): "primary" | "replica" | "audit" | "log" => {
  if (role === "pg-primary") return "primary";
  if (role === "pg-replica") return "replica";
  if (role === "audit-db") return "audit";
  return "log";
};

/**
 * Builds the pure preflight plan. The selection uses the same helpers as the
 * deployment steps, so `--only=admin` never checks core's port just because
 * core is a dependency.
 */
export const buildPreflightPlan = (
  config: DeployConfig,
  plan: DeployPlan,
  options: PreflightOptions,
): PreflightPlan => {
  const hosts = new Map<string, HostTarget>();
  const ports = new Map<string, PortCheck>();
  const dependencies: DependencyCheck[] = [];
  const storage = selectedStorage(options);

  const units = selectedComputeUnits(plan, options);
  const selectedRoles = new Set(units.map((unit) => unit.service.role));

  for (const { host, service } of units) {
    addHost(hosts, host);
    const target = hosts.get(host.key)!;
    addPort(ports, target, service.port, `${service.name} backend`, {
      kind: "pm2",
      role: service.role,
      serviceName: service.name,
      baseName: baseServiceName(service),
      plannedNames: plannedNamesFor(plan, service.role),
      packageName: SERVICE_PACKAGE[service.role],
      remoteDir: service.remoteDir,
    });
  }

  for (const { host, service } of units) {
    const target = hosts.get(host.key)!;
    for (const site of host.nginx.filter((entry) => entry.role === service.role)) {
      for (const port of nginxPorts(site)) {
        addPort(ports, target, port, `nginx ${site.site}`, { kind: "nginx" });
      }
    }
  }

  const storageNodes: StorageNodePlan[] = [];
  if (storage.postgres && config.PG_MANAGE_VIA_SSH) {
    const primary = plan.storage.postgres.primary;
    const replicas = plan.storage.postgres.replicas;
    const poolers = plan.storage.postgres.pgbouncer;
    for (const node of [...(primary ? [primary] : []), ...replicas]) {
      storageNodes.push(node);
      addHost(hosts, plan.hosts.find((host) => host.key === node.hostKey)!);
      const cluster = pgClusterFor(config, node.role === "pg-primary" ? "primary" : "replica", node);
      addPort(ports, hosts.get(node.hostKey)!, node.servicePort, `${node.role}`, {
        kind: "service",
        processNames: ["postgres"],
        cmdIncludes: `-D ${cluster.dataDir}`,
      });
    }
    for (const node of poolers) {
      storageNodes.push(node);
      addHost(hosts, plan.hosts.find((host) => host.key === node.hostKey)!);
      addPort(ports, hosts.get(node.hostKey)!, node.servicePort, "pgbouncer", {
        kind: "service",
        processNames: ["pgbouncer"],
        unit: "pgbouncer",
      });
    }
  }
  if (storage.redis && config.REDIS_MANAGE_VIA_SSH) {
    for (const node of plan.storage.redis) {
      storageNodes.push(node);
      addHost(hosts, plan.hosts.find((host) => host.key === node.hostKey)!);
      addPort(ports, hosts.get(node.hostKey)!, node.servicePort, "redis", {
        kind: "service",
        processNames: ["redis-server", "valkey-server", "redis"],
      });
    }
  }
  if (storage.auditLog) {
    for (const node of [plan.storage.auditDb, plan.storage.logDb].filter((entry): entry is StorageNodePlan => Boolean(entry))) {
      storageNodes.push(node);
      addHost(hosts, plan.hosts.find((host) => host.key === node.hostKey)!);
      const cluster = pgClusterFor(config, node.role === "audit-db" ? "audit" : "log", node);
      addPort(ports, hosts.get(node.hostKey)!, node.servicePort, node.role, {
        kind: "service",
        processNames: ["postgres"],
        cmdIncludes: `-D ${cluster.dataDir}`,
      });
    }
  }
  if (storage.backup && config.BACKUP_ENABLED && plan.storage.backup) {
    const node = plan.storage.backup;
    storageNodes.push(node);
    addHost(hosts, plan.hosts.find((host) => host.key === node.hostKey)!);
    addPort(ports, hosts.get(node.hostKey)!, node.servicePort, "backup daemon", {
      kind: "service",
      processNames: ["bun"],
      unit: "pg-backup-daemon",
    });
  }
  if (storage.objectStorage && config.OBJECT_STORAGE_ENABLED && plan.storage.objectStorage) {
    const node = plan.storage.objectStorage;
    storageNodes.push(node);
    addHost(hosts, plan.hosts.find((host) => host.key === node.hostKey)!);
    addPort(ports, hosts.get(node.hostKey)!, node.servicePort, "object storage", {
      kind: "service",
      processNames: ["bun"],
      unit: "pg-object-storage-daemon",
    });
  }

  const coreSelected = shouldRun(options, "core");
  const pgSelected = storage.postgres && config.PG_MANAGE_VIA_SSH;
  for (const role of ["admin", "merchant", "checkout"] as const) {
    if (!selectedRoles.has(role)) continue;
    for (const { host } of units.filter((unit) => unit.service.role === role)) {
      dependencies.push({
        id: `dependency:${role}:${host.key}`,
        kind: "edge-core",
        label: `${role} -> core mTLS`,
        // In a full deploy core is updated before the edges; a pre-flight failure
        // there is informational. When only the edge is selected, core is a hard dependency.
        severity: coreSelected ? "warning" : "blocking",
        host,
        role,
      });
    }
  }
  if (coreSelected && !pgSelected) {
    dependencies.push({
      id: "dependency:core:database",
      kind: "core-db",
      label: "core -> PostgreSQL/PgBouncer",
      severity: "blocking",
    });
  }
  if (coreSelected && !storage.redis && config.REDIS_MANAGE_VIA_SSH) {
    dependencies.push({ id: "dependency:core:redis", kind: "core-redis", label: "core -> Redis", severity: "warning" });
  }
  if (coreSelected && !storage.auditLog) {
    if (config.AUDIT_DB_NODE) dependencies.push({ id: "dependency:core:audit", kind: "core-audit", label: "core -> audit DB", severity: "warning" });
    if (config.LOG_DB_NODE) dependencies.push({ id: "dependency:core:log", kind: "core-log", label: "core -> log DB", severity: "warning" });
  }
  if (coreSelected && !storage.backup && config.BACKUP_ENABLED) {
    dependencies.push({ id: "dependency:core:backup", kind: "core-backup", label: "core -> backup daemon", severity: "warning" });
  }
  if (coreSelected && !storage.objectStorage && config.OBJECT_STORAGE_ENABLED) {
    dependencies.push({ id: "dependency:core:object-storage", kind: "core-object", label: "core -> object storage", severity: "warning" });
  }

  return {
    hosts: [...hosts.values()],
    ports: [...ports.values()],
    dependencies,
    selection: {
      compute: [...selectedRoles].sort(),
      storage: [
        ...(storage.postgres && (plan.storage.postgres.primary || plan.storage.postgres.replicas.length > 0 || plan.storage.postgres.pgbouncer.length > 0) ? ["postgres"] : []),
        ...(storage.redis && plan.storage.redis.length > 0 ? ["redis"] : []),
        ...(storage.auditLog && (plan.storage.auditDb || plan.storage.logDb) ? ["audit-log"] : []),
        ...(storage.backup && plan.storage.backup ? ["backup"] : []),
        ...(storage.objectStorage && plan.storage.objectStorage ? ["object-storage"] : []),
      ],
    },
  };
};

const splitSections = (output: string): Map<string, string> => {
  const sections = new Map<string, string>();
  let current = "";
  let buffer: string[] = [];
  const flush = () => {
    if (current) sections.set(current, buffer.join("\n").trim());
  };
  for (const line of output.split(/\r?\n/)) {
    const match = /^@@([A-Z0-9_-]+)@@$/.exec(line.trim());
    if (match) {
      flush();
      current = match[1]!;
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
};

const parseKeyValues = (section: string | undefined): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const line of (section ?? "").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) values[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return values;
};

const parsePorts = (section: string | undefined): PortListener[] => {
  const listeners: PortListener[] = [];
  for (const line of (section ?? "").split(/\r?\n/)) {
    const match = /^(?:LISTEN|UNCONN)\s+\d+\s+\d+\s+(\S+)\s+\S+\s+users:\(\("([^"]+)",pid=(\d+)/.exec(line.trim());
    if (!match) continue;
    const address = match[1]!;
    const colon = address.lastIndexOf(":");
    if (colon < 0) continue;
    const port = Number(address.slice(colon + 1));
    if (!Number.isFinite(port)) continue;
    listeners.push({ port, address, pid: Number(match[3]), process: match[2]! });
  }
  return listeners;
};

const parseProcesses = (section: string | undefined): ProcessInfo[] => {
  const processes: ProcessInfo[] = [];
  for (const line of (section ?? "").split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      user: match[3]!,
      elapsed: match[4]!,
      command: match[5]!,
    });
  }
  return processes;
};

const parsePm2 = (section: string | undefined): Pm2App[] => {
  if (!section) return [];
  const start = section.indexOf("[");
  if (start < 0) return [];
  try {
    const parsed = JSON.parse(section.slice(start)) as Array<{
      name?: string;
      pid?: number;
      pm2_env?: { pm_cwd?: string; pm_exec_path?: string; status?: string };
    }>;
    return parsed
      .filter((app) => typeof app.name === "string")
      .map((app) => ({
        name: app.name!,
        pid: Number(app.pid ?? 0),
        cwd: app.pm2_env?.pm_cwd ?? (app.pm2_env?.pm_exec_path ? dirname(app.pm2_env.pm_exec_path) : ""),
        status: app.pm2_env?.status ?? "unknown",
      }));
  } catch {
    return [];
  }
};

const parseCwds = (section: string | undefined): Map<number, { cwd: string; packageName: string }> => {
  const map = new Map<number, { cwd: string; packageName: string }>();
  for (const line of (section ?? "").split(/\r?\n/)) {
    const [pid, cwd, pkg] = line.split("|");
    if (!pid || !cwd) continue;
    map.set(Number(pid), { cwd, packageName: pkg ?? "" });
  }
  return map;
};

const HOST_SNAPSHOT_SCRIPT = (units: string[]): string => {
  const unitList = units.map((unit) => `'${unit.replace(/'/g, "'\\''")}'`).join(" ");
  return [
    `echo "@@OS@@"`,
    `( . /etc/os-release 2>/dev/null; echo "\${ID:-unknown}" )`,
    `echo "@@TOOLS@@"`,
    `for t in rsync curl nginx bun pm2 psql pg_dump pg_isready redis-cli ss ufw systemctl openssl; do if command -v "$t" >/dev/null 2>&1; then echo "$t=1"; else echo "$t=0"; fi; done`,
    `echo "@@DISK@@"`,
    `df -Pk / /var /var/www /var/lib/pg-backup /var/lib/pg-object-storage 2>/dev/null | awk 'NR>1 {print $6" "$4}'`,
    `echo "@@MEM@@"`,
    `awk '/^MemTotal:/ {printf "%d\\n", $2/1024}' /proc/meminfo 2>/dev/null`,
    `echo "@@CLOCK@@"`,
    `date +%s`,
    `echo "@@PM2@@"`,
    `if command -v pm2 >/dev/null 2>&1; then "$HOME/.bun/bin/pm2" jlist 2>/dev/null || pm2 jlist 2>/dev/null; elif [ -x "$HOME/.bun/bin/pm2" ]; then "$HOME/.bun/bin/pm2" jlist 2>/dev/null; fi; echo`,
    `echo "@@PS@@"`,
    `ps -eo pid=,ppid=,user=,etimes=,args= 2>/dev/null`,
    `echo "@@NGINX@@"`,
    `if command -v nginx >/dev/null 2>&1; then nginx -t 2>&1; fi`,
    `echo "@@UNITS@@"`,
    `for u in ${unitList}; do printf '%s=%s\\n' "$u" "$(systemctl show -p MainPID --value "$u" 2>/dev/null)"; done`,
  ].join("\n");
};

const CWD_SCRIPT = (pids: number[]): string =>
  `for p in ${pids.map((pid) => String(pid)).join(" ") || "0"}; do c=$(readlink /proc/$p/cwd 2>/dev/null); if [ -n "$c" ]; then n=$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$c/package.json" 2>/dev/null | head -1 | sed 's/.*"\\([^"]*\\)"$/\\1/'); echo "$p|$c|$n"; fi; done`;

const captureHostSnapshot = (
  runner: SshRunner,
  host: HostTarget,
  units: string[],
  result: (check: PreflightResult) => void,
): HostSnapshot => {
  const snapshot: HostSnapshot = {
    reachable: false,
    sudo: false,
    os: "",
    tools: {},
    diskFreeKb: {},
    memoryMb: null,
    clockSeconds: null,
    pm2Apps: [],
    processes: [],
    ports: [],
    cwds: new Map(),
    nginxTest: "",
    units: {},
  };
  try {
    runner.capture(host.ssh, "printf __PG_PREFLIGHT_OK__", { timeoutMs: 15_000 });
    snapshot.reachable = true;
    result({ id: `host:${host.key}:ssh`, label: `${host.label} SSH`, kind: "host", status: "pass", severity: "blocking", detail: `reachable (${host.ssh.user}@${host.ssh.host}:${host.ssh.port})`, host: host.label });
  } catch (error) {
    const detail = (error as Error).message;
    result({ id: `host:${host.key}:ssh`, label: `${host.label} SSH`, kind: "host", status: "fail", severity: "blocking", detail, host: host.label });
    return { ...snapshot, error: detail };
  }
  try {
    runner.capture(host.ssh, "printf __PG_PREFLIGHT_OK__", { sudo: true, timeoutMs: 15_000 });
    snapshot.sudo = true;
    result({ id: `host:${host.key}:sudo`, label: `${host.label} sudo`, kind: "host", status: "pass", severity: "blocking", detail: "password accepted", host: host.label });
  } catch (error) {
    result({ id: `host:${host.key}:sudo`, label: `${host.label} sudo`, kind: "host", status: "fail", severity: "blocking", detail: (error as Error).message, host: host.label });
  }

  let sections = new Map<string, string>();
  try {
    sections = splitSections(runner.capture(host.ssh, HOST_SNAPSHOT_SCRIPT(units), { timeoutMs: 30_000 }));
    snapshot.os = (sections.get("OS") ?? "").trim();
    snapshot.tools = Object.fromEntries(Object.entries(parseKeyValues(sections.get("TOOLS"))).map(([key, value]) => [key, value === "1"]));
    snapshot.diskFreeKb = Object.fromEntries(
      (sections.get("DISK") ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2)
        .map((parts) => [parts[0]!, Number(parts[1])]),
    );
    snapshot.memoryMb = Number((sections.get("MEM") ?? "").trim()) || null;
    snapshot.clockSeconds = Number((sections.get("CLOCK") ?? "").trim()) || null;
    snapshot.pm2Apps = parsePm2(sections.get("PM2"));
    snapshot.processes = parseProcesses(sections.get("PS"));
    snapshot.nginxTest = sections.get("NGINX") ?? "";
    snapshot.units = Object.fromEntries(
      Object.entries(parseKeyValues(sections.get("UNITS"))).map(([key, value]) => [key, Number(value) || 0]),
    );
  } catch (error) {
    result({ id: `host:${host.key}:snapshot`, label: `${host.label} host snapshot`, kind: "host", status: "fail", severity: "blocking", detail: (error as Error).message, host: host.label });
  }

  try {
    const ss = runner.capture(host.ssh, "ss -ltnpH", { sudo: true, timeoutMs: 15_000 });
    snapshot.ports = parsePorts(ss);
  } catch (error) {
    try {
      snapshot.ports = parsePorts(runner.capture(host.ssh, "ss -ltnpH", { timeoutMs: 15_000 }));
    } catch {
      result({ id: `host:${host.key}:ports`, label: `${host.label} port snapshot`, kind: "host", status: "fail", severity: "blocking", detail: `ss is unavailable: ${(error as Error).message}`, host: host.label });
    }
  }
  if (snapshot.ports.length > 0) {
    const pids = [...new Set(snapshot.ports.map((listener) => listener.pid))];
    try {
      snapshot.cwds = parseCwds(runner.capture(host.ssh, CWD_SCRIPT(pids), { timeoutMs: 15_000 }));
    } catch {
      snapshot.cwds = new Map();
    }
  }
  return snapshot;
};

const requiredTools = (host: HostTarget): string[] => {
  const tools = new Set(["systemctl", "ps", "ss"]);
  if (host.services.some((service) => service.role !== "db")) {
    tools.add("rsync");
    tools.add("curl");
    tools.add("bun");
    tools.add("pm2");
  }
  if (host.services.some((service) => ["admin", "merchant", "checkout", "fake-rails"].includes(service.role))) {
    tools.add("nginx");
  }
  if (host.roles.includes("core") || host.roles.includes("pg-primary") || host.roles.includes("audit-db") || host.roles.includes("log-db")) {
    tools.add("psql");
  }
  if (host.roles.includes("core")) tools.add("pg_dump");
  if (host.roles.includes("backup") || host.roles.includes("object-storage")) tools.add("curl");
  return [...tools];
};

const evaluateHost = (
  host: HostTarget,
  snapshot: HostSnapshot,
  options: PreflightOptions,
  result: (check: PreflightResult) => void,
): void => {
  if (!snapshot.reachable) return;
  const bootstrapAllowed = options.fresh || options.deployMode !== "update";
  const missing = requiredTools(host).filter((tool) => snapshot.tools[tool] === false);
  if (missing.length > 0) {
    result({
      id: `host:${host.key}:tools`,
      label: `${host.label} required tools`,
      kind: "host",
      status: bootstrapAllowed ? "warn" : "fail",
      severity: bootstrapAllowed ? "warning" : "blocking",
      detail: bootstrapAllowed
        ? `missing ${missing.join(", ")}; the host will be bootstrapped`
        : `missing ${missing.join(", ")}; update deploys do not install packages`,
      host: host.label,
    });
  } else {
    result({ id: `host:${host.key}:tools`, label: `${host.label} required tools`, kind: "host", status: "pass", severity: "blocking", detail: "present", host: host.label });
  }

  for (const [path, freeKb] of Object.entries(snapshot.diskFreeKb)) {
    const freeGb = freeKb / GIB;
    result({
      id: `host:${host.key}:disk:${path}`,
      label: `${host.label} disk ${path}`,
      kind: "host",
      status: freeGb < 1 ? "fail" : freeGb < 5 ? "warn" : "pass",
      severity: freeGb < 1 ? "blocking" : "warning",
      detail: `${freeGb.toFixed(1)} GiB free`,
      host: host.label,
    });
  }
  if (snapshot.memoryMb !== null) {
    const memoryGb = snapshot.memoryMb / 1024;
    const needsDatabase = host.roles.some((role) => ["core", "pg-primary", "pg-replica", "audit-db", "log-db"].includes(role));
    result({
      id: `host:${host.key}:memory`,
      label: `${host.label} memory`,
      kind: "host",
      status: needsDatabase && memoryGb < 4 ? "warn" : "pass",
      severity: needsDatabase && memoryGb < 4 ? "warning" : "info",
      detail: `${memoryGb.toFixed(1)} GiB RAM${needsDatabase && memoryGb < 4 ? " (below the 4 GiB database profile)" : ""}`,
      host: host.label,
    });
  }
  if (snapshot.clockSeconds !== null) {
    const skew = Math.abs(snapshot.clockSeconds - Math.floor(Date.now() / 1000));
    const timeCritical = host.roles.some((role) => ["core", "pg-primary", "pg-replica", "audit-db", "log-db", "backup", "object-storage"].includes(role));
    if (skew > 60) {
      result({
        id: `host:${host.key}:clock`,
        label: `${host.label} clock`,
        kind: "host",
        status: timeCritical && skew > 300 ? "fail" : "warn",
        severity: timeCritical && skew > 300 ? "blocking" : "warning",
        detail: `${skew}s skew from the orchestrator`,
        host: host.label,
      });
    } else {
      result({ id: `host:${host.key}:clock`, label: `${host.label} clock`, kind: "host", status: "pass", severity: "info", detail: `${skew}s skew`, host: host.label });
    }
  }
  const needsNginx = host.services.some((service) => ["admin", "merchant", "checkout", "fake-rails"].includes(service.role));
  if (needsNginx) {
    if (snapshot.tools.nginx === false) {
      if (!bootstrapAllowed) {
        result({ id: `host:${host.key}:nginx`, label: `${host.label} nginx`, kind: "host", status: "fail", severity: "blocking", detail: "nginx is not installed", host: host.label });
      }
    } else if (/test is successful|syntax is ok/i.test(snapshot.nginxTest)) {
      result({ id: `host:${host.key}:nginx`, label: `${host.label} nginx -t`, kind: "host", status: "pass", severity: "blocking", detail: "current configuration parses", host: host.label });
    } else {
      result({ id: `host:${host.key}:nginx`, label: `${host.label} nginx -t`, kind: "host", status: "fail", severity: "blocking", detail: (snapshot.nginxTest || "nginx -t failed").slice(0, 300), host: host.label });
    }
  }
  if (host.services.some((service) => service.role !== "db") && snapshot.tools.pm2 === false && !bootstrapAllowed) {
    result({ id: `host:${host.key}:pm2`, label: `${host.label} PM2`, kind: "host", status: "fail", severity: "blocking", detail: "PM2 is not installed", host: host.label });
  }
};

const descendant = (pid: number, ancestor: number, processes: ProcessInfo[]): boolean => {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  let current = byPid.get(pid);
  const seen = new Set<number>();
  while (current && current.pid !== 0 && !seen.has(current.pid)) {
    if (current.ppid === ancestor) return true;
    seen.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return false;
};

export const classifyPort = (
  check: PortCheck,
  snapshot: HostSnapshot,
): { classification: PortClassification; listener?: PortListener; detail: string } => {
  const listeners = snapshot.ports.filter((listener) => listener.port === check.port);
  if (listeners.length === 0) return { classification: "free", detail: "port is free" };
  const listener = listeners[0]!;
  const process = snapshot.processes.find((entry) => entry.pid === listener.pid);
  const cwd = snapshot.cwds.get(listener.pid)?.cwd ?? "";
  const packageName = snapshot.cwds.get(listener.pid)?.packageName ?? "";
  const expected = check.expectation;

  if (expected.kind === "nginx") {
    return snapshot.processes
      .filter((entry) => listeners.some((candidate) => candidate.pid === entry.pid))
      .some((entry) => entry.command.toLowerCase().includes("nginx"))
      ? { classification: "managed-service", listener, detail: "held by nginx" }
      : { classification: "foreign", listener, detail: `held by ${listener.process} (PID ${listener.pid}), not nginx` };
  }

  if (expected.kind === "pm2") {
    const planned = new Set(expected.plannedNames ?? []);
    const currentApp = snapshot.pm2Apps.find((app) => app.name === expected.serviceName);
    if (currentApp && (currentApp.pid === listener.pid || descendant(listener.pid, currentApp.pid, snapshot.processes))) {
      return { classification: "managed-current", listener, detail: `held by PM2 ${currentApp.name}` };
    }
    const base = expected.baseName ?? expected.serviceName ?? "";
    const orphan = snapshot.pm2Apps.find(
      (app) =>
        (app.name === base || app.name.startsWith(`${base}-`)) &&
        !planned.has(app.name) &&
        expected.remoteDir !== undefined &&
        app.cwd.startsWith(expected.remoteDir) &&
        (app.pid === listener.pid || descendant(listener.pid, app.pid, snapshot.processes)),
    );
    if (orphan) {
      return { classification: "managed-orphan", listener, detail: `held by orphan PM2 app ${orphan.name}` };
    }
    const command = process?.command ?? "";
    const user = process?.user ?? "";
    const sameRepo = cwd.startsWith(REPO_ROOT) || cwd.startsWith(`${REPO_ROOT}/`);
    if (
      sameRepo &&
      expected.packageName !== undefined &&
      packageName === expected.packageName &&
      /(^|\/)(bun|node)(\s|$)/.test(command) &&
      /(index\.ts|run dev|--watch|dev\b)/.test(command)
    ) {
      return { classification: "unmanaged-same-repo", listener, detail: `held by ${user || "user"} dev process ${command.trim()} (cwd ${cwd})` };
    }
    return { classification: "foreign", listener, detail: `held by ${listener.process} (PID ${listener.pid})${cwd ? `, cwd ${cwd}` : ""}${command ? `, command ${command.trim()}` : ""}` };
  }

  const processNames = (expected.processNames ?? []).map((name) => name.toLowerCase());
  const name = listener.process.toLowerCase();
  const matchesProcess = processNames.some((candidate) => name.includes(candidate));
  const unitPid = expected.unit ? snapshot.units[expected.unit] : undefined;
  if (expected.cmdIncludes) {
    if (process?.command.includes(expected.cmdIncludes)) {
      return { classification: "managed-service", listener, detail: `held by ${listener.process} (${expected.cmdIncludes})` };
    }
    return {
      classification: "foreign",
      listener,
      detail: `held by ${listener.process} (PID ${listener.pid}) but the expected data directory ${expected.cmdIncludes} does not match${process ? `: ${process.command}` : ""}`,
    };
  }
  if (expected.unit && unitPid === listener.pid) {
    return { classification: "managed-service", listener, detail: `held by systemd unit ${expected.unit}` };
  }
  if (matchesProcess && (!expected.unit || unitPid === listener.pid || unitPid === undefined)) {
    return { classification: "managed-service", listener, detail: `held by ${listener.process}` };
  }
  return { classification: "foreign", listener, detail: `held by ${listener.process} (PID ${listener.pid})${process ? `, ${process.command}` : ""}` };
};

const dependencyResult = (check: DependencyCheck, probe: ProbeResult): PreflightResult => ({
  id: `${check.id}:${probe.check}`,
  label: `${check.label}: ${probe.check}`,
  kind: "dependency",
  status: probe.ok ? "pass" : check.severity === "blocking" ? "fail" : "warn",
  severity: check.severity,
  detail: probe.detail.slice(0, 300),
  host: probe.host,
});

export const runPreflight = (
  runner: SshRunner,
  config: DeployConfig,
  plan: DeployPlan,
  options: PreflightOptions,
): PreflightReport => {
  const preflight = buildPreflightPlan(config, plan, options);
  const results: PreflightResult[] = [];
  const result = (check: PreflightResult) => results.push(check);
  if (options.dryRun) {
    for (const host of preflight.hosts) {
      result({ id: `host:${host.key}:dry-run`, label: `${host.label} host checks`, kind: "host", status: "skip", severity: "info", detail: "dry-run: no remote command executed", host: host.label });
    }
    for (const check of preflight.ports) {
      result({ id: check.id, label: `${check.hostLabel} port ${check.port} (${check.description})`, kind: "port", status: "skip", severity: "info", detail: "dry-run: no remote command executed", host: check.hostLabel, port: check.port });
    }
    for (const dependency of preflight.dependencies) {
      result({ id: dependency.id, label: dependency.label, kind: "dependency", status: "skip", severity: dependency.severity, detail: "dry-run" });
    }
    return { results, blocking: [], warnings: [], skipped: results };
  }
  const units = new Set<string>(["pgbouncer", "pg-backup-daemon", "pg-object-storage-daemon", "redis-server", "valkey"]);
  const snapshots = new Map<string, HostSnapshot>();

  for (const host of preflight.hosts) {
    const snapshot = captureHostSnapshot(runner, host, [...units], result);
    snapshots.set(host.key, snapshot);
    evaluateHost(host, snapshot, options, result);
  }

  const portResults: PreflightResult[] = [];
  for (const check of preflight.ports) {
    const snapshot = snapshots.get(check.hostKey);
    if (!snapshot || !snapshot.reachable) {
      portResults.push({ id: check.id, label: `${check.hostLabel} port ${check.port}`, kind: "port", status: "skip", severity: "blocking", detail: "host is unreachable", host: check.hostLabel, port: check.port });
      continue;
    }
    const classified = classifyPort(check, snapshot);
    const detail = classified.detail;
    let status: PreflightStatus = "pass";
    if (classified.classification === "free") status = "pass";
    else if (classified.classification === "managed-current" || classified.classification === "managed-orphan" || classified.classification === "managed-service") status = "pass";
    else status = "fail";
    const listener = classified.listener;
    const cwd = listener ? snapshot.cwds.get(listener.pid)?.cwd ?? "" : "";
    const process = listener ? snapshot.processes.find((entry) => entry.pid === listener.pid) : undefined;
    portResults.push({
      id: check.id,
      label: `${check.hostLabel} port ${check.port} (${check.description})`,
      kind: "port",
      status,
      severity: "blocking",
      detail,
      host: check.hostLabel,
      port: check.port,
      classification: classified.classification,
      pid: listener?.pid,
      cwd,
      command: process?.command,
    });
  }
  results.push(...portResults);

  for (const dependency of preflight.dependencies) {
    if (options.dryRun) {
      result({ id: dependency.id, label: dependency.label, kind: "dependency", status: "skip", severity: dependency.severity, detail: "dry-run" });
      continue;
    }
    let probes: ProbeResult[] = [];
    if (dependency.kind === "edge-core" && dependency.host && dependency.role) {
      const scopedHost: HostPlan = { ...dependency.host, roles: [dependency.role] };
      probes = probeEdgeToCore(runner, scopedHost, config);
    } else if (dependency.kind === "core-db") {
      probes = config.PGBOUNCER_ENABLED ? probePgBouncer(runner, plan, config) : probePgPrimary(runner, plan, config);
    } else if (dependency.kind === "core-redis") {
      probes = probeRedis(runner, plan, config);
    } else if (dependency.kind === "core-audit") {
      probes = probeAuditDb(runner, plan, config);
    } else if (dependency.kind === "core-log") {
      probes = probeLogDb(runner, plan, config);
    } else if (dependency.kind === "core-backup") {
      probes = probeBackupDaemon(runner, plan, config);
    } else if (dependency.kind === "core-object") {
      probes = probeObjectStorage(runner, plan, config);
    }
    if (probes.length === 0) {
      result({ id: dependency.id, label: dependency.label, kind: "dependency", status: "skip", severity: dependency.severity, detail: "not configured or not running" });
    } else {
      for (const probe of probes) results.push(dependencyResult(dependency, probe));
    }
  }

  // `--stop-unmanaged` is deliberately narrow: stop only same-repo dev listeners,
  // and only when no other blocking issue exists.
  if (options.stopUnmanaged && !options.dryRun) {
    const otherFailures = results.filter((entry) => entry.status === "fail" && !(entry.kind === "port" && entry.classification === "unmanaged-same-repo"));
    const candidates = results.filter((entry) => entry.kind === "port" && entry.status === "fail" && entry.classification === "unmanaged-same-repo" && entry.pid && entry.cwd);
    if (otherFailures.length === 0) {
      for (const candidate of candidates) {
        const host = preflight.hosts.find((entry) => entry.label === candidate.host);
        if (!host || !candidate.pid || !candidate.cwd) continue;
        const script = `cwd=$(readlink /proc/${candidate.pid}/cwd 2>/dev/null); if [ "$cwd" = ${shellQuote(candidate.cwd)} ]; then kill -TERM ${candidate.pid} && echo __PG_STOPPED__; fi`;
        try {
          const out = runner.capture(host.ssh, script, { timeoutMs: 10_000 });
          if (out.includes("__PG_STOPPED__")) {
            candidate.status = "pass";
            candidate.detail = `stopped unmanaged listener PID ${candidate.pid} (${candidate.cwd})`;
          } else {
            candidate.detail = `refusing to stop PID ${candidate.pid}: its cwd changed`;
          }
        } catch (error) {
          candidate.detail = `failed to stop PID ${candidate.pid}: ${(error as Error).message}`;
        }
      }
      if (candidates.some((candidate) => candidate.status === "pass")) {
        // Re-read the affected ports after termination.
        for (const host of preflight.hosts) {
          const still = candidates.filter((candidate) => candidate.host === host.label && candidate.status === "pass");
          if (still.length === 0) continue;
          try {
            const ports = parsePorts(runner.capture(host.ssh, "ss -ltnpH", { sudo: true, timeoutMs: 15_000 }));
            for (const candidate of still) {
              const remaining = ports.find((listener) => listener.port === candidate.port);
              if (remaining) {
                candidate.status = "fail";
                candidate.detail = `port ${candidate.port} is still held by PID ${remaining.pid} (${remaining.process})`;
              }
            }
          } catch {
            // The kill was acknowledged and no re-read is possible; keep the pass.
          }
        }
      }
    } else if (candidates.length > 0) {
      for (const candidate of candidates) {
        candidate.detail = `${candidate.detail}; not stopping because other blocking issues exist`;
      }
    }
  }

  const blocking = results.filter((entry) => entry.status === "fail" && entry.severity === "blocking");
  const warnings = results.filter((entry) => entry.status === "warn" || (entry.status === "fail" && entry.severity !== "blocking"));
  const skipped = results.filter((entry) => entry.status === "skip");
  return { results, blocking, warnings, skipped };
};

export const renderPreflightReport = (report: PreflightReport, plan: PreflightPlan): string[] => {
  const lines: string[] = [];
  const selection = [
    plan.selection.compute.length > 0 ? `compute: ${plan.selection.compute.join(", ")}` : "",
    plan.selection.storage.length > 0 ? `storage: ${plan.selection.storage.join(", ")}` : "",
  ].filter(Boolean).join("; ");
  lines.push(`Preflight (read-only)${selection ? ` — ${selection}` : ""}`);
  for (const result of report.results) {
    const marker = result.status === "pass" ? "PASS" : result.status === "warn" ? "WARN" : result.status === "fail" ? "FAIL" : "SKIP";
    lines.push(`  ${marker.padEnd(4)} ${result.label}: ${result.detail}`);
  }
  if (report.blocking.length > 0) {
    lines.push(`Preflight failed: ${report.blocking.length} blocking issue(s). Nothing was built or changed.`);
  } else {
    lines.push(`Preflight passed${report.warnings.length > 0 ? ` with ${report.warnings.length} warning(s)` : ""}.`);
  }
  return lines;
};
