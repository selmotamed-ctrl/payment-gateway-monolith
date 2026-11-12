import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import type { ReportAssetStoragePort } from "../../lib/reportEngineSdk/types/hostConfig";
import type { ObjectStorageSdk } from "../../lib/objectStorageSdk";
import { getObjectStorageSdk } from "../../lib/objectStorageSdk/runtime";

const mimeFor = (fileName: string): string => {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".ttf")) return "font/ttf";
  if (lower.endsWith(".woff2")) return "font/woff2";
  if (lower.endsWith(".woff")) return "font/woff";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
};

/**
 * Local development/test driver. Production rows are stored in the shared
 * object vault instead; this remains as the fallback for rows created before
 * the storage engine migration and for bun tests that inject it.
 */
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

/**
 * The production driver: each Report Studio bundle (staff or merchant) is one
 * immutable `application/zip` object in the shared vault. The `storageObjectId`
 * on the bundle row holds a `REPORT_ASSET_ENTRY` lock, and rendering extracts
 * the requested entry from the archive in memory.
 */
export class ObjectStorageReportAssetStorage implements ReportAssetStoragePort {
  constructor(private readonly sdk: ObjectStorageSdk = getObjectStorageSdk()) {}

  private archiveUrl(bundleId: string): string {
    return `asset://bundle/${bundleId}`;
  }

  async storeAssetBundle(params: {
    bundleId: string;
    files: Array<{ relativePath: string; mimeType: string; sha256: string; buffer: Buffer }>;
  }): Promise<{ bundleStorageKey: string; storageObjectId: string }> {
    const entries: Record<string, Uint8Array> = {};
    for (const file of params.files) {
      const normalized = file.relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
      if (!normalized || normalized.includes("../")) throw new Error("REPORT_ASSET_PATH_INVALID");
      entries[normalized] = new Uint8Array(file.buffer);
    }
    const archive = Buffer.from(zipSync(entries, { level: 6 }));
    const staged = await this.sdk.workerClient.stageSystemGenerated({
      namespace: "REPORT_STUDIO_ASSETS",
      data: archive,
      originalFilename: `${params.bundleId}.zip`,
      claimedMimeType: "application/zip",
      actorId: "report-studio-asset-store",
      metadata: { bundleId: params.bundleId, archive: true },
    });
    await this.sdk.prisma.$transaction(async (tx) => {
      await this.sdk.routeClient.bind(tx, {
        objectId: staged.objectId,
        holderType: "REPORT_ASSET_ENTRY",
        holderId: params.bundleId,
        actorId: "report-studio-asset-store",
        reason: "REPORT_ASSET_BUNDLE_STORED",
      });
    });
    return { bundleStorageKey: staged.storageKey, storageObjectId: staged.objectId };
  }

  async getAssetBuffer(params: {
    bundleId: string;
    relativePath: string;
  }): Promise<{ buffer: Buffer; mimeType: string; sha256: string } | null> {
    const [staff, merchant] = await Promise.all([
      this.sdk.prisma.reportAssetBundle.findUnique({
        where: { id: params.bundleId },
        select: { storageObjectId: true, storageKey: true },
      }),
      this.sdk.prisma.merchantReportAssetBundle.findUnique({
        where: { id: params.bundleId },
        select: { storageObjectId: true, storageKey: true },
      }),
    ]);
    const bundle = staff ?? merchant;
    if (!bundle?.storageObjectId) {
      // Legacy row (pre-v36) or a bundle stored by the local test driver.
      return new LocalReportAssetStorage().getAssetBuffer(params);
    }
    const stored = await this.sdk.workerClient.readInternal(bundle.storageObjectId, "report-studio-renderer");
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(stored.bytes));
    } catch {
      return null;
    }
    const wanted = params.relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
    const key = Object.keys(entries).find(
      (candidate) => candidate === wanted || candidate.toLowerCase() === wanted.toLowerCase(),
    );
    if (!key) return null;
    const buffer = Buffer.from(entries[key]!);
    return {
      buffer,
      mimeType: mimeFor(key),
      sha256: createHash("sha256").update(buffer).digest("hex"),
    };
  }
}

export { mimeFor };
