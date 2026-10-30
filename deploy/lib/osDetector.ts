import type { HostPlan } from "./hostPlanner";
import type { SshRunner } from "./sshRunner";

export type HostOs = "debian" | "arch" | "unknown";

/**
 * Detects the package manager of a target host.
 *
 * The deployment engine supports the Ubuntu/Debian servers the gateway was
 * originally written for AND Arch Linux workstations/servers. Detection is
 * driven by `/etc/os-release`, never by the hostname.
 */
export const detectHostOs = (runner: SshRunner, host: HostPlan): HostOs => {
  const raw = runner.capture(host.ssh, "cat /etc/os-release 2>/dev/null || true");
  const text = raw.toLowerCase();
  if (/(^|\n)id(_like)?=.*(arch|garuda|manjaro|endeavouros)/.test(text) || text.includes("pacman")) {
    return "arch";
  }
  if (text.includes("ubuntu") || text.includes("debian") || text.includes("linuxmint")) {
    return "debian";
  }
  // Fall back to the presence of the package manager.
  const hasPacman = runner.capture(host.ssh, "command -v pacman || true");
  if (hasPacman.trim().length > 0) return "arch";
  const hasApt = runner.capture(host.ssh, "command -v apt-get || true");
  if (hasApt.trim().length > 0) return "debian";
  return "unknown";
};

export const bootstrapPackagesCommand = (os: HostOs): string => {
  switch (os) {
    case "arch":
      return "pacman -Sy --noconfirm --needed nginx rsync ufw curl ca-certificates nodejs npm";
    case "debian":
      return "apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y nginx rsync ufw curl ca-certificates nodejs";
    default:
      return "";
  }
};

export const installPackageCommand = (os: HostOs, packages: string): string => {
  if (os === "arch") return `pacman -S --noconfirm --needed ${packages}`;
  if (os === "debian") return `DEBIAN_FRONTEND=noninteractive apt-get install -y ${packages}`;
  return "";
};
