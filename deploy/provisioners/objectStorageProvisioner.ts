import { objectStorageConfigured, parseNodeList, type DeployConfig } from "../lib/configSchema";
import type { SshTarget } from "../lib/hostPlanner";
import { envAssign, shellQuote } from "../lib/quoting";
import { isChanged, type ApplyOutcome, type ProvisionRunner } from "../lib/converge";
import type { ProvisionReport } from "./postgres18Provisioner";

/**
 * The Shared Object & Asset Storage daemon provisioner.
 *
 * It creates the unprivileged service account, the vault directories, the
 * environment file and the systemd unit on the dedicated OBJECT_STORAGE_NODE.
 * The source tree and the running process are handled by
 * `deployObjectStorageDaemon()` in `deploy.ts`, exactly like the backup daemon.
 */

export const OBJECT_STORAGE_SERVICE_USER = "pgobjstore";
export const OBJECT_STORAGE_ENV_PATH = "/etc/pg-object-storage/object-storage.env";
export const OBJECT_STORAGE_UNIT_PATH = "/etc/systemd/system/pg-object-storage-daemon.service";
export const OBJECT_STORAGE_INSTALL_DIR = "/opt/pg-object-storage-daemon";

const objectStorageSpec = (config: DeployConfig) =>
  parseNodeList(config.OBJECT_STORAGE_NODE)[0] ?? null;

export const objectStorageSsh = (config: DeployConfig): SshTarget | null => {
  const spec = objectStorageSpec(config);
  if (!spec) return null;
  return {
    host: spec.sshHost,
    port: spec.sshPort,
    user: config.OBJECT_STORAGE_SSH_USER,
    keyPath: config.OBJECT_STORAGE_SSH_KEY_PATH ?? "",
    sudoPassword: config.OBJECT_STORAGE_SUDO_PASSWORD,
  };
};

export const objectStorageBindHost = (config: DeployConfig): string =>
  config.OBJECT_STORAGE_DAEMON_BIND_HOST.trim()
  || objectStorageSpec(config)?.privateIp
  || "127.0.0.1";

export const objectStoragePort = (config: DeployConfig): number =>
  objectStorageSpec(config)?.servicePort ?? config.OBJECT_STORAGE_DAEMON_PORT;

export const objectStorageDaemonEnv = (config: DeployConfig): Record<string, string> => ({
  NODE_ENV: "production",
  OBJECT_STORAGE_DAEMON_BIND_HOST: objectStorageBindHost(config),
  OBJECT_STORAGE_DAEMON_PORT: String(objectStoragePort(config)),
  OBJECT_STORAGE_ROOT_DIR: config.OBJECT_STORAGE_ROOT_DIR,
  OBJECT_STORAGE_DAEMON_TLS_CA_PATH: config.OBJECT_STORAGE_ALLOW_INSECURE_HTTP
    ? ""
    : `${config.OBJECT_STORAGE_DAEMON_CERT_DIR}/internal-ca.crt`,
  OBJECT_STORAGE_DAEMON_TLS_CERT_PATH: config.OBJECT_STORAGE_ALLOW_INSECURE_HTTP
    ? ""
    : `${config.OBJECT_STORAGE_DAEMON_CERT_DIR}/object-storage-daemon.crt`,
  OBJECT_STORAGE_DAEMON_TLS_KEY_PATH: config.OBJECT_STORAGE_ALLOW_INSECURE_HTTP
    ? ""
    : `${config.OBJECT_STORAGE_DAEMON_CERT_DIR}/object-storage-daemon.key`,
  OBJECT_STORAGE_ALLOWED_CLIENT_CNS: config.OBJECT_STORAGE_ALLOWED_CLIENT_CNS,
});

export const renderObjectStorageEnvFile = (env: Record<string, string>): string =>
  `${Object.entries(env)
    .map(([key, value]) => envAssign(key, value))
    .join("\n")}\n`;

export const objectStorageDaemonSystemdUnit = (config: DeployConfig): string => `[Unit]
Description=Payment Gateway Shared Object Storage mTLS Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${OBJECT_STORAGE_SERVICE_USER}
Group=${OBJECT_STORAGE_SERVICE_USER}
WorkingDirectory=${OBJECT_STORAGE_INSTALL_DIR}
EnvironmentFile=${OBJECT_STORAGE_ENV_PATH}
Environment=HOME=/var/lib/pg-object-storage
Environment=BUN_INSTALL_CACHE_DIR=/var/lib/pg-object-storage/.bun-cache
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths=/var/lib/pg-object-storage ${config.OBJECT_STORAGE_ROOT_DIR} ${config.OBJECT_STORAGE_DAEMON_CERT_DIR}

[Install]
WantedBy=multi-user.target
`;

export interface ObjectStorageProvisionReport extends ProvisionReport {
  daemonConfigChanged: boolean;
}

export const provisionObjectStorageEngine = (input: {
  runner: ProvisionRunner;
  config: DeployConfig;
  dryRun?: boolean;
  forceRestart?: boolean;
}): ObjectStorageProvisionReport => {
  const { runner, config } = input;
  const commands: string[] = [];
  const outcomes: Record<string, ApplyOutcome> = {};

  if (!objectStorageConfigured(config)) {
    const coreCount = parseNodeList(config.CORE_NODES).length;
    const backupOnSeparateHost = (() => {
      if (!config.BACKUP_ENABLED) return false;
      const coreIp = parseNodeList(config.CORE_NODES)[0]?.privateIp ?? config.CORE_PRIVATE_IP;
      const backupIp = parseNodeList(config.BACKUP_NODE)[0]?.privateIp;
      return Boolean(coreIp && backupIp && coreIp !== backupIp);
    })();
    if (coreCount > 1 || backupOnSeparateHost) {
      throw new Error(
        "MULTI_NODE_SHARED_STORAGE_REQUIRED: Refusing to provision without OBJECT_STORAGE_NODE when multiple CORE_NODES are configured.",
      );
    }
    return { nodes: [], commands, outcomes, daemonConfigChanged: false };
  }

  const spec = objectStorageSpec(config);
  const ssh = objectStorageSsh(config);
  if (!spec || !ssh) {
    throw new Error("OBJECT_STORAGE_NODE is required when object storage is enabled");
  }

  const rootDir = config.OBJECT_STORAGE_ROOT_DIR;
  const certDir = config.OBJECT_STORAGE_DAEMON_CERT_DIR;
  const serviceUser = OBJECT_STORAGE_SERVICE_USER;
  const userSetupCmd = [
    `getent group ${serviceUser} >/dev/null 2>&1 || groupadd --system ${serviceUser}`,
    `id -u ${serviceUser} >/dev/null 2>&1 || useradd --system --gid ${serviceUser} --home /var/lib/pg-object-storage --shell /usr/sbin/nologin ${serviceUser}`,
    `install -d -m 0750 -o ${serviceUser} -g ${serviceUser} /var/lib/pg-object-storage ${shellQuote(rootDir)} ${shellQuote(`${rootDir}/hot`)} ${shellQuote(`${rootDir}/cold`)} ${shellQuote(`${rootDir}/quarantine`)} ${shellQuote(`${rootDir}/tmp`)} ${shellQuote(`${rootDir}/.trash`)} ${shellQuote(certDir)}`,
    `install -d -m 0750 -o root -g ${serviceUser} /etc/pg-object-storage`,
  ].join(" && ");

  runner.run(ssh, userSetupCmd, { sudo: true });
  commands.push(userSetupCmd);

  const envWritten = runner.writeRemoteFile({
    target: ssh,
    path: OBJECT_STORAGE_ENV_PATH,
    content: renderObjectStorageEnvFile(objectStorageDaemonEnv(config)),
    mode: 0o640,
    sudo: true,
  });
  runner.run(ssh, `chown root:${serviceUser} ${shellQuote(OBJECT_STORAGE_ENV_PATH)}`, { sudo: true });

  const unitWritten = runner.writeRemoteFile({
    target: ssh,
    path: OBJECT_STORAGE_UNIT_PATH,
    content: objectStorageDaemonSystemdUnit(config),
    mode: 0o644,
    sudo: true,
  });

  const daemonConfigChanged = isChanged(envWritten) || isChanged(unitWritten);
  outcomes["pg-object-storage-daemon-config"] = daemonConfigChanged ? "updated" : "unchanged";

  return {
    nodes: [`${spec.nodeId}@${spec.privateIp}:${spec.servicePort}`],
    commands,
    outcomes,
    daemonConfigChanged,
  };
};
