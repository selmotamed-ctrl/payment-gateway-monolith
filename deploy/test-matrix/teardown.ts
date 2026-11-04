import type { LabConfig } from "./labConfig";
import { LabRemote } from "./remote";

export interface TeardownOptions {
  removeData?: boolean;
  stopRedis?: boolean;
  /** Restrict to these machine ids (default: every declared machine). */
  machines?: string[];
}

export interface TeardownReport {
  cleaned: string[];
  refused: string[];
}

/**
 * Removes every lab-owned process, vhost, release tree and PostgreSQL cluster
 * before the next topology. It never touches PM2 apps outside the `pg-`
 * namespace.
 *
 * Fix: the archived teardown removed PM2 apps, nginx vhosts and /var/www
 * release trees on any reachable host and only checked the lab marker before
 * dropping clusters. Every destructive step now requires the marker, and
 * unmarked hosts are reported as refused.
 */
export const teardownTopology = (config: LabConfig, remote: LabRemote, options: TeardownOptions = {}): TeardownReport => {
  const report: TeardownReport = { cleaned: [], refused: [] };
  const targets = config.machines.filter((machine) => !options.machines || options.machines.includes(machine.id));
  for (const machine of targets) {
    const host = machine.id;
    if (!remote.isMarkedLabHost(host)) {
      console.warn(`teardown refused on ${machine.id} (${machine.address}): ${config.lab.markerFile} is missing; run bootstrap first`);
      report.refused.push(machine.id);
      continue;
    }
    remote.stopPm2Prefix(host, "pg-");
    remote.run(host, "rm -f /etc/nginx/sites-enabled/pg-* /etc/nginx/sites-available/pg-* || true", { sudo: true });
    remote.run(host, "nginx -t >/dev/null 2>&1 && systemctl reload nginx || true", { sudo: true });
    if (options.removeData !== false) {
      remote.run(host, "rm -rf /var/www/pg-core /var/www/pg-admin /var/www/pg-merchant /var/www/pg-checkout /var/www/pg-fake-rails /opt/pg-backup-daemon /etc/pg-backup /var/lib/pg-backup /var/log/pg-backup || true", { sudo: true });
    }
    const debian = remote.capture(host, "command -v pg_createcluster >/dev/null 2>&1 && echo debian || true").trim() === "debian";
    if (!debian) {
      // Non-Debian lab clusters are custom systemd units, not pg_lsclusters.
      remote.run(host, "systemctl stop 'postgresql@18-*' 2>/dev/null || true", { sudo: true });
      remote.run(host, "systemctl disable 'postgresql@18-*' 2>/dev/null || true", { sudo: true });
      remote.run(host, "rm -f /etc/systemd/system/postgresql@18-*.service && systemctl daemon-reload", { sudo: true });
      if (options.removeData !== false) {
        remote.run(host, "rm -rf /var/lib/postgresql/18/* /etc/postgresql/18/*", { sudo: true });
      }
    } else {
      const clusters = remote.capture(host, "pg_lsclusters -h 2>/dev/null | awk '$1==\"18\"{print $2}' || true")
        .split("\n").map((line) => line.trim()).filter(Boolean);
      for (const cluster of clusters) {
        remote.run(host, `pg_ctlcluster 18 ${cluster} stop --force 2>/dev/null || true`, { sudo: true });
        remote.run(host, `systemctl disable postgresql@18-${cluster} 2>/dev/null || true`, { sudo: true });
        if (options.removeData !== false) {
          remote.run(host, `pg_dropcluster 18 ${cluster} --stop 2>/dev/null || true`, { sudo: true });
        }
      }
    }
    if (options.stopRedis !== false) {
      remote.run(host, "systemctl stop redis-server 2>/dev/null || systemctl stop valkey 2>/dev/null || true", { sudo: true });
    }
    report.cleaned.push(machine.id);
  }
  return report;
};
