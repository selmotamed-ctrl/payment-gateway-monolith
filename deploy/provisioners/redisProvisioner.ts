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

/** Bind strictly to the private LAN address and require a password. */
export const redisConfigSnippet = (config: DeployConfig, privateIp: string, port = 6379): string => `bind ${privateIp} 127.0.0.1
protected-mode yes
port ${port}
requirepass ${config.REDIS_PASSWORD}
save 3600 1
maxmemory ${config.REDIS_MAXMEMORY}
maxmemory-policy allkeys-lru
appendonly no
daemonize yes
`;

export const redisFirewallCommands = (config: DeployConfig, port = 6379): string[] => {
  const sources = [
    ...parseNodeList(config.CORE_NODES).map((node) => node.privateIp),
    ...(config.CORE_PRIVATE_IP ? [config.CORE_PRIVATE_IP] : []),
    ...(parseNodeList(config.BACKUP_NODE)[0]?.privateIp ? [parseNodeList(config.BACKUP_NODE)[0]!.privateIp] : []),
  ];
  return [...new Set(sources)].map((source) =>
    `ufw allow from ${source} to any port ${port} proto tcp comment 'Redis from core/backup'`,
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
      "apt-get update",
      "DEBIAN_FRONTEND=noninteractive apt-get install -y redis-server",
      "systemctl enable --now redis-server",
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
    for (const command of redisFirewallCommands(config, spec.servicePort)) {
      commands.push(command);
      runner.run(ssh, command, { sudo: true });
    }
    const restart = "systemctl restart redis-server && redis-cli PING";
    commands.push(restart);
    runner.run(ssh, restart, { sudo: true });
  }
  return { commands, nodes };
};
