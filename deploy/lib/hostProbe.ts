/**
 * Read-only host probe for `DEPLOY_MODE=auto`.
 *
 * `auto` used to behave like update mode: nothing was probed, so a brand-new host only failed late (rsync or
 * `bun install` on the first service), and on an edge host that was after core had already been migrated and
 * switched. The probe asks each host what it already has; a host with gaps is bootstrapped (the same steps as
 * `--fresh`, for that host only) and a host that is complete is left alone.
 */
export interface HostProbeNeeds {
  /** Edge hosts serve their portals through nginx; a core-only host does not need it. */
  nginx: boolean;
}

/** One `name=ok|missing` line per requirement; nothing is installed or changed. */
export const hostProbeScript = (needs: HostProbeNeeds): string =>
  [
    ...["rsync", "curl"].map((tool) => `command -v ${tool} >/dev/null 2>&1 && echo "${tool}=ok" || echo "${tool}=missing"`),
    ...(needs.nginx
      ? ['(command -v nginx >/dev/null 2>&1 || test -x /usr/sbin/nginx) && echo "nginx=ok" || echo "nginx=missing"']
      : []),
    'test -x /usr/local/bin/bun && echo "bun=ok" || echo "bun=missing"',
    'test -x "$HOME/.bun/bin/pm2" && echo "pm2=ok" || echo "pm2=missing"',
  ].join("; ");

/**
 * The requirements a host lacks, from the probe output. Output that contains no recognisable line (a failed SSH
 * command, an empty answer) is reported as `probe-failed`, never as "nothing is missing".
 */
export const bootstrapGaps = (output: string): string[] => {
  const missing: string[] = [];
  let recognised = 0;
  for (const line of output.split(/\r?\n/)) {
    const match = /^([a-z0-9_-]+)=(ok|missing)$/.exec(line.trim());
    if (!match) continue;
    recognised += 1;
    if (match[2] === "missing") missing.push(match[1]!);
  }
  return recognised === 0 ? ["probe-failed"] : missing;
};
