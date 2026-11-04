import { parseNodeList, type DeployConfig } from "../lib/configSchema";
import type { SshTarget } from "../lib/hostPlanner";
import type { ProvisionReport, ProvisionRunner } from "./postgres18Provisioner";

export interface RedisProvisionInput {
  runner: ProvisionRunner;
  config: DeployConfig;
  dryRun?: boolean;
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
  for (const spec of parseNodeList(config.REDIS_NODES)) {
    const ssh = nodeSsh(config, spec);
    nodes.push(spec.privateIp);
    for (const command of [
      `if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y redis-server
elif command -v pacman >/dev/null 2>&1; then
  pacman -Sy --noconfirm valkey
fi
install -d -m 0750 /var/lib/pg-redis && (chown redis:redis /var/lib/pg-redis 2>/dev/null || chown valkey:valkey /var/lib/pg-redis 2>/dev/null || true)
systemctl enable --now redis-server 2>/dev/null || systemctl enable --now valkey 2>/dev/null || true`,
    ]) {
      commands.push(command);
      runner.run(ssh, command, { sudo: true });
    }
    const snippet = redisConfigSnippet(config, spec.privateIp, spec.servicePort);
    runner.writeRemoteFile({
      target: ssh,
      path: "/etc/redis/redis.conf.d/zz-pg-switch.conf",
      content: snippet,
      mode: 0o640,
      sudo: true,
    });
    // Debian's redis.conf includes /etc/redis/redis.conf.d only on newer builds;
    // write the effective file too so the bind/requirepass always apply.
    runner.writeRemoteFile({
      target: ssh,
      path: "/etc/redis/redis.conf",
      content: snippet,
      mode: 0o640,
      sudo: true,
    });
    // Arch's valkey package reads /etc/valkey/valkey.conf.
    runner.writeRemoteFile({
      target: ssh,
      path: "/etc/valkey/valkey.conf",
      content: snippet,
      mode: 0o640,
      sudo: true,
    });
    for (const unit of ["redis-server", "valkey"]) {
      runner.writeRemoteFile({
        target: ssh,
        path: `/etc/systemd/system/${unit}.service.d/zz-pg-switch.conf`,
        content: redisSystemdDropIn(),
        mode: 0o644,
        sudo: true,
      });
    }
    for (const command of redisFirewallCommands(config, spec.servicePort)) {
      commands.push(command);
      runner.run(ssh, command, { sudo: true });
    }
    runner.run(ssh, "chown root:redis /etc/redis/redis.conf 2>/dev/null || chown root:valkey /etc/redis/redis.conf 2>/dev/null || true; chown root:redis /etc/valkey/valkey.conf 2>/dev/null || chown root:valkey /etc/valkey/valkey.conf 2>/dev/null || true", { sudo: true });
    const auth = config.REDIS_PASSWORD ? `REDISCLI_AUTH=${shellQuote(config.REDIS_PASSWORD)} ` : "";
    const ping = `${auth}redis-cli -p ${spec.servicePort} PING`;
    // Disable save-on-shutdown on the currently running instance before the
    // restart. An instance started under the distro sandbox with a read-only
    // dir refuses to exit when its shutdown save fails, which would hang
    // systemctl with TimeoutStopSec=0. The new config restores saving.
    const restart = `systemctl daemon-reload; ${auth}redis-cli -p ${spec.servicePort} CONFIG SET save "" >/dev/null 2>&1 || true; systemctl restart redis-server 2>/dev/null || systemctl restart redis 2>/dev/null || systemctl restart valkey 2>/dev/null || true; sleep 1; ${ping}`;
    commands.push(restart);
    runner.run(ssh, restart, { sudo: true });
  }
  return { commands, nodes };
};
