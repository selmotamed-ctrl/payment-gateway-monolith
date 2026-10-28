import type { DeployConfig } from "./configSchema";
import type { FirewallRulePlan, HostPlan } from "./hostPlanner";
import type { SshRunner } from "./sshRunner";

/**
 * Host-aware UFW provisioning.
 *
 * The rules are derived from the plan (never hand-written per host), so a
 * 1-host staging box and a 5-host production cluster get the same policy. The
 * `ufw` calls are idempotent: a duplicate `ufw allow` is a no-op.
 */

export interface FirewallCommand {
  args: string[];
  description: string;
}

/** Turns one rule into the exact `ufw` invocations. */
export const ufwCommandsForRule = (rule: FirewallRulePlan): FirewallCommand[] => {
  if (!rule.fromCidrs || rule.fromCidrs.length === 0) {
    return [
      {
        args: ["allow", `${rule.port}/tcp`, "comment", rule.comment],
        description: `allow ${rule.port}/tcp from anywhere (${rule.comment})`,
      },
    ];
  }
  return rule.fromCidrs.map((cidr) => ({
    args: ["allow", "from", cidr, "to", "any", "port", String(rule.port), "proto", "tcp", "comment", rule.comment],
    description: `allow ${rule.port}/tcp from ${cidr} (${rule.comment})`,
  }));
};

/**
 * The base policy every host gets before its role rules. The default deny is
 * what makes the role rules meaningful: a port that is not explicitly allowed
 * is closed.
 */
export const baseUfwCommands = (): FirewallCommand[] => [
  { args: ["default", "deny", "incoming"], description: "deny all inbound by default" },
  { args: ["default", "allow", "outgoing"], description: "allow outbound" },
  { args: ["default", "deny", "routed"], description: "deny routed traffic" },
];

export interface FirewallPlan {
  hostKey: string;
  commands: FirewallCommand[];
}

/** Builds the complete ordered command list for one host. */
export const buildFirewallPlan = (host: HostPlan): FirewallPlan => {
  const commands = [...baseUfwCommands()];
  for (const rule of host.firewall) {
    commands.push(...ufwCommandsForRule(rule));
  }
  // Enable last, so a failed rule never leaves the host unreachable.
  commands.push({ args: ["--force", "enable"], description: "enable ufw" });
  return { hostKey: host.key, commands };
};

export interface ApplyFirewallOptions {
  runner: SshRunner;
  host: HostPlan;
  config: DeployConfig;
  dryRun?: boolean;
}

/**
 * Applies the firewall to one host.
 *
 * It refuses to run before SSH is proven reachable: enabling ufw on a host
 * where the SSH port is not allowed would lock the operator out. The SSH rule
 * is therefore always emitted first.
 */
export const applyFirewall = (options: ApplyFirewallOptions): FirewallPlan => {
  const plan = buildFirewallPlan(options.host);
  const sshRule = options.host.firewall.find((rule) => rule.port === options.host.ssh.port);
  if (!sshRule) {
    throw new Error(`Refusing to enable ufw on ${options.host.ssh.host}: no SSH rule (port ${options.host.ssh.port}) is planned`);
  }
  if (options.dryRun) {
    for (const command of plan.commands) {
      options.runner.run(options.host.ssh, `ufw ${command.args.map(quote).join(" ")}`, { sudo: true });
    }
    return plan;
  }
  // ufw may be absent on a minimal image; install it first.
  options.runner.run(options.host.ssh, "command -v ufw >/dev/null 2>&1 || (apt-get update -y && apt-get install -y ufw)", {
    sudo: true,
  });
  for (const command of plan.commands) {
    options.runner.run(options.host.ssh, `ufw ${command.args.map(quote).join(" ")}`, { sudo: true });
  }
  return plan;
};

/** Reads back the active rules so the deployment audit can print them. */
export const readFirewallStatus = (runner: SshRunner, host: HostPlan): string =>
  runner.capture(host.ssh, "ufw status verbose", { sudo: true });

const quote = (value: string): string =>
  /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
