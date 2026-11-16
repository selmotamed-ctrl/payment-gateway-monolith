import { describe, expect, test } from "bun:test";
import { orphanBlobSweepAllowed } from "../lib/objectStorageSdk";

describe("object storage orphan sweep guard", () => {
  test("defaults to enabled for a single control-plane owner", () => {
    expect(orphanBlobSweepAllowed({})).toBe(true);
    expect(orphanBlobSweepAllowed({ OBJECT_STORAGE_ORPHAN_SWEEP_ENABLED: "true" })).toBe(true);
  });

  test("is disabled when the deploy marks the vault shared", () => {
    expect(orphanBlobSweepAllowed({ OBJECT_STORAGE_ORPHAN_SWEEP_ENABLED: "false" })).toBe(false);
  });

  test("is always disabled on the Sandbox plane", () => {
    expect(orphanBlobSweepAllowed({ EXECUTION_PLANE: "SANDBOX" })).toBe(false);
    expect(
      orphanBlobSweepAllowed({
        EXECUTION_PLANE: "SANDBOX",
        OBJECT_STORAGE_ORPHAN_SWEEP_ENABLED: "true",
      }),
    ).toBe(false);
  });
});
