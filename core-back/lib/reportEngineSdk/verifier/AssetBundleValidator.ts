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
    const baseName = name.split("/").pop() ?? name;
    const internal = (entry as unknown as { _data?: { compressedSize?: number; uncompressedSize?: number } })._data;
    const compressed = internal?.compressedSize ?? 0;
    const uncompressed = internal?.uncompressedSize ?? 0;
    if (compressed > 0 && uncompressed / compressed > MAX_COMPRESSION_RATIO) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path: `assets.zip/${name}`,
        code: "ASSET_ZIP_BOMB_DETECTED",
        message: `Asset archive entry "${name}" has a compression ratio above ${MAX_COMPRESSION_RATIO}:1.`,
      });
      continue;
    }
    const buffer = await entry.async("nodebuffer");
    if (buffer.byteLength > params.maxSingleAssetBytes) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path: `assets.zip/${name}`,
        code: "ASSET_FILE_TOO_LARGE",
        message: `Asset "${name}" (${buffer.byteLength} bytes) exceeds the maximum allowed single-asset size (${params.maxSingleAssetBytes} bytes).`,
      });
      continue;
    }
    totalUncompressed += buffer.byteLength;
    if (totalUncompressed > params.maxZipBytes * 5) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path: "assets.zip",
        code: "ASSET_ZIP_UNCOMPRESSED_LIMIT",
        message: "Asset archive expands beyond the allowed uncompressed limit.",
      });
      break;
    }
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

export function parseCsvRows(text: string): Array<Record<string, unknown>> {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      const raw = cells[index] ?? "";
      const numeric = Number(raw);
      row[header] = raw !== "" && Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(raw) ? numeric : raw;
    });
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
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
