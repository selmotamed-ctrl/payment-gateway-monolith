import { describe, expect, test } from "bun:test";
import { newCertificateDisplayId, newCertificatePublicId } from "../engine/academy/certificate";

describe("academy certificate identifiers", () => {
  test("public identifiers are opaque and unique enough", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newCertificatePublicId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    }
  });

  test("display identifiers are short, uppercase and prefixed", () => {
    for (const id of Array.from({ length: 20 }, () => newCertificateDisplayId())) {
      expect(id).toMatch(/^PG-AC-[0-9A-F]{8}$/);
    }
  });
});
