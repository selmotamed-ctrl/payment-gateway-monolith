/**
 * Pure helpers for the Report Studio / Headers & Footers spec editors.
 * Kept free of Vue/Vuetify so they can be unit-tested in isolation.
 */

/** Client-side cap for the asset bundle, mirroring `host.globalLimits.maxAssetZipBytes` (15 MB). */
export const MAX_ASSET_ZIP_BYTES = 15 * 1024 * 1024;

export type JsonParseIssue = {
  /** Engine-independent message (English; translate with `t()` at the call site). */
  message: string;
  /** 0-based character offset of the first offending character. */
  offset: number;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
};

export const offsetToLineColumn = (text: string, offset: number): { line: number; column: number } => {
  const bounded = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < bounded; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: bounded - lineStart + 1 };
};

class JsonScanError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

/**
 * Minimal RFC 8259 scanner that only reports WHERE the first syntax error is. `JSON.parse` messages differ between
 * V8, SpiderMonkey and JavaScriptCore (JSC gives no position at all), so the location comes from this scanner.
 */
const scanJson = (text: string): void => {
  let index = 0;
  const fail = (message: string, at = index): never => {
    throw new JsonScanError(message, at);
  };
  const skipWhitespace = () => {
    while (index < text.length && " \t\n\r".includes(text[index]!)) index += 1;
  };
  const describe = () => (index >= text.length ? "Unexpected end of JSON" : "Unexpected character");

  const parseString = () => {
    index += 1; // opening quote
    while (index < text.length) {
      const char = text[index]!;
      if (char === '"') {
        index += 1;
        return;
      }
      if (char === "\\") {
        const next = text[index + 1];
        if (next === undefined) fail("Unterminated string", index);
        if (next === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) fail("Invalid unicode escape", index);
          index += 6;
          continue;
        }
        if (!'"\\/bfnrt'.includes(next!)) fail("Invalid escape sequence", index);
        index += 2;
        continue;
      }
      if (char.charCodeAt(0) < 0x20) fail("Control character in string", index);
      index += 1;
    }
    fail("Unterminated string", text.length);
  };

  const parseNumber = () => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (!match) fail("Invalid number");
    index += match![0].length;
  };

  const parseLiteral = (literal: string) => {
    if (text.startsWith(literal, index)) {
      index += literal.length;
      return;
    }
    fail(describe());
  };

  const parseValue = (): void => {
    skipWhitespace();
    const char = text[index];
    if (char === "{") return parseObject();
    if (char === "[") return parseArray();
    if (char === '"') return parseString();
    if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) return parseNumber();
    if (char === "t") return parseLiteral("true");
    if (char === "f") return parseLiteral("false");
    if (char === "n") return parseLiteral("null");
    fail(describe());
  };

  const parseObject = () => {
    index += 1;
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    while (true) {
      skipWhitespace();
      if (text[index] !== '"') fail(index >= text.length ? "Unexpected end of JSON" : "Expected a double-quoted property name");
      parseString();
      skipWhitespace();
      if (text[index] !== ":") fail("Expected ':' after property name");
      index += 1;
      parseValue();
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        skipWhitespace();
        if (text[index] === "}") fail("Trailing comma is not allowed");
        continue;
      }
      if (text[index] === "}") {
        index += 1;
        return;
      }
      fail(index >= text.length ? "Unexpected end of JSON" : "Expected ',' or '}' after property value");
    }
  };

  const parseArray = () => {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    while (true) {
      parseValue();
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        skipWhitespace();
        if (text[index] === "]") fail("Trailing comma is not allowed");
        continue;
      }
      if (text[index] === "]") {
        index += 1;
        return;
      }
      fail(index >= text.length ? "Unexpected end of JSON" : "Expected ',' or ']' after array element");
    }
  };

  parseValue();
  skipWhitespace();
  if (index < text.length) fail("Unexpected content after the JSON value");
};

/** Returns `null` for valid (or empty) JSON, otherwise the first syntax error with its line/column. */
export const findJsonParseIssue = (text: string): JsonParseIssue | null => {
  if (!text.trim()) return null;
  try {
    JSON.parse(text);
    return null;
  } catch (parseError) {
    try {
      scanJson(text);
    } catch (caught) {
      if (caught instanceof JsonScanError) {
        return { message: caught.message, offset: caught.offset, ...offsetToLineColumn(text, caught.offset) };
      }
    }
    // The scanner accepted what JSON.parse rejected (should not happen); report the engine message at 1:1.
    return { message: parseError instanceof Error ? parseError.message : String(parseError), offset: 0, line: 1, column: 1 };
  }
};

/** Number of lines in the editor text (at least 1). */
export const countLines = (text: string): number => {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) lines += 1;
  return lines;
};

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

/** `true` when an asset zip exceeds the 15 MB client-side cap. */
export const isAssetZipTooLarge = (file: { size: number } | null | undefined): boolean =>
  Boolean(file && file.size > MAX_ASSET_ZIP_BYTES);

export type LayerScore = {
  layer: number;
  name: string;
  passed: boolean;
  status?: string;
  errorCount: number;
  warningCount: number;
};

/** Normalised scorecard status; a SKIPPED layer is never reported as passed. */
export const layerStatus = (layer: LayerScore): "PASSED" | "FAILED" | "SKIPPED" => {
  const raw = String(layer.status ?? "").toUpperCase();
  if (raw === "SKIPPED") return "SKIPPED";
  if (raw === "FAILED") return "FAILED";
  if (raw === "PASSED") return "PASSED";
  return layer.passed ? "PASSED" : "FAILED";
};

export const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

export const downloadText = (filename: string, content: string, mime: string): void => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

/**
 * Maps the chrome list's `assetDataUrls` (keyed by `asset_key`) to the `file_name -> data URL` map the preview
 * expects. Keys that are already file names are kept.
 */
export const chromeAssetsByFileName = (
  assetDataUrls: Record<string, string> | null | undefined,
  requiredAssets: Array<{ asset_key?: string; file_name?: string }> | null | undefined,
): Record<string, string> => {
  const result: Record<string, string> = {};
  if (!assetDataUrls) return result;
  const fileNameByKey = new Map<string, string>();
  for (const asset of requiredAssets ?? []) {
    if (asset.asset_key && asset.file_name) fileNameByKey.set(asset.asset_key, asset.file_name);
  }
  for (const [key, url] of Object.entries(assetDataUrls)) {
    result[fileNameByKey.get(key) ?? key] = url;
  }
  return result;
};
