import { createHash } from "node:crypto";
import { createReadStream, promises as nodeFs } from "node:fs";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";

/** Deterministic JSON with sorted object keys; mirrors core-back's audit adapter. */
export const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
};

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

export const sha256File = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), async function* (source) {
    for await (const chunk of source) hash.update(chunk as Buffer);
  });
  return hash.digest("hex");
};

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await nodeFs.access(path);
    return true;
  } catch {
    return false;
  }
};

let tempCounter = 0;
export const tempSibling = (path: string): string => {
  tempCounter += 1;
  return `${dirname(path)}/.${path.slice(dirname(path).length + 1)}.${process.pid}.${tempCounter}.tmp`;
};

/** Writes a small file atomically (temp + fsync + rename). */
export const writeFileAtomic = async (path: string, data: string | Uint8Array, mode = 0o600): Promise<void> => {
  await nodeFs.mkdir(dirname(path), { recursive: true });
  const tmp = tempSibling(path);
  const handle = await nodeFs.open(tmp, "w", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await nodeFs.rename(tmp, path);
  } catch (error) {
    await nodeFs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
};

/** Cooperative sleep that never keeps the process alive on its own. */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const backupIdStamp = (date: Date): string =>
  date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** `bkp_20261106T020000Z_core_full` */
export const makeBackupId = (date: Date, short: "core" | "audit" | "redis", kind: "full" | "delta"): string =>
  `bkp_${backupIdStamp(date)}_${short}_${kind}`;
