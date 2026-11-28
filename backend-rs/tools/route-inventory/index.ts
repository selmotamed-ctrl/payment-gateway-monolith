/**
 * P0-T04 — route / error-code / environment inventory for the Rust/ntex port.
 *
 * The TypeScript backend is the source of truth for Track P. This tool reads the
 * TS sources and writes deterministic golden vectors that the Rust port (and CI)
 * consume:
 *
 *   routes.json       every core-back HTTP route, with its mount prefix, file:line,
 *                     auth guards, body parser and limits
 *   edge-routes.json  the same for admin-back, merchant-back and checkout-back
 *   error-codes.json  every `new ApiError(status, "CODE", ...)` call site grouped by
 *                     code + status
 *   env-schemas.json  every environment key each service reads/validates, plus the
 *                     Rust-only keys introduced by the port
 *
 * `--check` regenerates the inventories in memory and fails when a committed file
 * differs, which is the CI guard that keeps new TS routes reflected in the golden
 * vectors.
 *
 * Scanning is deliberately dependency-free: a small source masker (comments,
 * strings, template literals and regex literals) plus bracket-balanced argument
 * parsing. No TypeScript compiler API is used, so the tool runs with a bare Bun
 * install. The trade-offs are documented in README.md.
 *
 * Usage:
 *   bun backend-rs/tools/route-inventory/index.ts
 *   bun backend-rs/tools/route-inventory/index.ts --check
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TOOL_DIR, "..", "..", "..");
const OUT_DIR = join(REPO_ROOT, "backend-rs", "tests", "golden-vectors", "route-inventory");

const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Generic file helpers
// ---------------------------------------------------------------------------

const fileCache = new Map<string, string>();

const readSource = (absolute: string): string => {
  const cached = fileCache.get(absolute);
  if (cached !== undefined) return cached;
  const text = readFileSync(absolute, "utf8");
  fileCache.set(absolute, text);
  return text;
};

const relPath = (absolute: string): string => relative(REPO_ROOT, absolute).split(sep).join("/");

const IGNORED_DIRS = new Set(["node_modules", "test", "tests", "__tests__", "dist", "build", ".git", "coverage"]);

const walkTs = (absoluteDir: string, options: { skipTests?: boolean } = {}): string[] => {
  if (!existsSync(absoluteDir)) return [];
  const out: string[] = [];
  const stack = [absoluteDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const absolute = join(dir, entry);
      let stat;
      try {
        stat = statSync(absolute);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (IGNORED_DIRS.has(entry)) continue;
        if (options.skipTests && entry === "test") continue;
        stack.push(absolute);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      if (entry.endsWith(".d.ts")) continue;
      out.push(absolute);
    }
  }
  out.sort();
  return out;
};

// ---------------------------------------------------------------------------
// Source masker
//
// Returns a string with the same length as the input where comment bodies and
// the contents of strings, template literals and regex literals are replaced by
// spaces (newlines are preserved). Identifiers, punctuation and keywords outside
// those regions survive, which makes call detection and bracket matching safe
// without a full parser.
// ---------------------------------------------------------------------------

const REGEX_PRECEDER = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "delete",
  "void",
  "instanceof",
  "new",
  "do",
  "else",
  "yield",
  "await",
]);

const maskSource = (source: string): string => {
  const out = source.split("");
  const length = source.length;
  let index = 0;
  let lastSignificant = "";
  let word = "";

  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < length; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  const flushWord = () => {
    if (word) {
      lastSignificant = word;
      word = "";
    }
  };

  while (index < length) {
    const char = source[index] as string;
    const next = source[index + 1];

    if (/[A-Za-z0-9_$]/.test(char)) {
      word += char;
      index += 1;
      continue;
    }
    flushWord();

    if (char === "/" && next === "/") {
      const start = index;
      while (index < length && source[index] !== "\n") index += 1;
      blank(start, index);
      continue;
    }

    if (char === "/" && next === "*") {
      const start = index;
      index += 2;
      while (index < length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index = Math.min(length, index + 2);
      blank(start, index);
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      const start = index;
      word = "";
      index += 1;
      while (index < length) {
        const current = source[index] as string;
        if (current === "\\") {
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          break;
        }
        // An unterminated string must not swallow the rest of the file.
        if (current === "\n") break;
        index += 1;
      }
      blank(start, index);
      lastSignificant = '"';
      continue;
    }

    if (char === "/" && (lastSignificant === "" || REGEX_PRECEDER.has(lastSignificant))) {
      const start = index;
      index += 1;
      let inClass = false;
      while (index < length) {
        const current = source[index] as string;
        if (current === "\\") {
          index += 2;
          continue;
        }
        if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) {
          index += 1;
          break;
        } else if (current === "\n") {
          break;
        }
        index += 1;
      }
      while (index < length && /[a-z]/.test(source[index] as string)) index += 1;
      blank(start, index);
      lastSignificant = "/";
      continue;
    }

    if (!/\s/.test(char)) lastSignificant = char;
    index += 1;
  }

  return out.join("");
};

// ---------------------------------------------------------------------------
// Line index and bracket helpers
// ---------------------------------------------------------------------------

interface LineMap {
  starts: number[];
  lineAt: (offset: number) => number;
  textAt: (line: number) => string;
  indentAt: (line: number) => number;
}

const buildLineMap = (source: string): LineMap => {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((starts[mid] as number) <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const lineStart = (line: number): number => starts[Math.max(0, Math.min(starts.length - 1, line - 1))] as number;
  const textAt = (line: number): string => {
    const start = lineStart(line);
    const end = line + 1 <= starts.length ? (starts[line] as number) - 1 : source.length;
    return source.slice(start, Math.max(start, end));
  };
  const indentAt = (line: number): number => {
    const text = textAt(line);
    const match = /^[ \t]*/.exec(text);
    return match ? match[0].replace(/\t/g, "  ").length : 0;
  };
  return { starts, lineAt, textAt, indentAt };
};

const findMatching = (masked: string, openIndex: number): number => {
  const open = masked[openIndex];
  const close = open === "(" ? ")" : open === "[" ? "]" : open === "{" ? "}" : "";
  if (!close) return -1;
  let depth = 0;
  for (let i = openIndex; i < masked.length; i += 1) {
    const char = masked[i];
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

interface Span {
  start: number;
  end: number;
}

const trimSpan = (source: string, span: Span): Span => {
  let start = span.start;
  let end = span.end;
  while (start < end && /\s/.test(source[start] as string)) start += 1;
  while (end > start && /\s/.test(source[end - 1] as string)) end -= 1;
  return { start, end };
};

/** Split `start..end` on commas that are not nested inside (), [] or {}. */
const splitTopLevel = (masked: string, start: number, end: number): Span[] => {
  const spans: Span[] = [];
  let depth = 0;
  let segmentStart = start;
  for (let i = start; i < end; i += 1) {
    const char = masked[i];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      spans.push({ start: segmentStart, end: i });
      segmentStart = i + 1;
    }
  }
  spans.push({ start: segmentStart, end });
  return spans;
};

// ---------------------------------------------------------------------------
// Router / mount graph
// ---------------------------------------------------------------------------

type RouterKind = "app" | "router";

interface RouterDecl {
  file: string;
  name: string;
  kind: RouterKind;
}

type PathKind = "literal" | "array" | "regex" | "dynamic";

interface PathSpec {
  kind: PathKind;
  values: string[];
  expression: string;
}

interface CallSite {
  receiver: string;
  method: string;
  line: number;
  endLine: number;
  text: string;
  args: Span[];
  /** Path taken from `router.route("/x").get(...)`. */
  chainedPath?: Span;
  chainedPathFile?: { source: string; masked: string };
  /** Template-literal paths expanded from an enclosing `for (const x of [...])`. */
  expandedPaths?: string[];
}

interface ImportBinding {
  spec: string;
  imported: string; // "default" for default imports, "*" for namespaces
}

type ExportBinding =
  | { kind: "local"; local: string }
  | { kind: "from"; spec: string; imported: string };

interface ParsedFile {
  absolute: string;
  relative: string;
  source: string;
  masked: string;
  lines: LineMap;
  routers: Map<string, RouterDecl>;
  imports: Map<string, ImportBinding>;
  exports: Map<string, ExportBinding>;
  calls: CallSite[];
  /** `const x = express.json({...})` style parser factories. */
  parserFactories: Map<string, "json" | "raw">;
  /** `const readX = requireAuthorities(...)` style guard aliases. */
  guardAliases: Map<string, string[]>;
}

const parsedFiles = new Map<string, ParsedFile>();

const ROUTER_DECL_RE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(express\s*\.\s*Router|Router|express)\s*\(/g;

const CALL_RE = /([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|all|use|route)\s*\(/g;

const unquote = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  if (trimmed[trimmed.length - 1] !== quote) return null;
  const inner = trimmed.slice(1, -1);
  if (quote === "`" && inner.includes("${")) return null;
  return inner.replace(/\\(u[0-9a-fA-F]{4}|["'`\\/bfnrt])/g, (_match, escape: string) => {
    if (escape.startsWith("u")) return String.fromCharCode(parseInt(escape.slice(1), 16));
    switch (escape) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      default:
        return escape;
    }
  });
};

const parsePathSpan = (parsed: Pick<ParsedFile, "source" | "masked">, span: Span): PathSpec => {
  const raw = parsed.source.slice(span.start, span.end);
  const trimmed = raw.trim();
  const expression = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;

  if (trimmed.startsWith("[")) {
    const innerStart = span.start + raw.indexOf("[") + 1;
    const innerEnd = span.start + raw.lastIndexOf("]");
    if (innerEnd > innerStart) {
      const values: string[] = [];
      for (const inner of splitTopLevel(parsed.masked, innerStart, innerEnd)) {
        const value = unquote(parsed.source.slice(inner.start, inner.end));
        if (value === null) return { kind: "dynamic", values: [], expression };
        values.push(value);
      }
      if (values.length > 0) return { kind: "array", values, expression };
    }
    return { kind: "dynamic", values: [], expression };
  }

  const literal = unquote(trimmed);
  if (literal !== null) {
    if (literal.includes("${")) return { kind: "dynamic", values: [], expression };
    return { kind: "literal", values: [literal], expression };
  }

  if (trimmed.startsWith("/") && /^\/(?:\\.|[^/\n])+\/[a-z]*$/.test(trimmed)) {
    return { kind: "regex", values: [trimmed], expression };
  }

  return { kind: "dynamic", values: [], expression };
};

const lineAtOffset = (lines: LineMap, offset: number): number => lines.lineAt(offset);

const cartesian = (lists: string[][]): string[][] => {
  let result: string[][] = [[]];
  for (const list of lists) {
    const next: string[][] = [];
    for (const prefix of result) for (const value of list) next.push([...prefix, value]);
    result = next;
  }
  return result;
};

/**
 * Resolve `` `/:id/${resource}` `` when it sits inside
 * `for (const resource of ["transactions", ...] as const) { ... }`.
 * This is the only dynamic path shape used by the TS backend today; every other
 * non-literal path is reported as unresolved.
 */
const loopValues = (parsed: ParsedFile, aroundOffset: number, name: string): string[] | null => {
  const pattern = new RegExp(`for\\s*\\(\\s*const\\s+${name}\\s+of\\s*\\[`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(parsed.masked)) !== null) {
    const bracketStart = match.index + match[0].length - 1;
    const bracketEnd = findMatching(parsed.masked, bracketStart);
    if (bracketEnd < 0) continue;
    const after = parsed.masked.slice(bracketEnd + 1, bracketEnd + 40);
    const body = /^\s*(?:as\s+const\s*)?\)\s*\{/.exec(after);
    if (!body) continue;
    const braceStart = bracketEnd + 1 + body[0].lastIndexOf("{");
    const braceEnd = findMatching(parsed.masked, braceStart);
    if (braceEnd < 0 || aroundOffset <= braceStart || aroundOffset >= braceEnd) continue;

    const values: string[] = [];
    for (const span of splitTopLevel(parsed.masked, bracketStart + 1, bracketEnd)) {
      const trimmed = trimSpan(parsed.source, span);
      const value = unquote(parsed.source.slice(trimmed.start, trimmed.end));
      if (value === null) return null;
      values.push(value);
    }
    return values.length > 0 ? values : null;
  }
  return null;
};

const expandTemplatePath = (parsed: ParsedFile, span: Span): string[] | null => {
  const raw = parsed.source.slice(span.start, span.end).trim();
  if (!raw.startsWith("`") || !raw.endsWith("`")) return null;
  const inner = raw.slice(1, -1);
  const names: string[] = [];
  for (const match of inner.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)) names.push(match[1] as string);
  if (names.length === 0) return null;
  const skeleton = inner.replace(/\$\{\s*[A-Za-z_$][\w$]*\s*\}/g, "\u0000");
  if (skeleton.includes("${")) return null;

  const valueLists: string[][] = [];
  for (const name of names) {
    const values = loopValues(parsed, span.start, name);
    if (values === null) return null;
    valueLists.push(values);
  }

  const expanded: string[] = [];
  for (const combination of cartesian(valueLists)) {
    let path = inner;
    names.forEach((name, index) => {
      path = path.replace(new RegExp(`\\$\\{\\s*${name}\\s*\\}`), combination[index] as string);
    });
    expanded.push(path);
  }
  return expanded;
};

const extractCalls = (parsed: ParsedFile): CallSite[] => {
  const calls: CallSite[] = [];
  const { source, masked, lines } = parsed;

  CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CALL_RE.exec(masked)) !== null) {
    const receiver = match[1] as string;
    const method = match[2] as string;
    const openParen = match.index + match[0].length - 1;
    const closeParen = findMatching(masked, openParen);
    if (closeParen < 0) continue;

    const spans = splitTopLevel(masked, openParen + 1, closeParen)
      .map((span) => trimSpan(source, span))
      .filter((span) => span.end > span.start);

    const line = lineAtOffset(lines, match.index);
    const expandedPaths = spans.length > 0 ? expandTemplatePath(parsed, spans[0] as Span) : null;

    if (method === "route") {
      // `router.route("/x").get(...)` — expand the chained verb calls.
      if (spans.length === 0) continue;
      const pathSpan = spans[0] as Span;
      let cursor = closeParen + 1;
      for (;;) {
        const rest = masked.slice(cursor, cursor + 80);
        const chained = /^\s*\.\s*(get|post|put|patch|delete|all)\s*\(/.exec(rest);
        if (!chained) break;
        const chainedMethod = chained[1] as string;
        const chainedOpen = cursor + chained[0].lastIndexOf("(");
        const chainedClose = findMatching(masked, chainedOpen);
        if (chainedClose < 0) break;
        const handlerSpans = splitTopLevel(masked, chainedOpen + 1, chainedClose)
          .map((span) => trimSpan(source, span))
          .filter((span) => span.end > span.start);
        const chainedLine = lineAtOffset(lines, cursor);
        calls.push({
          receiver,
          method: chainedMethod,
          line: chainedLine,
          endLine: lineAtOffset(lines, chainedClose),
          text: source.slice(cursor, chainedClose + 1),
          args: handlerSpans,
          chainedPath: pathSpan,
          chainedPathFile: { source, masked },
        });
        cursor = chainedClose + 1;
      }
      CALL_RE.lastIndex = Math.max(CALL_RE.lastIndex, closeParen + 1);
      continue;
    }

    const call: CallSite = {
      receiver,
      method,
      line,
      endLine: lineAtOffset(lines, closeParen),
      text: source.slice(match.index, closeParen + 1),
      args: spans,
    };
    if (expandedPaths) call.expandedPaths = expandedPaths;
    calls.push(call);
  }

  return calls;
};

const extractImports = (parsed: ParsedFile): void => {
  const importRe = /import\s+([^;]+?)\s+from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(parsed.source)) !== null) {
    const clause = match[1] as string;
    const spec = match[2] as string;
    const trimmed = clause.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("*")) {
      const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
      if (namespace) parsed.imports.set(namespace[1] as string, { spec, imported: "*" });
      continue;
    }

    if (trimmed.startsWith("{")) {
      const inner = trimmed.slice(1, trimmed.lastIndexOf("}"));
      for (const part of inner.split(",")) {
        const piece = part.trim();
        if (!piece) continue;
        const cleaned = piece.replace(/^type\s+/, "");
        const asMatch = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(cleaned);
        if (!asMatch) continue;
        const imported = asMatch[1] as string;
        const local = (asMatch[2] as string) ?? imported;
        parsed.imports.set(local, { spec, imported });
      }
      continue;
    }

    // default import, optionally followed by a named clause
    const defaultName = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(trimmed);
    if (defaultName) parsed.imports.set(defaultName[1] as string, { spec, imported: "default" });
    const namedIndex = trimmed.indexOf("{");
    if (namedIndex >= 0) {
      const inner = trimmed.slice(namedIndex + 1, trimmed.lastIndexOf("}"));
      for (const part of inner.split(",")) {
        const piece = part.trim().replace(/^type\s+/, "");
        if (!piece) continue;
        const asMatch = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(piece);
        if (!asMatch) continue;
        const imported = asMatch[1] as string;
        const local = (asMatch[2] as string) ?? imported;
        parsed.imports.set(local, { spec, imported });
      }
    }
  }
};

const extractExports = (parsed: ParsedFile): void => {
  const exportConstRe = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = exportConstRe.exec(parsed.source)) !== null) {
    parsed.exports.set(match[1] as string, { kind: "local", local: match[2] as string });
  }

  const exportDefaultRe = /export\s+default\s+([A-Za-z_$][\w$]*)\s*;/g;
  while ((match = exportDefaultRe.exec(parsed.source)) !== null) {
    parsed.exports.set("default", { kind: "local", local: match[1] as string });
  }

  const reExportRe = /export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  while ((match = reExportRe.exec(parsed.source)) !== null) {
    const spec = match[2] as string;
    for (const part of (match[1] as string).split(",")) {
      const piece = part.trim().replace(/^type\s+/, "");
      if (!piece) continue;
      const asMatch = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(piece);
      if (!asMatch) continue;
      const imported = asMatch[1] as string;
      const exported = (asMatch[2] as string) ?? imported;
      parsed.exports.set(exported, { kind: "from", spec, imported });
    }
  }

  const localExportRe = /export\s*\{([^}]*)\}\s*;/g;
  while ((match = localExportRe.exec(parsed.source)) !== null) {
    for (const part of (match[1] as string).split(",")) {
      const piece = part.trim().replace(/^type\s+/, "");
      if (!piece) continue;
      const asMatch = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(piece);
      if (!asMatch) continue;
      const local = asMatch[1] as string;
      const exported = (asMatch[2] as string) ?? local;
      parsed.exports.set(exported, { kind: "local", local });
    }
  }
};

/**
 * `const readBackups = requireAuthorities("security:read")` and
 * `const guard = requireAuthoritiesByMethod` are aliases for guards. Recording
 * them lets a route that passes `readBackups` as middleware report the guard.
 */
const extractGuardAliases = (parsed: ParsedFile): void => {
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(parsed.masked)) !== null) {
    const name = match[1] as string;
    const rhsStart = match.index + match[0].length;
    let depth = 0;
    let end = -1;
    for (let i = rhsStart; i < parsed.masked.length; i += 1) {
      const char = parsed.masked[i];
      if (char === "(" || char === "[" || char === "{") depth += 1;
      else if (char === ")" || char === "]" || char === "}") depth -= 1;
      else if (char === ";" && depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) continue;
    const rhs = parsed.masked.slice(rhsStart, end);
    if (rhs.includes("=>") || /\bfunction\b/.test(rhs)) continue;
    const labels = guardPatternLabels(rhs);
    if (labels.length > 0) parsed.guardAliases.set(name, [...new Set(labels)]);
  }
};

const parseFile = (absolute: string): ParsedFile => {
  const existing = parsedFiles.get(absolute);
  if (existing) return existing;

  const source = readSource(absolute);
  const masked = maskSource(source);
  const parsed: ParsedFile = {
    absolute,
    relative: relPath(absolute),
    source,
    masked,
    lines: buildLineMap(source),
    routers: new Map(),
    imports: new Map(),
    exports: new Map(),
    calls: [],
    parserFactories: new Map(),
    guardAliases: new Map(),
  };

  ROUTER_DECL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ROUTER_DECL_RE.exec(masked)) !== null) {
    const name = match[1] as string;
    const factory = (match[2] as string).replace(/\s+/g, "");
    parsed.routers.set(name, { file: absolute, name, kind: factory === "express" ? "app" : "router" });
  }

  const factoryRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:express\s*\.\s*)?(json|raw)\s*\(/g;
  while ((match = factoryRe.exec(masked)) !== null) {
    parsed.parserFactories.set(match[1] as string, match[2] as "json" | "raw");
  }

  extractImports(parsed);
  extractExports(parsed);
  extractGuardAliases(parsed);
  parsed.calls = extractCalls(parsed);

  parsedFiles.set(absolute, parsed);
  return parsed;
};

const resolveSpecifier = (fromFile: string, spec: string): string | null => {
  if (!spec.startsWith(".")) return null;
  let base = resolve(dirname(fromFile), spec);
  if (base.endsWith(".js")) base = `${base.slice(0, -3)}.ts`;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
};

const resolveExport = (
  file: string,
  exportName: string,
  seen: Set<string>,
): RouterDecl | null => {
  const key = `${file}#${exportName}`;
  if (seen.has(key)) return null;
  seen.add(key);

  const parsed = parseFile(file);
  const localRouter = parsed.routers.get(exportName);
  if (localRouter) return localRouter;

  const binding = parsed.exports.get(exportName);
  if (binding) {
    if (binding.kind === "local") return resolveLocalRouterName(file, binding.local, seen);
    const target = resolveSpecifier(file, binding.spec);
    if (!target) return null;
    return resolveExport(target, binding.imported, seen);
  }
  return null;
};

const resolveLocalRouterName = (
  file: string,
  name: string,
  seen: Set<string>,
): RouterDecl | null => {
  const parsed = parseFile(file);
  const local = parsed.routers.get(name);
  if (local) return local;

  const imported = parsed.imports.get(name);
  if (imported) {
    const target = resolveSpecifier(file, imported.spec);
    if (!target) return null;
    return resolveExport(target, imported.imported, seen);
  }
  return null;
};

const resolveRouterIdentifier = (file: string, identifier: string): RouterDecl | null =>
  resolveLocalRouterName(file, identifier, new Set());

const isBareIdentifier = (raw: string): boolean => /^[A-Za-z_$][\w$]*$/.test(raw.trim());

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const GUARD_ORDER = [
  "mtlsGuard",
  "requireAuthentication",
  "requireSession",
  "requireStaffPrincipal",
  "requireMerchantPrincipal",
  "requireAuthorities",
  "authorityGuard",
  "requireMerchantScope",
  "requireServiceIdentity",
  "requireApiToken",
  "makerChecker",
  "validate(zod)",
  "rawBody",
] as const;

interface GuardPattern {
  label: string;
  test: RegExp;
}

const GUARD_PATTERNS: GuardPattern[] = [
  { label: "mtlsGuard", test: /\brequireEdgeIdentity\b|\bmtlsGuard\b/ },
  { label: "requireAuthentication", test: /\brequireAuthentication\b/ },
  { label: "requireSession", test: /\brequireSession\b/ },
  { label: "requireStaffPrincipal", test: /\brequireStaffPrincipal\b/ },
  { label: "requireMerchantPrincipal", test: /\brequireMerchantPrincipal\b/ },
  { label: "requireAuthorities", test: /\brequireAuthorities\b(?!\s*ByMethod)/ },
  { label: "authorityGuard", test: /\brequireAuthoritiesByMethod\b|\bauthorityGuard\b|\bguard\s*\(/ },
  { label: "requireMerchantScope", test: /\brequireMerchantScope\b/ },
  { label: "requireServiceIdentity", test: /\brequireServiceIdentity\b/ },
  { label: "requireApiToken", test: /\brequireApiToken\b|\bauthenticateApiToken\b|\bverifyApiToken\b/ },
  { label: "makerChecker", test: /\bmakerChecker\b|\bassertCheckerIsNotMaker\b|\bactorFromRequest\b/ },
  { label: "validate(zod)", test: /\b(?:validate|validateBody|validateQuery|validateParams|parseOrThrow)\s*\(/ },
];

const CUSTOM_GUARD_RE = /\b([A-Za-z_$][\w$]*[Gg]uard)\b/g;
const KNOWN_GUARD_WORDS = new Set([
  "guard",
  "requireGuard",
  "merchantGuard",
  "kybGuard",
  "merchantKybGuard",
  "merchantOpsGuard",
  "authorityGuard",
  "mtlsGuard",
]);

const guardPatternLabels = (text: string): string[] => {
  const labels: string[] = [];
  for (const pattern of GUARD_PATTERNS) {
    if (pattern.test.test(text)) labels.push(pattern.label);
  }
  return labels;
};

const guardLabelsFromText = (text: string, aliases?: Map<string, string[]>): string[] => {
  const labels = guardPatternLabels(text);
  if (aliases) {
    for (const [alias, aliasLabels] of aliases) {
      if (new RegExp(`\\b${alias}\\b`).test(text)) labels.push(...aliasLabels);
    }
  }
  const custom = new Set<string>();
  CUSTOM_GUARD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CUSTOM_GUARD_RE.exec(text)) !== null) {
    const name = match[1] as string;
    if (KNOWN_GUARD_WORDS.has(name)) continue;
    if (labels.includes(name)) continue;
    if (aliases?.has(name)) continue;
    custom.add(name);
  }
  labels.push(...[...custom].sort());
  return labels;
};

const sortGuardLabels = (labels: Iterable<string>): string[] => {
  const unique = [...new Set(labels)];
  const known = new Map<string, number>(GUARD_ORDER.map((label, index) => [label, index]));
  return unique.sort((a, b) => {
    const ai = known.get(a) ?? Number.MAX_SAFE_INTEGER;
    const bi = known.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
};

interface GuardEntry {
  labels: string[];
  line: number;
  /** Absolute path prefixes the middleware is scoped to; null = every path. */
  prefixes: string[] | null;
}

// ---------------------------------------------------------------------------
// Body limits
// ---------------------------------------------------------------------------

interface RawRule {
  exact?: Record<string, number>;
  prefixes?: Record<string, number>;
  patterns?: Array<{ test: RegExp; bytes: number }>;
}

/**
 * Mirrors `core-back/lib/rawBody/index.ts`. That module is the only source of
 * truth and is kept in sync manually because its rules are runtime-computed.
 */
const CORE_RAW_RULE: RawRule = {
  exact: {
    "/internal/admin/reconciliation/upload": 100 * MB,
    "/internal/admin/assets/upload": 5 * MB,
    "/internal/merchant/onboarding/kyb-documents": 25 * MB,
  },
  prefixes: {
    "/internal/checkout/inbound": 25 * MB,
    "/internal/merchant/onboarding/kyb-documents": 25 * MB,
  },
  patterns: [
    { test: /^\/internal\/admin\/join-requests\/[^/]+\/kyb-documents$/, bytes: 25 * MB },
    { test: /^\/internal\/admin\/aml\/cases\/[^/]+\/evidence$/, bytes: 50 * MB },
    { test: /^\/internal\/admin\/disputes\/[^/]+\/attachments$/, bytes: 25 * MB },
    { test: /^\/internal\/merchant\/disputes\/[^/]+\/attachments$/, bytes: 25 * MB },
  ],
};

const rawLimitFor = (fullPath: string): number | null => {
  const exact = CORE_RAW_RULE.exact?.[fullPath];
  if (exact !== undefined) return exact;
  for (const [prefix, bytes] of Object.entries(CORE_RAW_RULE.prefixes ?? {})) {
    if (fullPath === prefix || fullPath.startsWith(`${prefix}/`)) return bytes;
  }
  for (const pattern of CORE_RAW_RULE.patterns ?? []) {
    if (pattern.test.test(fullPath)) return pattern.bytes;
  }
  return null;
};

/** App-level conditional JSON parsers (`express.json({limit})` chosen by path regex). */
const APP_JSON_RULES: Record<string, Array<{ test: RegExp; bytes: number }>> = {
  "core-back/index.ts": [
    { test: /^\/internal\/(admin|merchant)\/report-engine(\/|$)/, bytes: 24 * MB },
  ],
  "admin-back/index.ts": [
    { test: /^\/api\/v1\/admin\/(sandbox\/mirror\/)?report-engine(\/|$)/, bytes: 24 * MB },
  ],
  "merchant-back/index.ts": [
    { test: /^\/api\/v1\/merchant\/sandbox\/mirror\/report-engine(\/|$)/, bytes: 24 * MB },
  ],
  "checkout-back/index.ts": [],
};

interface ParserState {
  jsonDefaultBytes: number | null;
  jsonScoped: Array<{ prefix: string; bytes: number }>;
  rawEnabled: boolean;
  rawBytes: number | null;
}

const emptyParserState = (): ParserState => ({
  jsonDefaultBytes: null,
  jsonScoped: [],
  rawEnabled: false,
  rawBytes: null,
});

const parseLimitBytes = (expression: string, envDefaults: Map<string, number>): number | null => {
  const trimmed = expression.trim();
  const literal = /^["'](\d+)(mb|kb|b)?["']$/i.exec(trimmed);
  if (literal) {
    const value = Number(literal[1]);
    const unit = (literal[2] ?? "b").toLowerCase();
    if (unit === "mb") return value * MB;
    if (unit === "kb") return value * 1024;
    return value;
  }
  const direct = /^(\d[\d_]*)(?:\s*\*\s*(\d[\d_]*))?$/.exec(trimmed);
  if (direct) {
    const first = Number((direct[1] as string).replace(/_/g, ""));
    const second = direct[2] ? Number(direct[2].replace(/_/g, "")) : 1;
    return first * second;
  }
  const envRef = /^env\.([A-Z][A-Z0-9_]*)$/.exec(trimmed);
  if (envRef) return envDefaults.get(envRef[1] as string) ?? null;
  return null;
};

// ---------------------------------------------------------------------------
// Route inventory
// ---------------------------------------------------------------------------

interface RouteRow {
  method: string;
  fullPath: string | null;
  file: string;
  line: number;
  guards: string[];
  bodyLimit: "json" | "raw" | "none";
  rawLimitBytes?: number;
  tsOrigin: string;
  jsonLimitBytes?: number;
  guardsWindow?: string[];
  guardsInherited?: string[];
  mountChain?: string[];
  dynamic?: boolean;
  pathExpression?: string;
  service?: string;
}

interface InventoryContext {
  envDefaults: Map<string, number>;
  appDefaultJsonBytes: number;
  appFile: string;
  appFileRelative: string;
  service: string;
  rows: RouteRow[];
  visited: Set<string>;
  unresolved: Array<{ file: string; line: number; receiver: string; method: string; expression: string }>;
}

const normalisePath = (path: string): string => {
  const trimmed = path.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withSlash.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/")) return collapsed.slice(0, -1);
  return collapsed;
};

const joinPath = (prefix: string, path: string): string => {
  if (path === "/") return normalisePath(prefix || "/");
  const base = prefix === "/" || prefix === "" ? "" : prefix.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return normalisePath(`${base}${suffix}`);
};

const isPathPrefix = (prefix: string, fullPath: string): boolean => {
  if (prefix === "" || prefix === "/") return true;
  const normalised = normalisePath(prefix);
  return fullPath === normalised || fullPath.startsWith(`${normalised}/`);
};

const exportedRouterName = (router: RouterDecl): string => {
  const parsed = parseFile(router.file);
  for (const [exported, binding] of [...parsed.exports.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (exported === "default") continue;
    if (binding.kind !== "local") continue;
    if (binding.local === router.name) return exported;
  }
  return router.name;
};

const guardEntriesForPath = (entries: GuardEntry[], fullPath: string): string[] => {
  const labels: string[] = [];
  for (const entry of entries) {
    if (entry.prefixes !== null && !entry.prefixes.some((prefix) => isPathPrefix(prefix, fullPath))) continue;
    labels.push(...entry.labels);
  }
  return labels;
};

const maskedLineAt = (parsed: ParsedFile, line: number): string => {
  const starts = parsed.lines.starts;
  const start = starts[Math.max(0, Math.min(starts.length - 1, line - 1))] as number;
  const end = line < starts.length ? (starts[line] as number) - 1 : parsed.masked.length;
  return parsed.masked.slice(start, Math.max(start, end));
};

/**
 * Guards for one registration, taken from the same call (its first 20 lines, so
 * guards called at the top of an inline handler are included) and from the 15
 * preceding top-level lines (`router.use(requireAuthentication)` etc.). Lines
 * that are indented deeper than the registration belong to a neighbouring
 * handler and are ignored. Comments and string contents are masked out.
 */
const callGuardLabels = (parsed: ParsedFile, call: CallSite): string[] => {
  const labels: string[] = [];
  const last = Math.min(call.endLine, call.line + 19);
  for (let line = call.line; line <= last; line += 1) {
    labels.push(...guardLabelsFromText(maskedLineAt(parsed, line), parsed.guardAliases));
  }
  return labels;
};

const localGuardLabels = (parsed: ParsedFile, call: CallSite): string[] => {
  const baseIndent = parsed.lines.indentAt(call.line);
  const labels: string[] = [];
  for (let line = Math.max(1, call.line - 15); line < call.line; line += 1) {
    if (parsed.lines.indentAt(line) > baseIndent) continue;
    labels.push(...guardLabelsFromText(maskedLineAt(parsed, line), parsed.guardAliases));
  }
  labels.push(...callGuardLabels(parsed, call));
  return sortGuardLabels(labels);
};

interface ClassifiedUse {
  kind: "mount" | "middleware" | "parser";
  path: PathSpec | null;
  child: RouterDecl | null;
  parser?: { kind: "json" | "raw"; bytes: number | null; prefixes: string[] | null };
}

const classifyUse = (
  parsed: ParsedFile,
  call: CallSite,
  context: InventoryContext,
): ClassifiedUse => {
  let path: PathSpec | null = null;
  let handlerSpans = call.args;
  if (call.args.length > 0) {
    const first = parsePathSpan(parsed, call.args[0] as Span);
    if (first.kind !== "dynamic") {
      path = first;
      handlerSpans = call.args.slice(1);
    }
  }

  // Parser registration? (`express.json`, `express.raw`, a parser factory or a
  // raw-parser helper such as checkout-back's `getRawParser`).
  const parserKind = detectParserKind(parsed, call);
  if (parserKind) {
    let bytes: number | null = null;
    const limitMatch = /limit\s*:\s*([^,}]+)/.exec(call.text);
    if (limitMatch) {
      bytes = parseLimitBytes(limitMatch[1] as string, context.envDefaults);
      if (bytes === null) bytes = resolveConstantBytes(parsed, (limitMatch[1] as string).trim(), context.envDefaults);
    } else if (parserKind === "raw") {
      const fileLimit = /express\.raw\s*\(\s*\{[\s\S]*?limit\s*:\s*([^,}]+)/.exec(parsed.source);
      if (fileLimit) {
        bytes = parseLimitBytes(fileLimit[1] as string, context.envDefaults);
        if (bytes === null) bytes = resolveConstantBytes(parsed, (fileLimit[1] as string).trim(), context.envDefaults);
      }
    }
    if (parserKind === "json" && bytes === null) bytes = context.appDefaultJsonBytes;
    const prefixes = path ? path.values.map((value) => value) : null;
    return { kind: "parser", path, child: null, parser: { kind: parserKind, bytes, prefixes } };
  }

  for (const span of handlerSpans) {
    const expression = parsed.source.slice(span.start, span.end);
    if (!isBareIdentifier(expression)) continue;
    const router = resolveRouterIdentifier(parsed.absolute, expression.trim());
    if (router) return { kind: "mount", path, child: router };
  }

  return { kind: "middleware", path, child: null };
};

const detectParserKind = (parsed: ParsedFile, call: CallSite): "json" | "raw" | null => {
  if (/express\s*\.\s*json\s*\(/.test(call.text)) return "json";
  if (/express\s*\.\s*raw\s*\(/.test(call.text)) return "raw";
  for (const name of parsed.parserFactories.keys()) {
    if (new RegExp(`\\b${name}\\b`).test(call.text)) return parsed.parserFactories.get(name) as "json" | "raw";
  }
  if (/\brawBodyMiddleware\b|\brawParser\b|\bgetRawParser\b/i.test(call.text) && /express\s*\.\s*raw\s*\(/.test(parsed.source)) {
    return "raw";
  }
  return null;
};

const resolveConstantBytes = (
  parsed: ParsedFile,
  identifier: string,
  envDefaults: Map<string, number>,
): number | null => {
  if (!/^[A-Za-z_$][\w$]*$/.test(identifier)) return null;
  const pattern = new RegExp(`(?:const|let|var)\\s+${identifier}\\s*=\\s*([^;]+);`);
  const match = pattern.exec(parsed.source);
  if (!match) return null;
  return parseLimitBytes(match[1] as string, envDefaults);
};

const applyParser = (state: ParserState, parser: { kind: "json" | "raw"; bytes: number | null; prefixes: string[] | null }, absolutePrefixes: string[] | null): ParserState => {
  const next: ParserState = {
    jsonDefaultBytes: state.jsonDefaultBytes,
    jsonScoped: [...state.jsonScoped],
    rawEnabled: state.rawEnabled,
    rawBytes: state.rawBytes,
  };
  if (parser.kind === "json") {
    if (parser.prefixes && parser.prefixes.length > 0 && absolutePrefixes) {
      for (const prefix of absolutePrefixes) {
        next.jsonScoped.push({ prefix, bytes: parser.bytes ?? 0 });
      }
    } else {
      next.jsonDefaultBytes = parser.bytes;
    }
  } else {
    next.rawEnabled = true;
    if (parser.bytes !== null) next.rawBytes = parser.bytes;
  }
  return next;
};

const resolveBodyLimit = (
  row: Pick<RouteRow, "fullPath">,
  fullPath: string,
  parser: ParserState,
  context: InventoryContext,
): { bodyLimit: "json" | "raw" | "none"; rawLimitBytes?: number; jsonLimitBytes?: number } => {
  if (!row.fullPath) {
    // Dynamic paths still get the parser kind, but no path-specific rule.
    if (parser.rawEnabled && parser.jsonDefaultBytes === null) {
      return parser.rawBytes === null ? { bodyLimit: "raw" } : { bodyLimit: "raw", rawLimitBytes: parser.rawBytes };
    }
    if (parser.jsonDefaultBytes !== null) {
      return { bodyLimit: "json", jsonLimitBytes: parser.jsonDefaultBytes };
    }
    return { bodyLimit: "none" };
  }

  const rawBytes = context.service === "core-back" ? rawLimitFor(fullPath) : null;
  if (rawBytes !== null) return { bodyLimit: "raw", rawLimitBytes: rawBytes };

  if (parser.rawEnabled && parser.jsonDefaultBytes === null) {
    return parser.rawBytes === null ? { bodyLimit: "raw" } : { bodyLimit: "raw", rawLimitBytes: parser.rawBytes };
  }

  if (parser.jsonDefaultBytes === null) return { bodyLimit: "none" };

  let limit = parser.jsonDefaultBytes;
  for (const rule of APP_JSON_RULES[context.appFileRelative] ?? []) {
    if (rule.test.test(fullPath)) limit = Math.max(limit, rule.bytes);
  }
  for (const scoped of parser.jsonScoped) {
    if (scoped.bytes > 0 && isPathPrefix(scoped.prefix, fullPath)) limit = Math.max(limit, scoped.bytes);
  }
  return { bodyLimit: "json", jsonLimitBytes: limit };
};

const walkRouter = (
  router: RouterDecl,
  absolutePrefix: string,
  parserState: ParserState,
  inheritedGuards: GuardEntry[],
  mountChain: string[],
  depth: number,
  context: InventoryContext,
): void => {
  if (depth > 20) return;
  const parsed = parseFile(router.file);
  context.visited.add(router.file);
  const calls = parsed.calls
    .filter((call) => call.receiver === router.name)
    .sort((a, b) => a.line - b.line);

  const localGuards: GuardEntry[] = [];
  let state = parserState;

  for (const call of calls) {
    if (call.method === "use") {
      const classified = classifyUse(parsed, call, context);

      if (classified.kind === "parser") {
        let prefixes: string[] | null = null;
        if (classified.parser?.prefixes) {
          prefixes = classified.parser.prefixes.map((prefix) => joinPath(absolutePrefix, prefix));
        }
        state = applyParser(state, classified.parser as NonNullable<ClassifiedUse["parser"]>, prefixes);
        continue;
      }

      if (classified.kind === "mount" && classified.child && classified.path) {
        const childPrefixes = classified.path.values.map((value) => joinPath(absolutePrefix, value));
        const mountGuard: GuardEntry = { labels: callGuardLabels(parsed, call), line: call.line, prefixes: childPrefixes };
        for (let i = 0; i < classified.path.values.length; i += 1) {
          const childPrefix = childPrefixes[i] as string;
          walkRouter(
            classified.child,
            childPrefix,
            state,
            [...inheritedGuards, ...localGuards, mountGuard],
            [...mountChain, `${parsed.relative}:${call.line} ${childPrefix}`],
            depth + 1,
            context,
          );
        }
        continue;
      }

      if (classified.kind === "mount" && classified.child) {
        // `router.use(subRouter)` — mounted at the current prefix.
        const mountGuard: GuardEntry = { labels: callGuardLabels(parsed, call), line: call.line, prefixes: [absolutePrefix] };
        walkRouter(
          classified.child,
          absolutePrefix,
          state,
          [...inheritedGuards, ...localGuards, mountGuard],
          [...mountChain, `${parsed.relative}:${call.line} ${absolutePrefix}`],
          depth + 1,
          context,
        );
        continue;
      }

      const prefixes = classified.path
        ? classified.path.values.map((value) => joinPath(absolutePrefix, value))
        : null;
      localGuards.push({ labels: callGuardLabels(parsed, call), line: call.line, prefixes });
      continue;
    }

    // Route registration.
    let pathSpec: PathSpec;
    if (call.chainedPath && call.chainedPathFile) {
      pathSpec = parsePathSpan(call.chainedPathFile, call.chainedPath);
    } else if (call.args.length > 0) {
      pathSpec = parsePathSpan(parsed, call.args[0] as Span);
    } else {
      continue;
    }

    const paths = call.expandedPaths
      ?? (pathSpec.kind === "dynamic" || pathSpec.kind === "regex" ? [] : pathSpec.values);
    const guardSources = [...inheritedGuards, ...localGuards];
    const windowGuards = localGuardLabels(parsed, call);
    const tsOrigin = `${exportedRouterName(router)}.${call.method}`;

    for (const path of paths.length > 0 ? paths : [null]) {
      const fullPath = path === null ? null : joinPath(absolutePrefix, path);
      const inheritedLabels = fullPath === null
        ? sortGuardLabels(guardEntriesForPath(guardSources, absolutePrefix))
        : sortGuardLabels(guardEntriesForPath(guardSources, fullPath));
      const body = resolveBodyLimit({ fullPath }, fullPath ?? absolutePrefix, state, context);
      const guardLabels = [...windowGuards, ...inheritedLabels];
      if (body.bodyLimit === "raw") guardLabels.push("rawBody");

      const row: RouteRow = {
        method: call.method.toUpperCase(),
        fullPath,
        file: parsed.relative,
        line: call.line,
        guards: sortGuardLabels(guardLabels),
        bodyLimit: body.bodyLimit,
      };
      if (body.rawLimitBytes !== undefined) row.rawLimitBytes = body.rawLimitBytes;
      row.tsOrigin = tsOrigin;
      if (body.jsonLimitBytes !== undefined) row.jsonLimitBytes = body.jsonLimitBytes;
      row.guardsWindow = windowGuards;
      row.guardsInherited = inheritedLabels;
      row.mountChain = [...mountChain];
      if (fullPath === null) {
        row.dynamic = true;
        row.pathExpression = pathSpec.expression;
        context.unresolved.push({
          file: parsed.relative,
          line: call.line,
          receiver: call.receiver,
          method: call.method,
          expression: pathSpec.expression,
        });
      }
      context.rows.push(row);
    }
  }
};

const inventoryApp = (
  appFile: string,
  service: string,
  appDefaultJsonBytes: number,
  envDefaults: Map<string, number>,
  visited: Set<string>,
): { rows: RouteRow[]; unresolved: InventoryContext["unresolved"] } => {
  const parsed = parseFile(appFile);
  let appRouter: RouterDecl | null = null;
  for (const router of parsed.routers.values()) {
    if (router.kind === "app") {
      appRouter = router;
      break;
    }
  }
  if (!appRouter) {
    appRouter = resolveRouterIdentifier(appFile, "app");
  }
  if (!appRouter) {
    throw new Error(`route-inventory: no Express app found in ${relPath(appFile)}`);
  }

  const context: InventoryContext = {
    envDefaults,
    appDefaultJsonBytes,
    appFile,
    appFileRelative: relPath(appFile),
    service,
    rows: [],
    visited,
    unresolved: [],
  };

  walkRouter(appRouter, "", emptyParserState(), [], [], 0, context);
  return { rows: context.rows, unresolved: context.unresolved };
};

// ---------------------------------------------------------------------------
// Error-code inventory
// ---------------------------------------------------------------------------

interface ErrorCallSite {
  file: string;
  line: number;
  message: string | null;
}

interface ErrorCodeGroup {
  code: string;
  status: number;
  count: number;
  callSites: ErrorCallSite[];
}

const ERROR_SCAN_ROOTS = [
  "core-back",
  "admin-back",
  "merchant-back",
  "checkout-back",
  "fake-rails-back",
  "deploy/backup-daemon/src",
  "deploy/object-storage-daemon/src",
];

const scanErrorCodes = (): {
  groups: ErrorCodeGroup[];
  unresolved: Array<{ file: string; line: number; reason: string }>;
} => {
  const groups = new Map<string, ErrorCodeGroup>();
  const unresolved: Array<{ file: string; line: number; reason: string }> = [];

  for (const root of ERROR_SCAN_ROOTS) {
    for (const absolute of walkTs(join(REPO_ROOT, root), { skipTests: true })) {
      const source = readSource(absolute);
      if (!source.includes("ApiError(")) continue;
      const masked = maskSource(source);
      const lines = buildLineMap(source);

      const re = /\bnew\s+ApiError\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(masked)) !== null) {
        const openParen = match.index + match[0].length - 1;
        const closeParen = findMatching(masked, openParen);
        if (closeParen < 0) {
          unresolved.push({ file: relPath(absolute), line: lines.lineAt(match.index), reason: "unbalanced call" });
          continue;
        }
        const spans = splitTopLevel(masked, openParen + 1, closeParen)
          .map((span) => trimSpan(source, span))
          .filter((span) => span.end > span.start);

        if (spans.length < 2) {
          unresolved.push({ file: relPath(absolute), line: lines.lineAt(match.index), reason: "fewer than two arguments" });
          continue;
        }
        const statusRaw = source.slice((spans[0] as Span).start, (spans[0] as Span).end).trim();
        if (!/^\d{3}$/.test(statusRaw)) {
          unresolved.push({ file: relPath(absolute), line: lines.lineAt(match.index), reason: `dynamic status: ${statusRaw.slice(0, 60)}` });
          continue;
        }
        const code = unquote(source.slice((spans[1] as Span).start, (spans[1] as Span).end));
        if (code === null) {
          unresolved.push({ file: relPath(absolute), line: lines.lineAt(match.index), reason: "dynamic code" });
          continue;
        }
        const message = spans.length >= 3 ? unquote(source.slice((spans[2] as Span).start, (spans[2] as Span).end)) : null;

        const status = Number(statusRaw);
        const key = `${code}\u0000${status}`;
        const group = groups.get(key) ?? { code, status, count: 0, callSites: [] };
        group.callSites.push({ file: relPath(absolute), line: lines.lineAt(match.index), message });
        groups.set(key, group);
      }
    }
  }

  for (const group of groups.values()) {
    group.callSites.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
    group.count = group.callSites.length;
  }

  const sorted = [...groups.values()].sort((a, b) => (a.code === b.code ? a.status - b.status : a.code.localeCompare(b.code)));
  return { groups: sorted, unresolved };
};

// ---------------------------------------------------------------------------
// Environment inventory
// ---------------------------------------------------------------------------

interface EnvService {
  name: string;
  file: string;
}

const ENV_SERVICES: EnvService[] = [
  { name: "core-back", file: "core-back/lib/env/index.ts" },
  { name: "admin-back", file: "admin-back/lib/env/index.ts" },
  { name: "merchant-back", file: "merchant-back/lib/env/index.ts" },
  { name: "checkout-back", file: "checkout-back/lib/env/index.ts" },
  { name: "fake-rails-back", file: "fake-rails-back/lib/env/index.ts" },
  { name: "backup-daemon", file: "deploy/backup-daemon/src/config.ts" },
  { name: "object-storage-daemon", file: "deploy/object-storage-daemon/src/config.ts" },
];

const RUST_ONLY_ENV_KEYS = [
  "CREDENTIALS_DIRECTORY",
  "HTTP_WORKERS",
  "LOG_FORMAT",
  "METRICS_BIND",
  "PG_STATEMENT_CACHE",
  "WORKER_RUNTIME_THREADS",
];

const ENV_KEY_RE = /^([A-Z][A-Z0-9_]{1,80})\s*:/;
const PROCESS_ENV_DOT_RE = /process\.env\.([A-Z][A-Z0-9_]{1,80})\b/g;
const PROCESS_ENV_INDEX_RE = /process\.env\[["']([A-Z][A-Z0-9_]{1,80})["']\]/g;
const ENV_PROPERTY_RE = /\benv\.([A-Z][A-Z0-9_]{1,80})\b/g;

/** Keys declared directly inside the zod env/object literal, plus their numeric defaults. */
const schemaKeysAndDefaults = (source: string): { keys: string[]; defaults: Map<string, number> } => {
  const keys: string[] = [];
  const defaults = new Map<string, number>();
  const masked = maskSource(source);

  let firstBrace = -1;
  for (const marker of ["z.strictObject", "z.object", ".object"]) {
    const index = masked.indexOf(marker);
    if (index < 0) continue;
    const braceIndex = masked.indexOf("{", index);
    if (braceIndex < 0) continue;
    const close = findMatching(masked, braceIndex);
    if (close < 0) continue;
    firstBrace = braceIndex;
    const lastBrace = close;
    // Walk line by line inside the object literal, tracking brace depth.
    const segment = masked.slice(braceIndex, lastBrace + 1);
    let depth = 0;
    const lines = segment.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      const atKeyDepth = depth === 1;
      if (atKeyDepth) {
        const keyMatch = ENV_KEY_RE.exec(line.trim());
        if (keyMatch) {
          const key = keyMatch[1] as string;
          keys.push(key);
          const defaultMatch = /\.default\(\s*([0-9][0-9_]*)(?:\s*\*\s*([0-9][0-9_]*))?\s*\)/.exec(line);
          if (defaultMatch) {
            const first = Number((defaultMatch[1] as string).replace(/_/g, ""));
            const second = defaultMatch[2] ? Number(defaultMatch[2].replace(/_/g, "")) : 1;
            defaults.set(key, first * second);
          }
        }
      }
      for (const char of line) {
        if (char === "{") depth += 1;
        else if (char === "}") depth -= 1;
      }
    }
    if (keys.length > 0) break;
  }

  // `default(1024 * 1024)` may also follow a key on a later line; a small
  // second pass catches the common multi-line schemas (`z\n .object({ ... })`).
  if (firstBrace >= 0) {
    for (const key of keys) {
      if (defaults.has(key)) continue;
      const pattern = new RegExp(`\\b${key}\\s*:[\\s\\S]{0,400}?\\.default\\(\\s*([0-9][0-9_]*)(?:\\s*\\*\\s*([0-9][0-9_]*))?\\s*\\)`);
      const match = pattern.exec(masked);
      if (!match) continue;
      const first = Number((match[1] as string).replace(/_/g, ""));
      const second = match[2] ? Number(match[2].replace(/_/g, "")) : 1;
      defaults.set(key, first * second);
    }
  }

  return { keys, defaults };
};

const scanEnv = (): {
  serviceKeys: Map<string, string[]>;
  defaultsByService: Map<string, Map<string, number>>;
} => {
  const serviceKeys = new Map<string, string[]>();
  const defaultsByService = new Map<string, Map<string, number>>();

  for (const service of ENV_SERVICES) {
    const absolute = join(REPO_ROOT, service.file);
    if (!existsSync(absolute)) {
      serviceKeys.set(service.name, []);
      defaultsByService.set(service.name, new Map());
      continue;
    }
    const source = readSource(absolute);
    const found = new Set<string>();

    for (const match of source.matchAll(PROCESS_ENV_DOT_RE)) found.add(match[1] as string);
    for (const match of source.matchAll(PROCESS_ENV_INDEX_RE)) found.add(match[1] as string);
    for (const match of source.matchAll(ENV_PROPERTY_RE)) found.add(match[1] as string);

    const schema = schemaKeysAndDefaults(source);
    for (const key of schema.keys) found.add(key);

    serviceKeys.set(service.name, [...found].sort());
    defaultsByService.set(service.name, schema.defaults);
  }

  serviceKeys.set("rust-only", [...RUST_ONLY_ENV_KEYS].sort());
  return { serviceKeys, defaultsByService };
};

// ---------------------------------------------------------------------------
// Output + check mode
// ---------------------------------------------------------------------------

interface Inventory {
  routes: RouteRow[];
  edgeRoutes: RouteRow[];
  errorCodes: ErrorCodeGroup[];
  envSchemas: Record<string, string[]>;
  unresolvedCore: InventoryContext["unresolved"];
  unresolvedEdges: InventoryContext["unresolved"];
  unresolvedErrors: Array<{ file: string; line: number; reason: string }>;
  unmountedRouterFiles: string[];
}

const sortRoutes = (rows: RouteRow[]): RouteRow[] =>
  [...rows].sort((a, b) => {
    const pathA = a.fullPath ?? "\uffff";
    const pathB = b.fullPath ?? "\uffff";
    if (pathA !== pathB) return pathA.localeCompare(pathB);
    if (a.method !== b.method) return a.method.localeCompare(b.method);
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });

const serviceOrder = ["admin-back", "merchant-back", "checkout-back"];

const ROUTE_SCAN_DIRS = ["core-back/api", "admin-back/api", "merchant-back/api", "checkout-back/api"];

const buildInventory = (): Inventory => {
  const env = scanEnv();
  const visited = new Set<string>();
  const core = inventoryApp(
    join(REPO_ROOT, "core-back/index.ts"),
    "core-back",
    MB,
    env.defaultsByService.get("core-back") ?? new Map(),
    visited,
  );

  const edges: RouteRow[] = [];
  const unresolvedEdges: InventoryContext["unresolved"] = [];
  for (const service of serviceOrder) {
    const appFile = join(REPO_ROOT, service, "index.ts");
    const serviceDefaults = env.defaultsByService.get(service) ?? new Map<string, number>();
    const appDefault = serviceDefaults.get("MAX_JSON_BODY_BYTES")
      ?? (service === "admin-back" ? 4 * MB : service === "merchant-back" ? 2 * MB : MB);
    const result = inventoryApp(appFile, service, appDefault, serviceDefaults, visited);
    for (const row of result.rows) {
      row.service = service;
      edges.push(row);
    }
    unresolvedEdges.push(...result.unresolved);
  }

  const unmountedRouterFiles: string[] = [];
  for (const dir of ROUTE_SCAN_DIRS) {
    for (const absolute of walkTs(join(REPO_ROOT, dir), { skipTests: true })) {
      const parsed = parseFile(absolute);
      if (parsed.routers.size === 0) continue;
      if (visited.has(absolute)) continue;
      unmountedRouterFiles.push(parsed.relative);
    }
  }

  const errors = scanErrorCodes();

  const envSchemas: Record<string, string[]> = {};
  for (const [service, keys] of env.serviceKeys) envSchemas[service] = keys;

  return {
    routes: sortRoutes(core.rows),
    edgeRoutes: sortRoutes(edges),
    errorCodes: errors.groups,
    envSchemas,
    unresolvedCore: core.unresolved,
    unresolvedEdges,
    unresolvedErrors: errors.unresolved,
    unmountedRouterFiles: unmountedRouterFiles.sort(),
  };
};

const outputs = (inventory: Inventory): Array<{ name: string; value: unknown }> => [
  { name: "routes.json", value: inventory.routes },
  { name: "edge-routes.json", value: inventory.edgeRoutes },
  { name: "error-codes.json", value: inventory.errorCodes },
  { name: "env-schemas.json", value: inventory.envSchemas },
];

const serialise = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const rowKey = (row: RouteRow): string => `${row.service ? `${row.service} ` : ""}${row.method} ${row.fullPath ?? "<dynamic>"}`;

const diffSummary = (name: string, generated: unknown, committed: unknown): string[] => {
  const lines: string[] = [];
  if (name === "env-schemas.json") {
    const generatedMap = generated as Record<string, string[]>;
    const committedMap = committed as Record<string, string[]>;
    for (const service of Object.keys(generatedMap)) {
      const committedKeys = new Set(committedMap[service] ?? []);
      const generatedKeys = new Set(generatedMap[service] ?? []);
      const added = [...generatedKeys].filter((key) => !committedKeys.has(key));
      const removed = [...committedKeys].filter((key) => !generatedKeys.has(key));
      if (added.length > 0) lines.push(`  ${service}: +${added.length} ${added.slice(0, 8).join(", ")}`);
      if (removed.length > 0) lines.push(`  ${service}: -${removed.length} ${removed.slice(0, 8).join(", ")}`);
    }
    for (const service of Object.keys(committedMap)) {
      if (!(service in generatedMap)) lines.push(`  ${service}: removed service`);
    }
    return lines;
  }

  if (name === "error-codes.json") {
    const generatedGroups = generated as ErrorCodeGroup[];
    const committedGroups = committed as ErrorCodeGroup[];
    const generatedKeys = new Set(generatedGroups.map((group) => `${group.code} ${group.status}`));
    const committedKeys = new Set(committedGroups.map((group) => `${group.code} ${group.status}`));
    const added = [...generatedKeys].filter((key) => !committedKeys.has(key));
    const removed = [...committedKeys].filter((key) => !generatedKeys.has(key));
    if (added.length > 0) lines.push(`  +${added.length} codes: ${added.slice(0, 8).join(", ")}`);
    if (removed.length > 0) lines.push(`  -${removed.length} codes: ${removed.slice(0, 8).join(", ")}`);
    const generatedSites = generatedGroups.reduce((sum, group) => sum + group.count, 0);
    const committedSites = committedGroups.reduce((sum, group) => sum + group.count, 0);
    if (generatedSites !== committedSites) {
      lines.push(`  call sites: generated ${generatedSites}, committed ${committedSites}`);
    }
    return lines;
  }

  const generatedRows = generated as RouteRow[];
  const committedRows = committed as RouteRow[];
  const generatedKeys = new Set(generatedRows.map(rowKey));
  const committedKeys = new Set(committedRows.map(rowKey));
  const added = [...generatedKeys].filter((key) => !committedKeys.has(key));
  const removed = [...committedKeys].filter((key) => !generatedKeys.has(key));
  lines.push(`  routes: generated ${generatedRows.length}, committed ${committedRows.length}`);
  if (added.length > 0) lines.push(`  +${added.length}: ${added.slice(0, 8).join(" | ")}`);
  if (removed.length > 0) lines.push(`  -${removed.length}: ${removed.slice(0, 8).join(" | ")}`);
  return lines;
};

const printSummary = (inventory: Inventory): void => {
  const byService = new Map<string, number>();
  for (const row of inventory.edgeRoutes) {
    byService.set(row.service as string, (byService.get(row.service as string) ?? 0) + 1);
  }
  const edgeText = serviceOrder.map((service) => `${service} ${byService.get(service) ?? 0}`).join(", ");
  const callSites = inventory.errorCodes.reduce((sum, group) => sum + group.count, 0);
  const envServices = Object.keys(inventory.envSchemas).length;

  console.log(
    `route-inventory: core ${inventory.routes.length} routes (${inventory.unresolvedCore.length} unresolved), ` +
      `edges ${edgeText} (${inventory.unresolvedEdges.length} unresolved)`,
  );
  console.log(
    `route-inventory: ${inventory.errorCodes.length} error code+status groups / ${callSites} call sites ` +
      `(${inventory.unresolvedErrors.length} dynamic), ${envServices} env schemas`,
  );

  if (inventory.unmountedRouterFiles.length > 0) {
    console.log("route-inventory: router files never mounted from an app (not in routes.json):");
    for (const file of inventory.unmountedRouterFiles) console.log(`  ${file}`);
  }

  if (inventory.unresolvedErrors.length > 0) {
    console.log("route-inventory: dynamic ApiError call sites (status/code not a literal):");
    for (const item of inventory.unresolvedErrors.slice(0, 10)) {
      console.log(`  ${item.file}:${item.line} ${item.reason}`);
    }
    if (inventory.unresolvedErrors.length > 10) {
      console.log(`  ... ${inventory.unresolvedErrors.length - 10} more`);
    }
  }

  const unresolved = [...inventory.unresolvedCore, ...inventory.unresolvedEdges];
  if (unresolved.length > 0) {
    console.log("route-inventory: dynamic route paths (not statically resolvable):");
    for (const item of unresolved.slice(0, 10)) {
      console.log(`  ${item.file}:${item.line} ${item.receiver}.${item.method}(${item.expression})`);
    }
    if (unresolved.length > 10) console.log(`  ... ${unresolved.length - 10} more`);
  }
};

const runCheck = (inventory: Inventory): number => {
  let failed = false;
  for (const output of outputs(inventory)) {
    const target = join(OUT_DIR, output.name);
    const generated = serialise(output.value);
    if (!existsSync(target)) {
      console.error(`route-inventory: ${output.name} is missing. Run: bun backend-rs/tools/route-inventory/index.ts`);
      failed = true;
      continue;
    }
    const committedText = readFileSync(target, "utf8");
    let committed: unknown;
    try {
      committed = JSON.parse(committedText);
    } catch (error) {
      console.error(`route-inventory: ${output.name} is not valid JSON: ${(error as Error).message}`);
      failed = true;
      continue;
    }
    if (JSON.stringify(committed) === JSON.stringify(output.value)) continue;

    failed = true;
    console.error(`route-inventory: ${output.name} is out of date.`);
    for (const line of diffSummary(output.name, output.value, committed)) console.error(line);
  }

  if (failed) {
    console.error("route-inventory: regenerate with `bun backend-rs/tools/route-inventory/index.ts` and commit the JSON.");
    return 1;
  }
  console.log("route-inventory: committed inventories are up to date.");
  return 0;
};

const USAGE = `Usage: bun backend-rs/tools/route-inventory/index.ts [--check]

  (no flag)  regenerate routes.json, edge-routes.json, error-codes.json, env-schemas.json
  --check    verify the committed files are up to date (CI guard, exit 1 on drift)
  --help     show this message

Output: backend-rs/tests/golden-vectors/route-inventory/`;

const main = (): number => {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const unknown = args.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    console.error(`route-inventory: unknown argument(s): ${unknown.join(" ")}`);
    console.error(USAGE);
    return 2;
  }
  const check = args.includes("--check");
  const inventory = buildInventory();
  printSummary(inventory);

  if (check) return runCheck(inventory);

  mkdirSync(OUT_DIR, { recursive: true });
  for (const output of outputs(inventory)) {
    const target = join(OUT_DIR, output.name);
    const text = serialise(output.value);
    const previous = existsSync(target) ? readFileSync(target, "utf8") : null;
    writeFileSync(target, text, "utf8");
    console.log(`route-inventory: wrote ${relPath(target)}${previous === text ? " (unchanged)" : ""}`);
  }
  return 0;
};

process.exit(main());
