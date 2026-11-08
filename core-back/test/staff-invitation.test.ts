/**
 * Staff invitations against a real PostgreSQL 18 test database (skipped when it is unreachable).
 *
 * The maker who proposes a staff user must never know the new user's password or receive its MFA codes:
 * creation takes neither, the invitation token only exists sealed in the queued email, the invitee
 * chooses both, and activation is refused until they did.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { client } from "../prisma/client";
import { adminInternalRouter } from "../api/internal/admin";
import { signSession, verifyPassword } from "../lib/auth";
import { MemoryAuthStateStore, setAuthStateStore } from "../lib/auth/sharedState";
import { resetAuthThrottles } from "../lib/auth/throttle";
import { isApiError, toErrorEnvelope } from "../lib/error";
import { openInvitationToken } from "../lib/staffInvitation";

const DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
process.env.DATABASE_URL = DATABASE_URL;
const RUN = randomUUID().replace(/-/g, "").slice(0, 10);
// Phones are unique across users and the test database persists, so derive them from this run.
const DIGITS = String(Date.now()).slice(-7);
const phone = (suffix: string): string => `+21891${DIGITS}${suffix}`;

const reachable = await (async (): Promise<boolean> => {
  try {
    if (!/test/i.test(new URL(DATABASE_URL).pathname.replace(/^\//, ""))) return false;
    await client.$queryRawUnsafe("SELECT 1 AS ok");
    return true;
  } catch {
    return false;
  }
})();

const app = express();
app.use(express.json());
app.use("/internal/admin", adminInternalRouter);
app.use((error: unknown, _request: Request, response: Response, _next: unknown) => {
  response.status(isApiError(error) ? error.statusCode : 500).json(toErrorEnvelope(error));
});
let server: ReturnType<typeof app.listen>;
let base = "";
let makerToken = "";
let makerId = "";

type Res = { status: number; body: any };
const call = async (path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<Res> => {
  const response = await fetch(`${base}/internal/admin${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
};

const queuedInvitation = async (userId: string) =>
  client.notification.findMany({ where: { recipientUserId: userId, templateCode: "STAFF_INVITATION" }, orderBy: { createdAt: "asc" } });

const tokenOf = async (userId: string): Promise<string> => {
  const rows = await queuedInvitation(userId);
  return openInvitationToken((rows.at(-1)!.payloadJson as { tokenCiphertext: string }).tokenCiphertext);
};

beforeAll(async () => {
  if (!reachable) return;
  setAuthStateStore(new MemoryAuthStateStore());
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const authorities = ["user:write", "security:write", "user:read", "approval:write", "approval:read"];
  const maker = await client.user.create({
    data: {
      email: `invite-maker-${RUN}@gateway.test`, role: "SECURITY_ADMIN", status: "ACTIVE",
      authoritiesMap: Object.fromEntries(authorities.map((authority) => [authority, true])),
      isMaker: true, isChecker: false, mfaRequired: false,
    },
  });
  makerId = maker.id;
  makerToken = signSession({ sub: maker.id, role: "SECURITY_ADMIN", merchantId: null, authorities, appScopeIds: [], mfa: true }, "admin");
});

beforeEach(async () => {
  if (reachable) await resetAuthThrottles();
});

afterAll(() => {
  server?.close();
});

describe.skipIf(!reachable)("staff user creation hands the maker no credentials", () => {
  test("a password or a phone in the creation request is refused", async () => {
    const withPassword = await call("/users", { method: "POST", token: makerToken, body: { email: `pw-${RUN}@gateway.test`, role: "SUPPORT", password: "Maker-Chosen-1234" } });
    expect(withPassword.status).toBe(400);
    const withPhone = await call("/users", { method: "POST", token: makerToken, body: { email: `ph-${RUN}@gateway.test`, role: "SUPPORT", phone: phone("1") } });
    expect(withPhone.status).toBe(400);
    expect(await client.user.count({ where: { email: { in: [`pw-${RUN}@gateway.test`, `ph-${RUN}@gateway.test`] } } })).toBe(0);
  });

  test("the user is created without credentials and the token only exists sealed in the invitee's email", async () => {
    const email = `invitee-${RUN}@gateway.test`;
    const created = await call("/users", { method: "POST", token: makerToken, body: { email, role: "SUPPORT" } });
    expect(created.status).toBe(201);
    expect(created.body.invitationSent).toBe(true);
    expect(JSON.stringify(created.body)).not.toMatch(/token/i);

    const user = await client.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({ status: "INVITED", passwordHash: null, phone: null, invitedById: makerId });
    expect(user.invitationTokenHash).toHaveLength(64);

    const [mail] = await queuedInvitation(user.id);
    expect(mail).toMatchObject({ channel: "EMAIL", status: "QUEUED", templateCode: "STAFF_INVITATION" });
    const token = await tokenOf(user.id);
    expect(JSON.stringify(mail!.payloadJson)).not.toContain(token);
    expect(mail!.addressCiphertext).not.toContain(email);
    expect(mail!.addressMasked).toBe(`${email.slice(0, 2)}***@gateway.test`);
    expect(await client.notificationTemplate.count({ where: { code: "STAFF_INVITATION" } })).toBeGreaterThanOrEqual(2);
  });
});

describe.skipIf(!reachable)("the invitee completes the invitation, then activation can be proposed", () => {
  const email = `flow-${RUN}@gateway.test`;
  let userId = "";
  let token = "";

  test("activation is refused while the invitation is pending", async () => {
    const created = await call("/users", { method: "POST", token: makerToken, body: { email, role: "SUPPORT" } });
    userId = created.body.id;
    token = await tokenOf(userId);
    const refused = await call(`/users/${userId}`, { method: "PATCH", token: makerToken, body: { status: "ACTIVE" } });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("USER_INVITATION_PENDING");
  });

  test("a wrong token is refused and the address is throttled after repeated guesses", async () => {
    for (let i = 0; i < 10; i += 1) {
      const guess = await call("/auth/accept-invitation", { method: "POST", body: { token: `x${i}`.padEnd(32, "z"), password: "Invitee-Own-Pass-1", phone: phone("5") } });
      expect(guess.status).toBe(400);
      expect(guess.body.code).toBe("INVITATION_INVALID");
    }
    const throttled = await call("/auth/accept-invitation", { method: "POST", body: { token, password: "Invitee-Own-Pass-1", phone: phone("5") } });
    expect(throttled.status).toBe(429);
  });

  test("the invitee sets their own password and phone; the token works exactly once", async () => {
    const accepted = await call("/auth/accept-invitation", { method: "POST", body: { token, password: "Invitee-Own-Pass-1", phone: `${phone("7").slice(0, 6)} ${phone("7").slice(6)}` } });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ status: "INVITED", activationPending: true });
    const user = await client.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.status).toBe("INVITED");
    expect(user.phone).toBe(phone("7"));
    expect(user.invitationTokenHash).toBeNull();
    expect(await verifyPassword("Invitee-Own-Pass-1", user.passwordHash!)).toBe(true);
    const audit = await client.auditLog.findFirst({ where: { entityId: userId, action: "INTERNAL_USER_INVITATION_ACCEPTED" } });
    expect(audit?.actorId).toBe(userId);
    expect(JSON.stringify(audit?.afterJson)).not.toContain("Invitee-Own-Pass");

    const replay = await call("/auth/accept-invitation", { method: "POST", body: { token, password: "Another-Pass-12345", phone: phone("8") } });
    expect(replay.status).toBe(400);
  });

  test("activation can now be proposed and the checker sees that the invitee set it up, never the credentials", async () => {
    const proposed = await call(`/users/${userId}`, { method: "PATCH", token: makerToken, body: { status: "ACTIVE" } });
    expect(proposed.status).toBe(202);
    const approval = await client.approvalRequest.findUniqueOrThrow({ where: { id: proposed.body.approvalRequestId } });
    expect(JSON.stringify(approval.payloadDiffJson)).not.toMatch(/password|phone/i);
    const detail = await call(`/approvals/${approval.id}`, { token: makerToken });
    expect(detail.status).toBe(200);
    const context = JSON.stringify(detail.body);
    expect(context).toContain('"invitationAccepted":true');
    expect(context).toContain(`*******${phone("7").slice(-4)}`);
    expect(context).not.toContain(phone("7"));
    expect(context).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  test("a phone already used by another account cannot be claimed", async () => {
    const other = await call("/users", { method: "POST", token: makerToken, body: { email: `other-${RUN}@gateway.test`, role: "SUPPORT" } });
    const otherToken = await tokenOf(other.body.id);
    const clash = await call("/auth/accept-invitation", { method: "POST", body: { token: otherToken, password: "Invitee-Own-Pass-2", phone: phone("7") } });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("PHONE_UNAVAILABLE");
    expect((await client.user.findUniqueOrThrow({ where: { id: other.body.id } })).passwordHash).toBeNull();
  });
});

describe.skipIf(!reachable)("re-inviting discards credentials a maker set earlier", () => {
  test("POST /users/:id/invite resets password and phone and issues a fresh token", async () => {
    const legacy = await client.user.create({
      data: {
        email: `legacy-${RUN}@gateway.test`, role: "SUPPORT", status: "INVITED", authoritiesMap: [],
        passwordHash: "scrypt:maker-chosen", phone: phone("9"), invitedById: makerId, mfaRequired: true,
      },
    });
    // The legacy record could be activated with credentials only the maker knows.
    const before = await call(`/users/${legacy.id}`, { method: "PATCH", token: makerToken, body: { status: "ACTIVE" } });
    expect(before.status).toBe(202);

    const reinvited = await call(`/users/${legacy.id}/invite`, { method: "POST", token: makerToken });
    expect(reinvited.status).toBe(200);
    const after = await client.user.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(after).toMatchObject({ passwordHash: null, phone: null });
    expect(after.invitationTokenHash).toHaveLength(64);
    expect(await queuedInvitation(legacy.id)).toHaveLength(1);
    const blocked = await call(`/users/${legacy.id}`, { method: "PATCH", token: makerToken, body: { status: "ACTIVE" } });
    expect(blocked.status).toBe(409);
  });

  test("an active user cannot be re-invited, and nobody re-invites themselves", async () => {
    const active = await client.user.create({
      data: { email: `active-${RUN}@gateway.test`, role: "SUPPORT", status: "ACTIVE", authoritiesMap: [], passwordHash: "x", mfaRequired: false },
    });
    expect((await call(`/users/${active.id}/invite`, { method: "POST", token: makerToken })).status).toBe(409);
    expect((await call(`/users/${makerId}/invite`, { method: "POST", token: makerToken })).status).toBe(403);
  });
});
