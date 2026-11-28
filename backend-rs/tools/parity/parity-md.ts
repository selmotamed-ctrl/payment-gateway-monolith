/**
 * Generates the route parity table (`PARITY.md`) from the committed route inventory plus the
 * per-route status ledger (`status.json`).
 *
 * The inventory is the TS source of truth: 611 core routes (`routes.json`) and 544 edge routes
 * (`edge-routes.json`, three services). Three duplicate method+path rows in the inventory are
 * aliases of the same route and are collapsed into one row with an alias note.
 *
 * Status values (exactly these three):
 *   live-rs   the Rust implementation serves the route in a deployed release
 *   scaffold  the Rust binary has the route as a health/config stub (today: `/health` only)
 *   todo      not ported; the Rust service answers 501 or has no route
 *
 * `--check` fails when a route has no status entry, when a status value is unknown, or when the
 * generated markdown differs from the file on disk. `--seed-status` adds missing entries as
 * `todo` without changing existing ones, which keeps the ledger reviewable in a diff.
 *
 * Run:
 *   bun backend-rs/tools/parity/parity-md.ts --check
 *   bun backend-rs/tools/parity/parity-md.ts --seed-status --write
 *   bun backend-rs/tools/parity/parity-md.ts --out backend-rs/PARITY.md
 *
 * The default output lives next to the tool so this task does not overwrite the coordinator-owned
 * `backend-rs/PARITY.md`; pass `--out` when a release wants to publish the table there.
 */

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const INVENTORY_DIR = path.join(REPO_ROOT, "backend-rs", "tests", "golden-vectors", "route-inventory");
const DEFAULT_STATUS = path.join(import.meta.dir, "status.json");
const DEFAULT_OUTPUT = path.join(import.meta.dir, "PARITY.md");

export type RouteStatus = "live-rs" | "scaffold" | "todo";
export const ROUTE_STATUSES: readonly RouteStatus[] = ["live-rs", "scaffold", "todo"];

export interface InventoryRoute {
  method: string;
  fullPath: string;
  service?: string;
  file?: string;
  line?: number;
  tsOrigin?: string;
}

export interface RouteRow {
  service: string;
  rustTarget: string;
  method: string;
  path: string;
  aliases: number;
  tsFile?: string;
  tsLine?: number;
}

export interface StatusFile {
  version: number;
  description?: string;
  generatedFrom?: string[];
  statuses: Record<string, RouteStatus>;
  notes?: Record<string, string>;
}

const SERVICE_ORDER = ["core", "admin-back", "merchant-back", "checkout-back"] as const;

const RUST_TARGET: Record<string, string> = {
  core: "core-rs",
  "admin-back": "admin-edge",
  "merchant-back": "merchant-edge",
  "checkout-back": "checkout-edge",
};

export const statusKey = (service: string, method: string, routePath: string): string =>
  `${service} ${method.toUpperCase()} ${routePath}`;

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;

const loadRows = (inventoryDir: string): RouteRow[] => {
  const core = readJson<InventoryRoute[]>(path.join(inventoryDir, "routes.json"));
  const edge = readJson<InventoryRoute[]>(path.join(inventoryDir, "edge-routes.json"));
  const byKey = new Map<string, RouteRow>();
  const add = (service: string, route: InventoryRoute): void => {
    const key = statusKey(service, route.method, route.fullPath);
    const existing = byKey.get(key);
    if (existing) {
      existing.aliases += 1;
      return;
    }
    byKey.set(key, {
      service,
      rustTarget: RUST_TARGET[service] ?? service,
      method: route.method.toUpperCase(),
      path: route.fullPath,
      aliases: 1,
      tsFile: route.file,
      tsLine: route.line,
    });
  };
  for (const route of core) add("core", route);
  for (const route of edge) {
    add(route.service ?? "unknown", route);
  }
  return [...byKey.values()];
};

const sortRows = (rows: RouteRow[]): RouteRow[] => {
  const serviceIndex = (service: string): number => {
    const index = SERVICE_ORDER.indexOf(service as (typeof SERVICE_ORDER)[number]);
    return index === -1 ? SERVICE_ORDER.length : index;
  };
  return [...rows].sort((left, right) => {
    const service = serviceIndex(left.service) - serviceIndex(right.service);
    if (service !== 0) return service;
    if (left.service !== right.service) return left.service.localeCompare(right.service);
    if (left.path !== right.path) return left.path.localeCompare(right.path);
    return left.method.localeCompare(right.method);
  });
};

const loadStatuses = (file: string): StatusFile | null => {
  if (!fs.existsSync(file)) return null;
  const parsed = readJson<StatusFile>(file);
  if (!parsed || typeof parsed !== "object" || typeof parsed.statuses !== "object") {
    throw new Error(`${file}: expected { version, statuses: { ... } }`);
  }
  return parsed;
};

const isStatus = (value: unknown): value is RouteStatus =>
  typeof value === "string" && (ROUTE_STATUSES as readonly string[]).includes(value);

const validateStatuses = (file: StatusFile, source: string): string[] => {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(file.statuses)) {
    if (!isStatus(value)) {
      problems.push(`${source}: ${key} has invalid status ${JSON.stringify(value)}`);
    }
  }
  if (file.notes) {
    for (const [key, value] of Object.entries(file.notes)) {
      if (!(key in file.statuses)) problems.push(`${source}: note for unknown route ${key}`);
      if (typeof value !== "string") problems.push(`${source}: note for ${key} is not a string`);
    }
  }
  return problems;
};

const missingStatuses = (rows: RouteRow[], file: StatusFile | null): string[] => {
  if (!file) return rows.map((row) => statusKey(row.service, row.method, row.path));
  return rows
    .filter((row) => !(statusKey(row.service, row.method, row.path) in file.statuses))
    .map((row) => statusKey(row.service, row.method, row.path));
};

const staleStatuses = (rows: RouteRow[], file: StatusFile | null): string[] => {
  if (!file) return [];
  const known = new Set(rows.map((row) => statusKey(row.service, row.method, row.path)));
  return Object.keys(file.statuses).filter((key) => !known.has(key)).sort();
};

const statusFor = (row: RouteRow, file: StatusFile): RouteStatus =>
  file.statuses[statusKey(row.service, row.method, row.path)] ?? "todo";

const mdCell = (value: string): string => value.replaceAll("|", "\\|");

export const generateMarkdown = (rows: RouteRow[], file: StatusFile): string => {
  const counts = new Map<RouteStatus, number>(ROUTE_STATUSES.map((status) => [status, 0]));
  const byService = new Map<string, Map<RouteStatus, number>>();
  for (const row of rows) {
    const status = statusFor(row, file);
    counts.set(status, (counts.get(status) ?? 0) + 1);
    const service = byService.get(row.service) ?? new Map<RouteStatus, number>();
    service.set(status, (service.get(status) ?? 0) + 1);
    byService.set(row.service, service);
  }
  const services = [...byService.keys()].sort((a, b) => {
    const index = (value: string): number => {
      const at = SERVICE_ORDER.indexOf(value as (typeof SERVICE_ORDER)[number]);
      return at === -1 ? SERVICE_ORDER.length : at;
    };
    return index(a) - index(b) || a.localeCompare(b);
  });

  const lines: string[] = [];
  lines.push("# Rust/ntex route parity");
  lines.push("");
  lines.push("<!-- GENERATED FILE. Edit backend-rs/tools/parity/status.json and run:");
  lines.push("     bun backend-rs/tools/parity/parity-md.ts --write -->");
  lines.push("");
  lines.push(
    "Status comes from `backend-rs/tools/parity/status.json`. `live-rs` = served by Rust in a deployed release; " +
      "`scaffold` = health/config stub only; `todo` = not ported (Rust answers 501 or has no route).",
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Status | Routes |");
  lines.push("| :--- | ---: |");
  for (const status of ROUTE_STATUSES) {
    lines.push(`| \`${status}\` | ${counts.get(status) ?? 0} |`);
  }
  lines.push(`| **total** | **${rows.length}** |`);
  lines.push("");
  lines.push("| Service | Rust target | Routes | live-rs | scaffold | todo |");
  lines.push("| :--- | :--- | ---: | ---: | ---: | ---: |");
  for (const service of services) {
    const countsFor = byService.get(service)!;
    const total = [...countsFor.values()].reduce((sum, value) => sum + value, 0);
    lines.push(
      `| \`${service}\` | \`${RUST_TARGET[service] ?? service}\` | ${total} | ` +
        `${countsFor.get("live-rs") ?? 0} | ${countsFor.get("scaffold") ?? 0} | ${countsFor.get("todo") ?? 0} |`,
    );
  }
  lines.push("");
  for (const service of services) {
    const serviceRows = rows.filter((row) => row.service === service);
    lines.push(`## ${service} (${serviceRows.length} routes)`);
    lines.push("");
    lines.push("| Status | Method | Route | Rust target | TS origin | Notes |");
    lines.push("| :--- | :--- | :--- | :--- | :--- | :--- |");
    for (const row of serviceRows) {
      const key = statusKey(row.service, row.method, row.path);
      const status = statusFor(row, file);
      const notes: string[] = [];
      const configured = file.notes?.[key];
      if (configured) notes.push(configured);
      if (row.aliases > 1) notes.push(`${row.aliases} inventory aliases`);
      const origin = row.tsFile ? `${row.tsFile}:${row.tsLine ?? "?"}` : "";
      lines.push(
        `| \`${status}\` | \`${row.method}\` | \`${mdCell(row.path)}\` | \`${row.rustTarget}\` | \`${mdCell(origin)}\` | ${mdCell(notes.join("; "))} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
};

const mergeSeedStatuses = (rows: RouteRow[], file: StatusFile | null): StatusFile => {
  const statuses: Record<string, RouteStatus> = {};
  for (const row of rows) {
    const key = statusKey(row.service, row.method, row.path);
    const existing = file?.statuses[key];
    statuses[key] =
      existing ?? (row.path === "/health" ? "scaffold" : "todo");
  }
  const notes: Record<string, string> = {};
  for (const row of rows) {
    const key = statusKey(row.service, row.method, row.path);
    const existing = file?.notes?.[key];
    if (existing) notes[key] = existing;
    else if (row.path === "/health") {
      notes[key] = row.service === "core"
        ? "core-rs /health (health/config scaffold)"
        : `${row.rustTarget} /health (edge scaffold)`;
    }
  }
  const sortedStatuses: Record<string, RouteStatus> = {};
  for (const key of Object.keys(statuses).sort()) sortedStatuses[key] = statuses[key]!;
  const sortedNotes: Record<string, string> = {};
  for (const key of Object.keys(notes).sort()) sortedNotes[key] = notes[key]!;
  return {
    version: 1,
    description:
      "Per-route parity ledger: live-rs | scaffold | todo. Generated/checked by backend-rs/tools/parity/parity-md.ts.",
    generatedFrom: [
      "backend-rs/tests/golden-vectors/route-inventory/routes.json",
      "backend-rs/tests/golden-vectors/route-inventory/edge-routes.json",
    ],
    statuses: sortedStatuses,
    notes: sortedNotes,
  };
};

const writeJson = (file: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

export interface ParityMdOptions {
  inventoryDir?: string;
  statusFile?: string;
  output?: string;
  check?: boolean;
  seed?: boolean;
  write?: boolean;
  strict?: boolean;
  quiet?: boolean;
}

export interface ParityMdResult {
  rows: number;
  statuses: number;
  counts: Record<RouteStatus, number>;
  missing: string[];
  stale: string[];
  wroteStatus: boolean;
  wroteMarkdown: boolean;
  ok: boolean;
}

export const runParityMd = (options: ParityMdOptions = {}): ParityMdResult => {
  const inventoryDir = path.resolve(options.inventoryDir ?? INVENTORY_DIR);
  const statusFile = path.resolve(options.statusFile ?? DEFAULT_STATUS);
  const output = path.resolve(options.output ?? DEFAULT_OUTPUT);
  const rows = sortRows(loadRows(inventoryDir));
  let file = loadStatuses(statusFile);

  if (options.check && options.seed) {
    throw new Error("--check and --seed-status are mutually exclusive");
  }

  if (options.seed) {
    file = mergeSeedStatuses(rows, file);
    writeJson(statusFile, file);
  }

  const problems = file ? validateStatuses(file, statusFile) : [];
  const missing = missingStatuses(rows, file);
  const stale = staleStatuses(rows, file);
  const counts: Record<RouteStatus, number> = { "live-rs": 0, scaffold: 0, todo: 0 };
  if (file) {
    for (const row of rows) counts[statusFor(row, file)] += 1;
  }

  if (options.check && !file) {
    throw new Error(
      `${statusFile} is missing; run \`bun backend-rs/tools/parity/parity-md.ts --seed-status --write\``,
    );
  }
  if (options.check && missing.length > 0) {
    throw new Error(
      `${missing.length} route(s) have no status entry; first ${Math.min(missing.length, 10)}:\n` +
        missing.slice(0, 10).join("\n") +
        `\nRun \`bun backend-rs/tools/parity/parity-md.ts --seed-status --write\` and set the new routes.`,
    );
  }
  if (!options.check && file && !options.seed && missing.length > 0) {
    throw new Error(
      `${missing.length} route(s) have no status entry; run ` +
        "`bun backend-rs/tools/parity/parity-md.ts --seed-status --write` first (no table was written).",
    );
  }

  if (problems.length > 0) {
    const error = new Error(problems.slice(0, 20).join("\n"));
    (error as Error & { problems?: string[] }).problems = problems;
    throw error;
  }

  if (options.check) {
    if (!file) {
      throw new Error(`${statusFile} is missing`);
    }
    if (stale.length > 0 && options.strict) {
      throw new Error(
        `${stale.length} status entr(ies) do not match any inventory route; first 10:\n` +
          stale.slice(0, 10).join("\n"),
      );
    }
    const markdown = generateMarkdown(rows, file);
    if (!fs.existsSync(output)) {
      throw new Error(`${output} is missing; run \`bun backend-rs/tools/parity/parity-md.ts --write\``);
    }
    const current = fs.readFileSync(output, "utf8");
    if (current !== markdown) {
      throw new Error(`${output} is out of date; run \`bun backend-rs/tools/parity/parity-md.ts --write\``);
    }
    return {
      rows: rows.length,
      statuses: Object.keys(file.statuses).length,
      counts,
      missing,
      stale,
      wroteStatus: false,
      wroteMarkdown: false,
      ok: true,
    };
  }

  const writeStatus = Boolean(options.seed || options.write);
  const writeMarkdown = Boolean(options.write || options.seed);
  const effective = file ?? mergeSeedStatuses(rows, null);
  if (writeStatus && !file) writeJson(statusFile, effective);
  if (writeMarkdown) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, generateMarkdown(rows, effective), "utf8");
  }
  if (!file) {
    for (const row of rows) counts[statusFor(row, effective)] += 1;
  }
  return {
    rows: rows.length,
    statuses: Object.keys(effective.statuses).length,
    counts,
    missing,
    stale,
    wroteStatus: writeStatus,
    wroteMarkdown: writeMarkdown,
    ok: missing.length === 0,
  };
};

const HELP = `Usage: bun backend-rs/tools/parity/parity-md.ts [options]

Options:
  --check                 Fail on missing status entries or a stale PARITY.md (no writes).
  --write                 Write PARITY.md from the current status.json (add --seed-status for new routes).
  --seed-status           Add missing routes to status.json as todo (existing entries preserved).
  --status <file>         status.json path (default backend-rs/tools/parity/status.json).
  --out <file>            PARITY.md output (default backend-rs/tools/parity/PARITY.md).
  --inventory <dir>       Route inventory directory.
  --strict                Treat stale status entries as an error in --check.
  --quiet                 Suppress the summary line.
  --help
`;

interface CliOptions extends ParityMdOptions {
  help?: boolean;
  quiet?: boolean;
}

const parseCli = (argv: string[]): CliOptions => {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    const [flag, inline] = raw.startsWith("--") ? raw.split("=", 2) : [raw, undefined];
    const next = (): string => {
      if (inline !== undefined) return inline;
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };
    switch (flag) {
      case "--check":
        options.check = true;
        break;
      case "--write":
        options.write = true;
        break;
      case "--seed-status":
        options.seed = true;
        break;
      case "--status":
        options.statusFile = next();
        break;
      case "--out":
        options.output = next();
        break;
      case "--inventory":
        options.inventoryDir = next();
        break;
      case "--strict":
        options.strict = true;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option ${raw}`);
    }
  }
  return options;
};

const main = async (): Promise<number> => {
  let options: CliOptions;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    console.error(HELP);
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (!options.check && !options.write && !options.seed) {
    options.write = true;
  }
  try {
    const result = runParityMd(options);
    if (!options.quiet) {
      console.log(
        `routes ${result.rows}, statuses ${result.statuses} ` +
          `(live-rs ${result.counts["live-rs"]}, scaffold ${result.counts.scaffold}, todo ${result.counts.todo})` +
          (result.wroteStatus ? " — status.json written" : "") +
          (result.wroteMarkdown ? " — PARITY.md written" : "") +
          (options.check ? " — up to date" : ""),
      );
      if (result.stale.length > 0) {
        console.error(
          `warning: ${result.stale.length} status entr(ies) match no inventory route (use --strict to fail)`,
        );
      }
    }
    return 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
};

if (import.meta.main) {
  process.exitCode = await main();
}
