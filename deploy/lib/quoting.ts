/**
 * Shared quoting / escaping helpers for everything the deploy tooling renders
 * into shell scripts, SQL, pgbouncer files, .pgpass and env files.
 * Never hand-roll another copy of these.
 */

/** POSIX single-quote a value: the only safe way to interpolate into bash. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Throws when the value contains a NUL or a newline (cannot be encoded safely in line formats). */
export const assertSingleLine = (value: string, label: string): string => {
  if (/[\0\r\n]/.test(value)) throw new Error(`${label} must not contain NUL or newline characters`);
  return value;
};

/** SQL string literal: doubles single quotes, rejects NUL/newlines. Use for `PASSWORD '...'`. */
export const sqlLiteral = (value: string, label = "SQL value"): string => {
  assertSingleLine(value, label);
  // standard_conforming_strings is on by default (PG >= 9.1): backslashes are literal.
  return `'${value.replace(/'/g, "''")}'`;
};

/** SQL identifier (double-quoted). */
export const sqlIdent = (value: string, label = "SQL identifier"): string => {
  assertSingleLine(value, label);
  return `"${value.replace(/"/g, '""')}"`;
};

/** A dollar-quote delimiter that cannot occur inside `body`. */
export const dollarTag = (body: string): string => {
  let n = 0;
  let tag = "pgd";
  while (body.includes(`$${tag}$`)) tag = `pgd${++n}`;
  return `$${tag}$`;
};

/** Value for a double-quoted field in pgbouncer.ini / userlist.txt ("" escapes a quote). */
export const pgbouncerQuoted = (value: string, label = "pgbouncer value"): string =>
  `"${assertSingleLine(value, label).replace(/"/g, '""')}"`;

/** Escape a .pgpass field: `\` and `:` are backslash-escaped. */
export const pgpassField = (value: string, label = "pgpass field"): string =>
  assertSingleLine(value, label).replace(/\\/g, "\\\\").replace(/:/g, "\\:");

/**
 * Renders KEY='value' for a file that is BOTH sourced by bash and used as a
 * systemd EnvironmentFile (systemd understands single-quoted values, but not
 * the bash `'\''` idiom, so values containing a single quote are rejected).
 */
export const envAssign = (key: string, value: string): string => {
  assertSingleLine(value, key);
  if (value.includes("'")) throw new Error(`${key} must not contain a single quote (not portable between bash and systemd EnvironmentFile)`);
  return `${key}='${value}'`;
};
