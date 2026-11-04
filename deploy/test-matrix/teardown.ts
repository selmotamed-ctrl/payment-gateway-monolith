import { LabRemote } from "./remote";
import type { LabHostsConfig } from "./types";

export interface TeardownOptions {
  removeData?: boolean;
  stopRedis?: boolean;
}

/**
 * Removes every lab-owned process, cluster, vhost and release tree before the
 * next topology. It never touches processes outside the `pg-` namespace.
 */
export const teardownTopology = (lab: LabHostsConfig, options: TeardownOptions = {}): void => {
  const remote = new LabRemote(lab, { verbose: true });
  for (const host of [lab.hostALanIp, lab.hostBLanIp]) {
    remote.stopPm2Prefix(host, "pg-");
    remote.run(host, "rm -f /etc/nginx/sites-enabled/pg-* /etc/nginx/sites-available/pg-* || true", { sudo: true });
    remote.run(host, "nginx -t >/dev/null 2>&1 && systemctl reload nginx || true", { sudo: true });
    if (options.removeData !== false) {
      remote.run(host, "rm -rf /var/www/pg-core /var/www/pg-admin /var/www/pg-merchant /var/www/pg-checkout /var/www/pg-fake-rails /opt/pg-backup-daemon /etc/pg-backup /var/lib/pg-backup /var/log/pg-backup || true", { sudo: true });
    }
    // Stop and remove every PostgreSQL 18 cluster created by the matrix.
    // The marker is written by bootstrapTwoMachineLab; without it this is not
    // a lab host and teardown must not drop clusters.
    const isLab = remote.capture(host, "test -f /etc/pg-lab-matrix && echo yes || true").trim() === "yes";
    if (isLab && remote.capture(host, "command -v pg_createcluster >/dev/null 2>&1 && echo debian || true").trim() !== "debian") {
      // Arch Linux lab clusters are custom systemd units, not pg_lsclusters.
      remote.run(host, "systemctl stop 'postgresql@18-*' 2>/dev/null || true", { sudo: true });
      remote.run(host, "systemctl disable 'postgresql@18-*' 2>/dev/null || true", { sudo: true });
      remote.run(host, "rm -f /etc/systemd/system/postgresql@18-*.service && systemctl daemon-reload", { sudo: true });
      if (options.removeData !== false) {
        remote.run(host, "rm -rf /var/lib/postgresql/18/* /etc/postgresql/18/*", { sudo: true });
      }
    }
    const clusters = !isLab || remote.capture(host, "command -v pg_createcluster >/dev/null 2>&1 && echo debian || true").trim() !== "debian"
      ? []
      : remote.capture(host, "pg_lsclusters -h 2>/dev/null | awk '{print $2}' || true")
        .split("\n").map((line) => line.trim()).filter(Boolean);
    for (const cluster of clusters) {
      remote.run(host, `pg_ctlcluster 18 ${cluster} stop --force 2>/dev/null || true`, { sudo: true });
      remote.run(host, `systemctl disable postgresql@18-${cluster} 2>/dev/null || true`, { sudo: true });
      if (options.removeData !== false) {
        remote.run(host, `pg_dropcluster 18 ${cluster} --stop 2>/dev/null || true`, { sudo: true });
      }
    }
    if (options.stopRedis !== false) {
      remote.run(host, "systemctl stop redis-server 2>/dev/null || true", { sudo: true });
    }
  }
};
