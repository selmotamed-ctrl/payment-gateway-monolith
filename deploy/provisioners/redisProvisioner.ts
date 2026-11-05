import { parseNodeList, type DeployConfig } from "../lib/configSchema";
import { ensurePackagesScript, isChanged, parseApplyOutcome, redisApplyScript, redisUnitDetectScript, type ApplyOutcome, type ProvisionRunner } from "../lib/converge";
import type { SshTarget } from "../lib/hostPlanner";
import type { ProvisionReport } from "./postgres18Provisioner";

export interface RedisProvisionInput {
  runner: ProvisionRunner;
  config: DeployConfig;
  dryRun?: boolean;
  /** Restart even when nothing changed (`--force-restart`). */
  forceRestart?: boolean;
}

const nodeSsh = (config: DeployConfig, spec: { sshHost: string; sshPort: number }): SshTarget => ({
  host: spec.sshHost,
  port: spec.sshPort,
  user: config.REDIS_SSH_USER,
  keyPath: config.REDIS_SSH_KEY_PATH ?? "",
  sudoPassword: config.REDIS_SUDO_PASSWORD,
});

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Bind strictly to the private LAN address and require a password. */
export const redisConfigSnippet = (config: DeployConfig, privateIp: string, port = 6379): string => {
  // A loopback-only node (single-machine deploy) would otherwise render the
  // same address twice and Redis would fail its second bind with EADDRINUSE.
  const bindAddresses = [...new Set([privateIp, "127.0.0.1"])].join(" ");
  return `bind ${bindAddresses}
protected-mode yes
port ${port}
requirepass ${config.REDIS_PASSWORD}
save 3600 1
maxmemory ${config.REDIS_MAXMEMORY}
maxmemory-policy allkeys-lru
appendonly no
daemonize no
supervised systemd
dir /var/lib/pg-redis
`;
};

/**
 * The distro units use ProtectSystem=strict and only whitelist their own
 * state directory, so /var/lib/pg-redis is read-only unless the unit grants
 * it explicitly. The drop-in is harmless on units without a sandbox.
 */
const redisSystemdDropIn = (): string => `[Service]
ReadWritePaths=/var/lib/pg-redis
`;

export const redisFirewallCommands = (config: DeployConfig, port = 6379): string[] => {
  const sources = [
    ...parseNodeList(config.CORE_NODES).map((node) => node.privateIp),
    ...(config.CORE_PRIVATE_IP ? [config.CORE_PRIVATE_IP] : []),
    ...(parseNodeList(config.BACKUP_NODE)[0]?.privateIp ? [parseNodeList(config.BACKUP_NODE)[0]!.privateIp] : []),
  ];
  return [...new Set(sources)].map((source) =>
    `command -v ufw >/dev/null 2>&1 && ufw allow from ${source} to any port ${port} proto tcp comment 'Redis from core/backup' || true`,
  );
};

export const provisionRedis = (input: RedisProvisionInput): ProvisionReport => {
  const { runner, config } = input;
  const commands: string[] = [];
  const nodes: string[] = [];
  const outcomes: Record<string, ApplyOutcome> = {};
  for (const spec of parseNodeList(config.REDIS_NODES)) {
    const ssh = nodeSsh(config, spec);
    nodes.push(spec.privateIp);
    for (const command of [
      `${ensurePackagesScript({ debian: ["redis-server"], arch: ["valkey"] })}
install -d -m 0750 /var/lib/pg-redis && (chown redis:redis /var/lib/pg-redis 2>/dev/null || chown valkey:valkey /var/lib/pg-redis 2>/dev/null || true)`,
    ]) {
      commands.push(command);
      runner.run(ssh, command, { sudo: true });
    }
    // Which unit does this host actually run? Only that flavour's files decide
    // whether a restart is needed; the other flavour's files are written for
    // portability but must not trigger a restart of an unrelated service.
    const detected = String(runner.capture(ssh, redisUnitDetectScript(), { sudo: false })).trim();
    const unit = detected || "redis-server";
    const snippet = redisConfigSnippet(config, spec.privateIp, spec.servicePort);
    const write = (path: string, content: string, mode: number): boolean =>
      isChanged(runner.writeRemoteFile({ target: ssh, path, content, mode, sudo: true }));
    const confChanged = [
      write("/etc/redis/redis.conf.d/zz-pg-switch.conf", snippet, 0o640),
      // Debian's redis.conf includes /etc/redis/redis.conf.d only on newer builds;
      // write the effective file too so the bind/requirepass always apply.
      write("/etc/redis/redis.conf", snippet, 0o640),
      // Arch's valkey package reads /etc/valkey/valkey.conf.
      write("/etc/valkey/valkey.conf", snippet, 0o640),
    ];
    const dropInChanged = ["redis-server", "valkey"].map((flavour) =>
      write(`/etc/systemd/system/${flavour}.service.d/zz-pg-switch.conf`, redisSystemdDropIn(), 0o644),
    );
    const relevantConf = unit === "valkey" ? confChanged[2]! : confChanged[0]! || confChanged[1]!;
    const relevantDropIn = unit === "valkey" ? dropInChanged[1]! : dropInChanged[0]!;
    for (const command of redisFirewallCommands(config, spec.servicePort)) {
      commands.push(command);
      runner.run(ssh, command, { sudo: true });
    }
    runner.run(ssh, "chown root:redis /etc/redis/redis.conf 2>/dev/null || chown root:valkey /etc/redis/redis.conf 2>/dev/null || true; chown root:redis /etc/valkey/valkey.conf 2>/dev/null || chown root:valkey /etc/valkey/valkey.conf 2>/dev/null || true", { sudo: true });
    const auth = config.REDIS_PASSWORD ? `REDISCLI_AUTH=${shellQuote(config.REDIS_PASSWORD)} ` : "";
    const script = redisApplyScript({
      unit,
      port: spec.servicePort,
      auth,
      changed: input.forceRestart === true || relevantConf || relevantDropIn,
      daemonReload: relevantDropIn,
    });
    commands.push(script);
    outcomes[`${ssh.host}:${unit}`] = parseApplyOutcome(String(runner.capture(ssh, script, { sudo: true, timeoutMs: 5 * 60_000 })));
  }
  return { commands, nodes, outcomes };
};
