import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { hasRole, machinePrivateIp, machineSshPort, type LabConfig, type LabMachine } from "./labConfig";
import type { LabSecrets } from "./labSecrets";
import { LabRemote, shellQuote } from "./remote";

/**
 * Lab bootstrap for N declared machines.
 *
 * Security fixes against the archived two-machine bootstrap:
 * - no default or hard-coded password (the archived code defaulted both hosts to a four-digit literal);
 * - no password-on-the-command-line SSH helper (the password was visible in
 *   the process list) and no disabled host-key checking: the operator
 *   authorizes the lab key once with
 *   `ssh-copy-id`, and the bootstrap only verifies key-based BatchMode SSH;
 * - peer keys (Barman / pg_basebackup between machines) are authorized with a
 *   `from="<declared private IPs>"` restriction;
 * - MinIO credentials are generated per lab and passed via a 0600 env-file,
 *   not on the `docker run` command line.
 */

const log = (message: string): void => console.log(message);

const expandHome = (path: string): string => (path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path);

export const ensureOperatorKey = (config: LabConfig): void => {
  const keyPath = expandHome(config.ssh.keyPath);
  if (existsSync(keyPath)) return;
  if (!config.ssh.generateKeyIfMissing) {
    throw new Error(`SSH key ${config.ssh.keyPath} does not exist. Create it (ssh-keygen -t ed25519 -f ${config.ssh.keyPath}) or set ssh.generateKeyIfMissing=true.`);
  }
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  const result = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", `pg-lab-${config.lab.name}`], { encoding: "utf8" });
  if ((result.status ?? 1) !== 0) throw new Error(`ssh-keygen failed: ${result.stderr}`);
  chmodSync(keyPath, 0o600);
};

export interface MachineCheck {
  machineId: string;
  ok: boolean;
  detail: string;
}

/** Verifies key-based SSH and sudo on every machine. Never prompts. */
export const verifyMachines = (config: LabConfig, remote: LabRemote): MachineCheck[] =>
  config.machines.map((machine) => {
    const ssh = remote.tryRun(machine.id, "hostname");
    if (!ssh.ok) {
      return {
        machineId: machine.id,
        ok: false,
        detail: `SSH failed. Authorize the lab key once: ssh-copy-id -i ${config.ssh.keyPath}.pub -p ${machineSshPort(config, machine)} ${config.ssh.user}@${machine.address} (${ssh.output.split("\n")[0]})`,
      };
    }
    const sudoCommand = config.ssh.sudo.mode === "nopasswd" ? "sudo -n true && echo SUDO_OK" : "echo SUDO_OK";
    const sudo = remote.tryRun(machine.id, sudoCommand, { sudo: config.ssh.sudo.mode === "password" });
    return {
      machineId: machine.id,
      ok: sudo.ok && sudo.output.includes("SUDO_OK"),
      detail: sudo.ok ? `hostname=${ssh.output.trim()} sudo=ok` : `sudo failed (${config.ssh.sudo.mode}): ${sudo.output.split("\n")[0]}`,
    };
  });

const peerMachines = (config: LabConfig): LabMachine[] =>
  config.machines.filter((machine) => hasRole(machine, "db") || hasRole(machine, "backup") || hasRole(machine, "vault"));

/**
 * Machine-to-machine keys for Barman, pg_basebackup and the SSH vault. Each
 * peer machine gets its own key, authorized on the other peer machines only,
 * and only from the declared private IPs.
 */
const ensurePeerKeys = (config: LabConfig, remote: LabRemote): void => {
  const peers = peerMachines(config);
  if (peers.length < 2) return;
  const fromList = config.machines.map(machinePrivateIp).join(",");
  const publicKeys = new Map<string, string>();
  for (const machine of peers) {
    remote.run(machine.id, 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && (test -f ~/.ssh/id_ed25519_pg_peer || ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/id_ed25519_pg_peer)');
    publicKeys.set(machine.id, remote.capture(machine.id, "cat ~/.ssh/id_ed25519_pg_peer.pub").trim());
  }
  for (const machine of peers) {
    for (const [owner, key] of publicKeys) {
      if (owner === machine.id || !key) continue;
      const entry = `from="${fromList}" ${key}`;
      const body = key.split(" ")[1] ?? key;
      remote.run(machine.id, `mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qF ${shellQuote(body)} ~/.ssh/authorized_keys || printf '%s\\n' ${shellQuote(entry)} >> ~/.ssh/authorized_keys)`);
    }
  }
};

const ensureMarkers = (config: LabConfig, remote: LabRemote): void => {
  for (const machine of config.machines) {
    remote.run(machine.id, `command -v ssh >/dev/null && command -v rsync >/dev/null && install -D -m 0644 /dev/null ${shellQuote(config.lab.markerFile)}`, { sudo: true });
  }
};

const ensureObjectStore = (config: LabConfig, remote: LabRemote, secrets: LabSecrets): void => {
  const store = config.services.objectStore;
  if (!store || !store.provision) return;
  log(`provisioning MinIO on ${store.machine}:${store.port}`);
  const envFile = "/etc/pg-lab-minio.env";
  remote.write(store.machine, envFile, [
    `MINIO_ROOT_USER=${secrets.objectStoreAccessKey}`,
    `MINIO_ROOT_PASSWORD=${secrets.objectStoreSecretKey}`,
    `MC_HOST_lab=http://${secrets.objectStoreAccessKey}:${secrets.objectStoreSecretKey}@127.0.0.1:${store.port}`,
    "",
  ].join("\n"), 0o600, true);
  const image = shellQuote(store.image);
  remote.run(store.machine, [
    "command -v docker >/dev/null 2>&1 || (apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io)",
    "systemctl enable --now docker",
    "install -d -m 0750 /var/lib/pg-minio && chown -R 65532:65532 /var/lib/pg-minio",
    "docker rm -f pg-minio >/dev/null 2>&1 || true",
    `docker run -d --name pg-minio --restart unless-stopped -p ${store.port}:9000 --env-file ${envFile} -v /var/lib/pg-minio:/data ${image} server /data`,
    `for i in $(seq 1 30); do curl -fsS http://127.0.0.1:${store.port}/minio/health/live >/dev/null && exit 0; sleep 1; done; exit 1`,
  ].join(" && "), { sudo: true });
  remote.run(store.machine, `docker run --rm --network host --env-file ${envFile} -e MC_CONFIG_DIR=/tmp/.mc --entrypoint mc ${image} mb --ignore-existing ${shellQuote(`lab/${store.bucket}`)}`, { sudo: true });
};

/** Creates the per-topology vault directory (owned by the SSH user). */
export const ensureVaultDir = (config: LabConfig, remote: LabRemote, machineId: string, path: string): void => {
  remote.run(machineId, `install -d -m 0750 -o ${shellQuote(config.ssh.user)} -g ${shellQuote(config.ssh.user)} ${shellQuote(path)}`, { sudo: true });
};

export interface BootstrapResult {
  machines: MachineCheck[];
}

export const bootstrapLab = (config: LabConfig, remote: LabRemote, secrets: LabSecrets): BootstrapResult => {
  ensureOperatorKey(config);
  const machines = verifyMachines(config, remote);
  for (const check of machines) log(`${check.ok ? "OK  " : "FAIL"} ${check.machineId}: ${check.detail}`);
  const failed = machines.filter((check) => !check.ok);
  if (failed.length > 0) {
    throw new Error(`bootstrap stopped: ${failed.length}/${machines.length} machine(s) not reachable with key-based SSH + sudo (${failed.map((check) => check.machineId).join(", ")})`);
  }
  ensureMarkers(config, remote);
  ensurePeerKeys(config, remote);
  ensureObjectStore(config, remote, secrets);
  const vault = config.services.vault;
  if (vault) ensureVaultDir(config, remote, vault.machine, vault.basePath);
  return { machines };
};
