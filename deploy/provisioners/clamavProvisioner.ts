import { clamdManaged, type DeployConfig } from "../lib/configSchema";
import { ensurePackagesScript, isChanged, parseApplyOutcome, type ApplyOutcome, type ProvisionRunner } from "../lib/converge";
import type { SshTarget } from "../lib/hostPlanner";
import type { ProvisionReport } from "./postgres18Provisioner";

/**
 * ClamAV for the KYB document scan (AUTO-06, decision D5), installed and kept converged by the deploy engine.
 *
 * Every CORE host runs its own `clamd`, bound to the loopback interface only (`127.0.0.1:3310`): the `KybScanWorker`
 * runs on the core nodes, a document never leaves the host it is scanned on, and no firewall rule or inter-host trust
 * is needed. `freshclam` keeps the signatures current. The core env gets `KYB_CLAMD_ADDRESS=127.0.0.1:3310`
 * automatically; an operator who sets `KYB_CLAMD_ADDRESS` themselves points at their own daemon and nothing is
 * installed here (see `clamdManaged`).
 *
 * Idempotent: packages are installed only when missing, the configuration is rewritten only when it differs, the
 * daemon is restarted only when the configuration changed (or on `--force-restart`).
 */
export const CLAMD_PORT = 3310;
/** ClamAV needs roughly 1 to 1.5 GB of RAM for its signatures; below this the deploy warns. */
export const CLAMD_MIN_MEMORY_MB = 2048;
const CLAMD_CONF_PATH = "/etc/clamav/clamd.conf";
const MARKER = "__PG_CLAMD__=";

export interface ClamavProvisionInput {
  runner: ProvisionRunner;
  config: DeployConfig;
  /** The core hosts. */
  hosts: ReadonlyArray<{ ssh: SshTarget }>;
  dryRun?: boolean;
  /** Restart even when nothing changed (`--force-restart`). */
  forceRestart?: boolean;
}

/**
 * The effective clamd configuration. `StreamMaxLength` must be at least the KYB upload limit (25 MB): a smaller value
 * makes clamd answer `INSTREAM size limit exceeded` and the document would never leave PENDING. TCP is loopback only.
 */
export const clamdConfig = (): string => `# Managed by the payment gateway deploy engine (AUTO-06). Do not edit: the next deploy rewrites this file.
LogSyslog true
LogTime true
LogFacility LOG_LOCAL6
PidFile /run/clamav/clamd.pid
DatabaseDirectory /var/lib/clamav
LocalSocket /run/clamav/clamd.ctl
LocalSocketMode 660
FixStaleSocket true
TCPSocket ${CLAMD_PORT}
TCPAddr 127.0.0.1
User clamav
MaxThreads 12
MaxQueue 100
ReadTimeout 60
CommandReadTimeout 30
SendBufTimeout 200
StreamMaxLength 32M
MaxFileSize 32M
MaxScanSize 128M
MaxRecursion 16
MaxFiles 10000
ScanPE yes
ScanELF yes
ScanOLE2 yes
ScanPDF yes
ScanArchive yes
AlertEncrypted no
DetectPUA no
`;

/** Prints the host memory in MB (decided by the provisioner, which warns when it is too small). */
export const CLAMD_MEMORY_COMMAND = `awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo`;

/**
 * Converges the services: make sure a signature database exists first (clamd refuses to start without one), enable
 * the signature updater, disable Debian's socket-activation unit (it would own the sockets instead of the TCP bind in
 * the configuration), then start, restart on change, or leave alone. Prints `__PG_CLAMD__=no-database` and exits 0
 * when the first download failed (an offline lab): the updater keeps retrying and the platform monitor reports the
 * documents that stay PENDING, so the deploy does not fail on it.
 */
export const clamdApplyScript = (input: { changed: boolean; readySeconds?: number; readyCommand?: string }): string => {
  const seconds = input.readySeconds ?? 240;
  const ready = input.readyCommand
    ?? `bash -c 'exec 3<>/dev/tcp/127.0.0.1/${CLAMD_PORT} && printf "zPING\\\\0" >&3 && read -r -t 5 -d "" reply <&3 && [ "$reply" = PONG ]'`;
  return `set -u
has_db() { ls /var/lib/clamav/main.c?d >/dev/null 2>&1 || ls /var/lib/clamav/daily.c?d >/dev/null 2>&1; }
if ! has_db; then
  systemctl stop clamav-freshclam >/dev/null 2>&1 || true
  freshclam --quiet >/dev/null 2>&1 || true
fi
systemctl enable --now clamav-freshclam >/dev/null 2>&1 || true
if ! has_db; then
  echo ${MARKER}no-database
  exit 0
fi
systemctl disable --now clamav-daemon.socket >/dev/null 2>&1 || true
if ! systemctl is-active --quiet clamav-daemon; then
  systemctl enable clamav-daemon >/dev/null 2>&1 || true
  systemctl start clamav-daemon
  echo ${MARKER}started
elif [ ${input.changed ? 1 : 0} = 1 ]; then
  systemctl restart clamav-daemon
  echo ${MARKER}restarted
else
  echo ${MARKER}unchanged
fi
for i in $(seq 1 ${seconds}); do ${ready} >/dev/null 2>&1 && break; sleep 1; if [ "$i" = ${seconds} ]; then echo "clamd did not answer PING within ${seconds}s" >&2; exit 1; fi; done`;
};

/** `no-database` is its own outcome next to the usual ones. */
export const parseClamdOutcome = (output: string): ApplyOutcome | "no-database" =>
  new RegExp(`${MARKER}no-database`).test(output) ? "no-database" : parseApplyOutcome(output.replaceAll(MARKER, "__PG_APPLY__="));

export const provisionClamav = (input: ClamavProvisionInput): ProvisionReport => {
  const { runner, config } = input;
  const commands: string[] = [];
  const nodes: string[] = [];
  const outcomes: Record<string, ApplyOutcome> = {};
  const notes: string[] = [];
  if (!clamdManaged(config)) return { commands, nodes, outcomes, notes };
  for (const { ssh } of input.hosts) {
    nodes.push(ssh.host);
    const install = ensurePackagesScript({ debian: ["clamav-daemon", "clamav-freshclam"], arch: ["clamav"] });
    commands.push(install);
    runner.run(ssh, install, { sudo: true, timeoutMs: 15 * 60_000 });
    const memoryMb = Number(String(runner.capture(ssh, CLAMD_MEMORY_COMMAND, { sudo: false })).trim());
    if (Number.isFinite(memoryMb) && memoryMb > 0 && memoryMb < CLAMD_MIN_MEMORY_MB) {
      notes.push(`${ssh.host}: only ${memoryMb} MB of RAM; ClamAV needs about 1.5 GB for its signatures, expect memory pressure on this core host`);
    }
    const changed = isChanged(runner.writeRemoteFile({ target: ssh, path: CLAMD_CONF_PATH, content: clamdConfig(), mode: 0o644, sudo: true }));
    const script = clamdApplyScript({ changed: input.forceRestart === true || changed });
    commands.push(script);
    const output = String(runner.capture(ssh, script, { sudo: true, timeoutMs: 8 * 60_000 }));
    const outcome = parseClamdOutcome(output);
    if (outcome === "no-database") {
      outcomes[`${ssh.host}:clamav-daemon`] = "unknown";
      notes.push(`${ssh.host}: the first ClamAV signature download failed (offline host?). clamd was not started; freshclam keeps retrying. KYB documents stay PENDING until it succeeds (run the deploy again or check freshclam)`);
    } else {
      outcomes[`${ssh.host}:clamav-daemon`] = outcome;
    }
  }
  return { commands, nodes, outcomes, notes };
};
