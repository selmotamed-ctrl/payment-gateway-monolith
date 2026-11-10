import { createHash } from "node:crypto";
import JSZip from "jszip";
import type { ReportDiagnostic } from "../types/diagnostics";
import { validateSafeHtmlAndScopedCss } from "./CssAndHtmlSanitizer";

export interface ExtractedAssetFile {
  assetKey: string;
  fileName: string;
  mimeType: string;
  sha256: string;
  bytes: number;
  buffer: Buffer;
  parsedComparisonRows?: Array<Record<string, unknown>>;
}

const MAX_FILES = 50;
const MAX_COMPRESSION_RATIO = 25;

/** Extracts a zip into a flat basename map, rejecting traversal, duplicate basenames and zip bombs. */
export async function extractZipAssetFiles(params: {
  zipBuffer: Buffer;
  maxZipBytes: number;
  maxSingleAssetBytes: number;
}): Promise<{ filesByName: Map<string, Buffer>; diagnostics: ReportDiagnostic[] }> {
  const diagnostics: ReportDiagnostic[] = [];
  const filesByName = new Map<string, Buffer>();
  if (params.zipBuffer.byteLength > params.maxZipBytes) {
    diagnostics.push({
      layer: 4,
      severity: "error",
      path: "assets.zip",
      code: "ASSET_ZIP_TOO_LARGE",
      message: `Asset archive (${params.zipBuffer.byteLength} bytes) exceeds the maximum allowed size (${params.maxZipBytes} bytes).`,
      aiFixHint: "Reduce the archive size or split the report assets.",
    });
    return { filesByName, diagnostics };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(params.zipBuffer);
  } catch (error) {
    diagnostics.push({
      layer: 4,
      severity: "error",
      path: "assets.zip",
      code: "INVALID_ZIP_ARCHIVE",
      message: `The asset archive could not be opened: ${(error as Error).message}`,
      aiFixHint: "Upload a valid .zip archive.",
    });
    return { filesByName, diagnostics };
  }

  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_FILES) {
    diagnostics.push({
      layer: 4,
      severity: "error",
      path: "assets.zip",
      code: "ASSET_ZIP_TOO_MANY_FILES",
      message: `Asset archive contains ${entries.length} files; the maximum is ${MAX_FILES}.`,
    });
    return { filesByName, diagnostics };
  }

  const totalCap = params.maxZipBytes * 5;
  let totalUncompressed = 0;
  for (const entry of entries) {
    const originalName = entry.name;
    const name = originalName.replace(/^\.\/+/, "");
    if (!name || name.includes("..") || name.startsWith("/") || name.includes("\\")) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path: `assets.zip/${originalName}`,
        code: "ASSET_PATH_TRAVERSAL_DETECTED",
        message: `Asset archive entry "${originalName}" contains forbidden path traversal characters.`,
        aiFixHint: "Use flat file names such as 'logo.svg' or 'fee-schedule.json'.",
      });
      continue;
    }
    if (isSymlinkEntry(entry)) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path: `assets.zip/${name}`,
        code: "ASSET_SYMLINK_FORBIDDEN",
        message: `Asset archive entry "${name}" is a symbolic link; links are not allowed in asset bundles.`,
        aiFixHint: "Replace the link with the real file.",
      });
      continue;
    }
    const baseName = name.split("/").pop() ?? name;
    // Header sizes are attacker-controlled, so they are only an early hint;
    // the real guard is the streaming byte counter below.
    const internal = (entry as unknown as { _data?: { compressedSize?: number; uncompressedSize?: number } })._data;
    const compressed = internal?.compressedSize ?? 0;
    const declaredUncompressed = internal?.uncompressedSize ?? 0;
    if (compressed > 0 && declaredUncompressed / compressed > MAX_COMPRESSION_RATIO) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path: `assets.zip/${name}`,
        code: "ASSET_ZIP_BOMB_DETECTED",
        message: `Asset archive entry "${name}" has a compression ratio above ${MAX_COMPRESSION_RATIO}:1.`,
      });
      continue;
    }
    const entryCap = Math.min(params.maxSingleAssetBytes, totalCap - totalUncompressed);
    const inflated = await inflateEntryWithCap(entry, entryCap);
    if (inflated.kind === "error") {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path: `assets.zip/${name}`,
        code: "INVALID_ZIP_ARCHIVE",
        message: `Asset archive entry "${name}" could not be inflated: ${inflated.message}`,
        aiFixHint: "Upload a valid .zip archive.",
      });
      continue;
    }
    if (inflated.kind === "over_cap") {
      if (entryCap < params.maxSingleAssetBytes) {
        diagnostics.push({
          layer: 4,
          severity: "error",
          path: "assets.zip",
          code: "ASSET_ZIP_UNCOMPRESSED_LIMIT",
          message: "Asset archive expands beyond the allowed uncompressed limit.",
        });
        break;
      }
      diagnostics.push({
        layer: 4,
        severity: "error",
        path: `assets.zip/${name}`,
        code: "ASSET_FILE_TOO_LARGE",
        message: `Asset "${name}" exceeds the maximum allowed single-asset size (${params.maxSingleAssetBytes} bytes).`,
      });
      continue;
    }
    const buffer = inflated.buffer;
    if (compressed > 0 && buffer.byteLength / compressed > MAX_COMPRESSION_RATIO) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path: `assets.zip/${name}`,
        code: "ASSET_ZIP_BOMB_DETECTED",
        message: `Asset archive entry "${name}" has a compression ratio above ${MAX_COMPRESSION_RATIO}:1.`,
      });
      continue;
    }
    totalUncompressed += buffer.byteLength;
    if (filesByName.has(baseName)) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path: `assets.zip/${originalName}`,
        code: "ASSET_DUPLICATE_BASENAME",
        message: `Asset archive contains more than one file named "${baseName}"; flat asset names must be unique.`,
        aiFixHint: "Rename one of the files or place only one copy in the archive.",
      });
      continue;
    }
    filesByName.set(baseName, buffer);
  }

  return { filesByName, diagnostics };
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function isSymlinkEntry(entry: JSZip.JSZipObject): boolean {
  const permissions = entry.unixPermissions;
  const numeric = typeof permissions === "string" ? Number.parseInt(permissions, 8) : permissions;
  return typeof numeric === "number" && Number.isFinite(numeric) && (numeric & S_IFMT) === S_IFLNK;
}

/**
 * Inflates one entry through JSZip's internal stream with a running byte
 * counter; the stream is paused and abandoned as soon as the cap is crossed,
 * so a zip bomb is never fully inflated in memory.
 */
function inflateEntryWithCap(
  entry: JSZip.JSZipObject,
  capBytes: number,
): Promise<{ kind: "ok"; buffer: Buffer } | { kind: "over_cap" } | { kind: "error"; message: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: { kind: "ok"; buffer: Buffer } | { kind: "over_cap" } | { kind: "error"; message: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let stream: JSZip.JSZipStreamHelper<Buffer>;
    try {
      // internalStream is public JSZip API (zipObject.js) but missing from its .d.ts.
      stream = (entry as unknown as {
        internalStream: (type: "nodebuffer") => JSZip.JSZipStreamHelper<Buffer>;
      }).internalStream("nodebuffer");
    } catch (error) {
      finish({ kind: "error", message: (error as Error).message });
      return;
    }
    stream
      .on("data", (chunk: Buffer) => {
        if (settled) return;
        total += chunk.byteLength;
        if (total > capBytes) {
          stream.pause();
          chunks.length = 0;
          finish({ kind: "over_cap" });
          return;
        }
        chunks.push(Buffer.from(chunk));
      })
      .on("error", (error: Error) => finish({ kind: "error", message: error.message }))
      .on("end", () => finish({ kind: "ok", buffer: Buffer.concat(chunks, total) }));
    stream.resume();
  });
}

export function verifyExtractedAssetsAgainstSpec(params: {
  requiredAssets: Array<{
    asset_key: string;
    file_name: string;
    mime_type: string;
    purpose?: "VISUAL_IMAGE" | "COMPARISON_BASELINE_DATA";
  }>;
  extractedFilesByName: Map<string, Buffer>;
  maxSingleAssetBytes: number;
}): {
  validAssets: ExtractedAssetFile[];
  diagnostics: ReportDiagnostic[];
} {
  const diagnostics: ReportDiagnostic[] = [];
  const validAssets: ExtractedAssetFile[] = [];

  for (let i = 0; i < params.requiredAssets.length; i++) {
    const req = params.requiredAssets[i]!;
    const path = `required_assets[${i}](${req.asset_key})`;

    if (req.file_name.includes("..") || req.file_name.startsWith("/") || req.file_name.includes("\\")) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path,
        code: "ASSET_PATH_TRAVERSAL_DETECTED",
        message: `Asset file name "${req.file_name}" contains forbidden path traversal characters.`,
        aiFixHint: "Use a flat file name such as 'logo.svg' or 'fee-schedule.json'.",
      });
      continue;
    }

    const lookup = findExtractedAsset(params.extractedFilesByName, req.file_name);
    if (lookup.ambiguous) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path,
        code: "ASSET_AMBIGUOUS_FILE_NAME",
        message: `Required asset "${req.file_name}" matches more than one archive file by case-insensitive name.`,
        aiFixHint: "Use one exact file name in the archive, or rename the duplicate files.",
      });
      continue;
    }
    const buf = lookup.buffer;
    if (!buf) {
      const available = [...params.extractedFilesByName.keys()].sort();
      diagnostics.push({
        layer: 4,
        severity: "error",
        path,
        code: "REQUIRED_ASSET_MISSING_FROM_ZIP",
        message: `Required asset "${req.file_name}" (key "${req.asset_key}") was not found in the uploaded .zip bundle. ${available.length > 0 ? `Archive entries found: ${available.join(", ")}.` : "No readable zip entries were attached."}`,
        aiFixHint: `Include "${req.file_name}" in the partnered .zip archive, attach the .zip to the Studio, or remove "${req.asset_key}" from required_assets.`,
      });
      continue;
    }

    if (buf.byteLength > params.maxSingleAssetBytes) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path,
        code: "ASSET_FILE_TOO_LARGE",
        message: `Asset "${req.file_name}" (${buf.byteLength} bytes) exceeds maximum allowed single-asset size (${params.maxSingleAssetBytes} bytes).`,
      });
      continue;
    }

    if (!matchesMagicBytes(buf, req.mime_type)) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path,
        code: "ASSET_MAGIC_BYTE_MISMATCH",
        message: `Asset "${req.file_name}" binary header does not match declared MIME type "${req.mime_type}".`,
      });
      continue;
    }

    let parsedComparisonRows: Array<Record<string, unknown>> | undefined;
    if (req.mime_type === "image/svg+xml") {
      const svgText = buf.toString("utf-8");
      const svgDiags = validateSafeHtmlAndScopedCss({ html: svgText, scopedCss: "", basePath: path });
      diagnostics.push(...svgDiags);
      if (svgDiags.length > 0) continue;
    } else if (req.mime_type === "application/json") {
      try {
        const parsed = JSON.parse(buf.toString("utf-8")) as unknown;
        if (!Array.isArray(parsed)) {
          diagnostics.push({
            layer: 4,
            severity: "error",
            path,
            code: "COMPARISON_JSON_ASSET_NOT_ARRAY",
            message: `Comparison baseline JSON asset "${req.file_name}" must be a JSON array of row objects.`,
          });
          continue;
        }
        parsedComparisonRows = parsed as Array<Record<string, unknown>>;
      } catch {
        diagnostics.push({
          layer: 4,
          severity: "error",
          path,
          code: "INVALID_JSON_ASSET",
          message: `Asset "${req.file_name}" is not valid UTF-8 JSON.`,
        });
        continue;
      }
    } else if (req.mime_type === "text/csv") {
      try {
        parsedComparisonRows = parseCsvRows(buf.toString("utf-8"));
      } catch {
        diagnostics.push({
          layer: 4,
          severity: "error",
          path,
          code: "INVALID_CSV_ASSET",
          message: `Asset "${req.file_name}" is not a valid CSV table.`,
        });
        continue;
      }
    }

    const sha256 = createHash("sha256").update(buf).digest("hex");
    validAssets.push({
      assetKey: req.asset_key,
      fileName: req.file_name,
      mimeType: req.mime_type,
      sha256,
      bytes: buf.byteLength,
      buffer: buf,
      parsedComparisonRows,
    });
  }

  return { validAssets, diagnostics };
}

function findExtractedAsset(
  files: Map<string, Buffer>,
  fileName: string,
): { buffer: Buffer | null; ambiguous: boolean } {
  const exact = files.get(fileName);
  if (exact) return { buffer: exact, ambiguous: false };
  const lower = fileName.toLowerCase();
  const matches = [...files.entries()].filter(([name]) => name.toLowerCase() === lower);
  if (matches.length === 1) return { buffer: matches[0]![1], ambiguous: false };
  if (matches.length > 1) return { buffer: null, ambiguous: true };
  return { buffer: null, ambiguous: false };
}

/**
 * Parses an RFC-4180 style CSV (quoted fields may contain commas, quotes and
 * newlines). Cells stay strings: "0012" is not coerced to 12 and large or
 * fractional amounts keep their exact text; numeric coercion happens only at
 * comparison time with decimal.js.
 */
export function parseCsvRows(text: string): Array<Record<string, string>> {
  const records = splitCsvRecords(text.replace(/^\uFEFF/, "")).filter(
    (record) => !(record.length === 1 && record[0]!.trim() === ""),
  );
  if (records.length === 0) return [];
  const headers = records[0]!.map((header) => header.trim());
  return records.slice(1).map((cells) => {
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? "";
    });
    return row;
  });
}

function splitCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(current);
      current = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      record.push(current);
      records.push(record);
      record = [];
      current = "";
    } else {
      current += char;
    }
  }
  if (quoted) throw new Error("CSV_UNTERMINATED_QUOTE");
  if (current !== "" || record.length > 0) {
    record.push(current);
    records.push(record);
  }
  return records;
}

function matchesMagicBytes(buf: Buffer, mimeType: string): boolean {
  if (buf.byteLength < 4) return false;
  switch (mimeType) {
    case "image/png":
      return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    case "image/jpeg":
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "image/webp":
      return buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";
    case "image/svg+xml":
      return buf.toString("utf-8", 0, 512).includes("<svg");
    case "application/json":
    case "text/csv":
      return true;
    default:
      return false;
  }
}
