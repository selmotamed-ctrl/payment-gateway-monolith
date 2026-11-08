import { parseDeployEnv } from "../lib/configSchema";

/**
 * Helpers that derive throw-away deploy environments from the operator's real
 * `deploy.env`: override a few keys, or re-route every SSH hop through a second
 * loopback address so the real ssh/sudo-over-ssh/rsync-over-ssh code path runs
 * on a single machine. The base file is never modified.
 */

/** Parsed exactly the way the deploy engine parses its own env file. */
export const parseEnv = (text: string): Map<string, string> => new Map(Object.entries(parseDeployEnv(text)));

/** The engine's dotenv format has no escapes: a quoted value ends at the next quote. */
const quote = (value: string): string => {
  if (/["\n\r]/.test(value)) throw new Error(`value cannot be written to a deploy env file (contains a quote or newline): ${value.slice(0, 20)}`);
  return `"${value}"`;
};

/** Replaces (or appends) `KEY="value"` lines. Existing trailing comments on the line are dropped. */
export const withOverrides = (text: string, overrides: Record<string, string>): string => {
  let out = text.endsWith("\n") ? text : `${text}\n`;
  for (const [key, value] of Object.entries(overrides)) {
    const line = new RegExp(`^${key}=.*$`, "m");
    out = line.test(out) ? out.replace(line, () => `${key}=${quote(value)}`) : `${out}${key}=${quote(value)}\n`;
  }
  return out;
};

/**
 * Re-routes every SSH hop to `sshHost` (default 127.0.0.2, a loopback address
 * that is not an interface address, so the runner takes the real ssh path)
 * while service/private addresses stay on 127.0.0.1.
 */
export const sshLoopbackEnv = (text: string, options: { sshHost?: string; keyPath: string }): string => {
  const sshHost = options.sshHost ?? "127.0.0.2";
  return text
    .replace(/^([A-Z_]+_SSH_HOST)="127\.0\.0\.1"/gm, `$1="${sshHost}"`)
    .replace(/(@)127\.0\.0\.1(:\d+:127\.0\.0\.1:\d+)/g, `$1${sshHost}$2`)
    .replace(/^([A-Z_]+_SSH_KEY_PATH)=".*"/gm, `$1="${options.keyPath}"`);
};

/** Rewrites `NODES="a@h:22:ip:4000"` into `count` nodes on consecutive ports (same host, distinct ports). */
export const scaleNodes = (text: string, variable: string, count: number, portStep = 10): string => {
  const current = parseEnv(text).get(variable);
  if (!current) throw new Error(`${variable} is not set`);
  const first = current.split(",")[0]!.trim();
  const match = /^([^@]+)@([^:]+):(\d+):([^:]+):(\d+)$/.exec(first);
  if (!match) throw new Error(`${variable} has an unexpected node format: ${first}`);
  const [, id, sshHost, sshPort, ip, port] = match;
  const base = id!.replace(/-\d+$/, "");
  const nodes = Array.from({ length: count }, (_, index) => `${base}-${index + 1}@${sshHost}:${sshPort}:${ip}:${Number(port) + index * portStep}`);
  return withOverrides(text, { [variable]: nodes.join(",") });
};
