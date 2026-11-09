import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReportAssetStoragePort } from "../../lib/reportEngineSdk/types/hostConfig";

const mimeFor = (fileName: string): string => {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
};

export class LocalReportAssetStorage implements ReportAssetStoragePort {
  private readonly baseDir: string;

  constructor(baseDir = process.env.REPORT_ASSET_STORAGE_DIR ?? path.join(process.cwd(), ".report-assets")) {
    this.baseDir = path.resolve(baseDir);
  }

  private safePath(bundleId: string, relativePath: string): string {
    const normalizedBundle = bundleId.replace(/[^a-zA-Z0-9_-]/g, "");
    const normalizedFile = path.basename(relativePath);
    if (!normalizedBundle || !normalizedFile || normalizedFile !== relativePath) {
      throw new Error("REPORT_ASSET_PATH_INVALID");
    }
    return path.join(this.baseDir, normalizedBundle, normalizedFile);
  }

  async storeAssetBundle(params: {
    bundleId: string;
    files: Array<{ relativePath: string; mimeType: string; sha256: string; buffer: Buffer }>;
  }): Promise<{ bundleStorageKey: string }> {
    const dir = path.join(this.baseDir, params.bundleId.replace(/[^a-zA-Z0-9_-]/g, ""));
    await mkdir(dir, { recursive: true });
    for (const file of params.files) {
      await writeFile(this.safePath(params.bundleId, file.relativePath), file.buffer);
    }
    return { bundleStorageKey: params.bundleId };
  }

  async getAssetBuffer(params: {
    bundleId: string;
    relativePath: string;
  }): Promise<{ buffer: Buffer; mimeType: string; sha256: string } | null> {
    try {
      const buffer = await readFile(this.safePath(params.bundleId, params.relativePath));
      return {
        buffer,
        mimeType: mimeFor(params.relativePath),
        sha256: createHash("sha256").update(buffer).digest("hex"),
      };
    } catch {
      return null;
    }
  }
}
