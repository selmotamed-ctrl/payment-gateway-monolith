import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { client } from "../prisma/client";
import {
  ensureAcademyCertificateForBadge,
  findAcademyCertificate,
  revokeAcademyCertificate,
} from "../engine/academy/certificate";
import type { AcademyBadge } from "../engine/academy/types";

let reachable = false;
try {
  await client.$queryRawUnsafe("SELECT 1");
  reachable = true;
} catch {
  reachable = false;
}
let userId: string | null = null;

const badge = (earnedAt: string): AcademyBadge => ({
  id: "FOUNDATION_CERTIFIED",
  track: "FOUNDATION",
  earnedAt,
  expiresAt: "2027-11-23T07:00:00.000Z",
  v: "1.0.0",
});

beforeAll(async () => {
  if (!reachable) return;
  const user = await client.user.create({
    data: {
      email: `academy-certificate-${randomUUID()}@example.test`,
      role: "OPERATOR",
      authoritiesMap: {},
      appScopeIds: [],
      isMaker: false,
      isChecker: false,
      mfaRequired: false,
      status: "ACTIVE",
    },
  });
  userId = user.id;
});

afterAll(async () => {
  if (reachable && userId) await client.user.delete({ where: { id: userId } }).catch(() => undefined);
});

describe.skipIf(!reachable)("academy certificate lifecycle", () => {
  test("issuance is idempotent, recertification supersedes, and revocation is idempotent", async () => {
    const first = await ensureAcademyCertificateForBadge(userId!, badge("2026-01-01T00:00:00.000Z"), "Operator");
    const again = await ensureAcademyCertificateForBadge(userId!, badge("2026-01-01T00:00:00.000Z"), "Operator");
    expect(again.id).toBe(first.id);
    expect(first.status).toBe("ACTIVE");

    const newer = await ensureAcademyCertificateForBadge(userId!, badge("2026-06-01T00:00:00.000Z"), "Operator");
    expect(newer.id).not.toBe(first.id);
    expect(newer.status).toBe("ACTIVE");
    const previous = await findAcademyCertificate(first.publicId);
    expect(previous?.status).toBe("SUPERSEDED");

    expect(await revokeAcademyCertificate({ identifier: newer.displayId, actorUserId: userId!, reason: "test revocation" })).toBe(true);
    expect(await revokeAcademyCertificate({ identifier: newer.displayId, actorUserId: userId!, reason: "retry" })).toBe(true);
    const revoked = await findAcademyCertificate(newer.publicId);
    expect(revoked?.status).toBe("REVOKED");
    expect(revoked?.revocationReason).toBe("test revocation");
  });
});
