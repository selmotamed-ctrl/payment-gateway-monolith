import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LabHostsConfig } from "./types";

const DEFAULT_HOST_B = "10.209.250.205";
const MINIO_USER = "minioadmin";
const MINIO_PASSWORD = "minioadmin1234";
const MINIO_BUCKET = "pg-backups-test";

const log = (message: string): void => console.log(message);

const run = (command: string, args: string[], options: { input?: string; timeoutMs?: number } = {}): string => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input: options.input,
    timeout: options.timeoutMs ?? 10 * 60_000,
  });
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`);
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} failed (exit ${result.status}): ${(result.stderr ?? "").trim().slice(-2000)}`);
  }
  return result.stdout ?? "";
};

const sudo = (password: string, command: string): string =>
  run("sudo", ["-S", "-p", "", "bash", "-lc", command], { input: `${password}\n` });

export const discoverHostALanIp = (targetIp = DEFAULT_HOST_B): string => {
  const out = execFileSync("ip", ["-4", "route", "get", targetIp], { encoding: "utf8" });
  const match = /src\s+(\d+\.\d+\.\d+\.\d+)/.exec(out);
  if (!match?.[1]) {
    throw new Error(`Could not determine local LAN IP toward ${targetIp}: ${out}`);
  }
  return match[1];
};

export const discoverLabHosts = (overrides: Partial<LabHostsConfig> = {}): LabHostsConfig => {
  const hostBLanIp = overrides.hostBLanIp ?? DEFAULT_HOST_B;
  return {
    hostALanIp: overrides.hostALanIp ?? discoverHostALanIp(hostBLanIp),
    hostASshUser: overrides.hostASshUser ?? process.env.USER ?? "salem",
    hostASudoPass: overrides.hostASudoPass ?? process.env.LOCAL_SUDO_PASS ?? "1234",
    hostBLanIp,
    hostBSshUser: overrides.hostBSshUser ?? "salem",
    hostBSudoPass: overrides.hostBSudoPass ?? "1234",
    sshKeyPath: overrides.sshKeyPath ?? join(homedir(), ".ssh", "id_ed25519_pg_lab_matrix"),
  };
};

const ensureSshpass = (sudoPassword: string): void => {
  try {
    execFileSync("which", ["sshpass"], { stdio: "ignore" });
  } catch {
    log("installing sshpass on HOST_A");
    sudo(sudoPassword, "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y sshpass");
  }
};

const ensureKey = (keyPath: string): void => {
  if (existsSync(keyPath)) return;
  mkdirSync(join(homedir(), ".ssh"), { recursive: true, mode: 0o700 });
  run("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "pg-lab-matrix"]);
  chmodSync(keyPath, 0o600);
};

const appendAuthorizedKey = (keyPath: string, publicKey: string): void => {
  const authorized = join(homedir(), ".ssh", "authorized_keys");
  const existing = existsSync(authorized) ? readFileSync(authorized, "utf8") : "";
  if (!existing.split("\n").some((line) => line.trim() === publicKey.trim())) {
    writeFileSync(authorized, `${existing}${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${publicKey.trim()}\n`, { mode: 0o600 });
  }
  chmodSync(authorized, 0o600);
};

const sq = (value: string): string => `'${value.replace(/'/g, `'\''`)}'`;

const ssh = (lab: LabHostsConfig, host: string, user: string, command: string, sudoPassword?: string): string => {
  const args = [
    "-i", lab.sshKeyPath,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    `${user}@${host}`,
  ];
  if (sudoPassword !== undefined) {
    return run("ssh", [...args, `sudo -S -p '' bash -lc ${sq(command)}`], { input: `${sudoPassword}\n` });
  }
  return run("ssh", [...args, `bash -lc ${sq(command)}`]);
};

const remoteSudo = (lab: LabHostsConfig, host: string, user: string, password: string, command: string): string =>
  ssh(lab, host, user, command, password);

const ensureMinio = (lab: LabHostsConfig): void => {
  log(`provisioning MinIO S3 on HOST_B ${lab.hostBLanIp}:9000`);
  const install = [
    "command -v docker >/dev/null 2>&1 || (apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io)",
    "systemctl enable --now docker",
    "install -d -m 0755 /var/lib/pg-minio && chown -R 65532:65532 /var/lib/pg-minio",
    `docker rm -f pg-minio >/dev/null 2>&1 || true`,
    `docker run -d --name pg-minio --restart unless-stopped -p 9000:9000 -e MINIO_ROOT_USER=${MINIO_USER} -e MINIO_ROOT_PASSWORD=${MINIO_PASSWORD} -v /var/lib/pg-minio:/data cgr.dev/chainguard/minio:latest server /data`,
    "for i in $(seq 1 30); do curl -fsS http://127.0.0.1:9000/minio/health/live >/dev/null && exit 0; sleep 1; done; exit 1",
  ].join(" && ");
  remoteSudo(lab, lab.hostBLanIp, lab.hostBSshUser, lab.hostBSudoPass, install);
  const bucket = `docker run --rm --network host -e MC_CONFIG_DIR=/tmp/.mc --entrypoint sh cgr.dev/chainguard/minio:latest -c ${JSON.stringify(`mc alias set lab http://127.0.0.1:9000 ${MINIO_USER} ${MINIO_PASSWORD} && mc mb --ignore-existing lab/${MINIO_BUCKET}`)}`;
  remoteSudo(lab, lab.hostBLanIp, lab.hostBSshUser, lab.hostBSudoPass, bucket);
};

const ensureVault = (lab: LabHostsConfig): void => {
  log(`provisioning SSH backup vault on HOST_B ${lab.hostBLanIp}`);
  remoteSudo(
    lab,
    lab.hostBLanIp,
    lab.hostBSshUser,
    lab.hostBSudoPass,
    "install -d -m 0750 -o " + lab.hostBSshUser + " -g " + lab.hostBSshUser + " /var/backups/pg-secondary-vault /var/backups/pg-vault-t1 /var/backups/pg-vault-t3 /var/backups/pg-vault-t5 /var/backups/pg-vault-t6 /var/backups/pg-vault-t7 /var/backups/pg-vault-t8",
  );
  remoteSudo(
    lab,
    lab.hostALanIp,
    lab.hostASshUser,
    lab.hostASudoPass,
    "install -d -m 0750 -o " + lab.hostASshUser + " -g " + lab.hostASshUser + " /var/backups/pg-secondary-vault /var/backups/pg-vault-t2 /var/backups/pg-vault-t4",
  );
};

const verifyBidirectional = (lab: LabHostsConfig): void => {
  const localHostname = execFileSync("hostname", { encoding: "utf8" }).trim();
  const remote = ssh(lab, lab.hostBLanIp, lab.hostBSshUser, "hostname").trim();
  if (!remote) throw new Error("HOST_B SSH verification returned no hostname");
  // HOST_B -> HOST_A uses the peer key created during bootstrap.
  ssh(lab, lab.hostBLanIp, lab.hostBSshUser, `ssh -i ~/.ssh/id_ed25519_pg_peer -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${lab.hostASshUser}@${lab.hostALanIp} hostname`);
  log(`SSH verified: HOST_A ${localHostname} (${lab.hostALanIp}) <-> HOST_B ${remote} (${lab.hostBLanIp})`);
};

export const bootstrapSshAndLabAccess = (overrides: Partial<LabHostsConfig> = {}): LabHostsConfig => {
  const lab = discoverLabHosts(overrides);
  ensureKey(lab.sshKeyPath);
  const publicKey = readFileSync(`${lab.sshKeyPath}.pub`, "utf8").trim();

  // HOST_A accepts its own lab key.
  appendAuthorizedKey(lab.sshKeyPath, publicKey);
  log(`HOST_A LAN IP: ${lab.hostALanIp}`);

  ensureSshpass(lab.hostASudoPass);
  log(`authorizing lab key on HOST_B ${lab.hostBSshUser}@${lab.hostBLanIp}`);
  run("sshpass", [
    "-p", lab.hostBSudoPass,
    "ssh-copy-id", "-i", `${lab.sshKeyPath}.pub`,
    "-o", "StrictHostKeyChecking=no",
    `${lab.hostBSshUser}@${lab.hostBLanIp}`,
  ]);

  // A peer key on HOST_B lets Barman / pg_basebackup reach HOST_A without a
  // password. It is separate from the operator key and is authorized only on
  // HOST_A.
  ssh(
    lab,
    lab.hostBLanIp,
    lab.hostBSshUser,
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh && test -f ~/.ssh/id_ed25519_pg_peer || ssh-keygen -t ed25519 -N \"\" -f ~/.ssh/id_ed25519_pg_peer",
  );
  const hostBPubKey = ssh(lab, lab.hostBLanIp, lab.hostBSshUser, "cat ~/.ssh/id_ed25519_pg_peer.pub").trim();
  appendAuthorizedKey(lab.sshKeyPath, hostBPubKey);

  remoteSudo(lab, lab.hostBLanIp, lab.hostBSshUser, lab.hostBSudoPass, "command -v ssh >/dev/null && command -v rsync >/dev/null && install -m 0644 /dev/null /etc/pg-lab-matrix");
  remoteSudo(lab, lab.hostALanIp, lab.hostASshUser, lab.hostASudoPass, "command -v ssh >/dev/null && command -v rsync >/dev/null && install -m 0644 /dev/null /etc/pg-lab-matrix");

  ensureMinio(lab);
  ensureVault(lab);
  verifyBidirectional(lab);
  return lab;
};

export const labSshTarget = (lab: LabHostsConfig, host: string, user?: string) => ({
  host,
  port: 22,
  user: user ?? (host === lab.hostALanIp ? lab.hostASshUser : lab.hostBSshUser),
  keyPath: lab.sshKeyPath,
  sudoPassword: host === lab.hostALanIp ? lab.hostASudoPass : lab.hostBSudoPass,
});
