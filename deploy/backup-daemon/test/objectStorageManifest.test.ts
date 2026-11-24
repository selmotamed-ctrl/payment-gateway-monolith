import { describe, expect, test } from "bun:test";
import {
  buildObjectStorageManifest,
  compareObjectStorageManifest,
  type ActiveStorageObject,
} from "../src/objectStorageBackup";

const object = (id: string, storageKey = `key-${id}`, sha256Hex = "a".repeat(64)): ActiveStorageObject => ({
  id,
  bucket: "HOT",
  storageKey,
  sha256Hex,
  byteSize: "10",
  chunkSize: 1,
  chunkCount: 1,
  kekKeyVersion: 1,
  wrappedDekHex: "00",
  dekNonceHex: "00",
  streamNoncePrefixHex: "00",
});

describe("object storage backup manifest", () => {
  test("matches the restored active set exactly", () => {
    const manifest = buildObjectStorageManifest([object("1"), object("2")], new Date("2026-01-01T00:00:00.000Z"));
    expect(manifest.count).toBe(2);
    expect(compareObjectStorageManifest(manifest, [object("1"), object("2")]).ok).toBe(true);
  });

  test("detects a row missing from the restored database or the backup", () => {
    const manifest = buildObjectStorageManifest([object("1"), object("2")]);
    expect(compareObjectStorageManifest(manifest, [object("1")]).detail).toContain("missing=1");
    expect(compareObjectStorageManifest(manifest, [object("1"), object("2"), object("3")]).detail).toContain("extra=1");
  });

  test("detects a changed storage key or hash", () => {
    const manifest = buildObjectStorageManifest([object("1")]);
    expect(compareObjectStorageManifest(manifest, [object("1", "other-key")]).ok).toBe(false);
    expect(compareObjectStorageManifest(manifest, [object("1", "key-1", "b".repeat(64))]).ok).toBe(false);
  });
});
