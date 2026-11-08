import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PrismaRepositories } from "../../engine/db/repositories";
import { executeUserAuthorityChange, type GovernanceExecutionContext } from "../../engine/governance/GovernanceExecution";
import { createFakePrisma, fakeTable, resetFakeDatabase, type FakePrisma } from "../helpers/governanceFake";

const admin = readFileSync("api/internal/admin.ts", "utf8");
const merchant = readFileSync("api/internal/merchant.ts", "utf8");

const slice = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf(to, start));
};

describe("H3 admin user creation and changes", () => {
  test("creation caps the grantable authorities, never grants maker/checker at once and stays INVITED", () => {
    const body = slice(admin, 'router.post("/users"', 'const requiresUserApproval');
    expect(body).toContain("assertGrantableAuthorities(creator, body.authoritiesMap)");
    expect(body).toContain("isMaker: false");
    expect(body).toContain("isChecker: false");
    expect(body).toContain('status: "INVITED"');
    expect(body).toContain('state: "PENDING_REVIEW"');
    expect(body).toContain("z.enum(STAFF_ROLES)");
  });

  test("the grant ceiling helper only lets the wildcard holder grant the wildcard", () => {
    const helper = slice(admin, "const assertGrantableAuthorities", "router.post(\"/users\"");
    expect(helper).toContain("AUTHORITY_ESCALATION_FORBIDDEN");
    expect(helper).toContain('authority === "*" ? !holdsWildcard');
  });

  test("authority, role, maker/checker flag and activation changes go through maker-checker; nobody edits themselves", () => {
    const rule = slice(admin, "const requiresUserApproval", "const loadManagedStaffUser");
    for (const field of ["authoritiesMap", "role", "isMaker", "isChecker", 'status === "ACTIVE"']) {
      expect(rule).toContain(field);
    }
    const loader = slice(admin, "const loadManagedStaffUser", 'router.patch("/users"');
    expect(loader).toContain("SELF_MODIFICATION_FORBIDDEN");
    expect(loader).toContain('startsWith("MERCHANT_")');
    for (const signature of ['router.patch("/users", ', 'router.patch("/users/:id"']) {
      const body = slice(admin, signature, "\n});");
      expect(body).toContain("loadManagedStaffUser(");
      expect(body).toContain("requiresUserApproval(body)");
      expect(body).toContain("assertGrantableAuthorities(");
    }
  });
});

describe("H3 approval execution of a user change", () => {
  let client: FakePrisma;
  let ctx: GovernanceExecutionContext;
  beforeEach(() => {
    resetFakeDatabase();
    client = createFakePrisma();
    ctx = { repositories: new PrismaRepositories(client as never) } as never;
    client.user.create({
      // An invitee who already accepted the invitation: their own password and MFA phone are set.
      data: {
        id: "u-new", email: "n@x.co", role: "SUPPORT", authoritiesMap: [], isMaker: false, isChecker: false,
        status: "INVITED", passwordHash: "scrypt:invitee", phone: "+218910000009", mfaRequired: true,
      },
    });
  });
  const exec = (payload: unknown, checkerUserId = "checker") =>
    client.$transaction((tx) =>
      executeUserAuthorityChange(ctx, tx as never, {
        approvalId: "ap-1", userId: "u-new", payload, checkerUserId, checkerRole: "SECURITY_ADMIN",
      }),
    );
  const user = () => fakeTable("user").find((row) => row.id === "u-new")!;

  test("flags and activation are applied only by the approval", async () => {
    await exec({ isMaker: true, isChecker: false, status: "ACTIVE" });
    expect(user().isMaker).toBe(true);
    expect(user().status).toBe("ACTIVE");
  });

  test("an approval cannot activate anything other than ACTIVE and ignores unknown fields", async () => {
    await expect(exec({ status: "SUSPENDED", phone: "+218000" })).rejects.toMatchObject({ code: "USER_APPROVAL_NO_FIELDS" });
    expect(user().status).toBe("INVITED");
  });

  test("activation is refused until the invitee has set their own password and MFA phone", async () => {
    user().passwordHash = null;
    await expect(exec({ status: "ACTIVE" })).rejects.toMatchObject({ code: "USER_INVITATION_PENDING" });
    expect(user().status).toBe("INVITED");
    user().passwordHash = "scrypt:invitee";
    user().phone = null;
    await expect(exec({ status: "ACTIVE" })).rejects.toMatchObject({ code: "USER_INVITATION_PENDING" });
    expect(user().status).toBe("INVITED");
    user().phone = "+218910000009";
    await exec({ status: "ACTIVE" });
    expect(user().status).toBe("ACTIVE");
  });

  test("a user cannot approve a change to their own account", async () => {
    await expect(exec({ status: "ACTIVE" }, "u-new")).rejects.toMatchObject({ code: "APPROVAL_SELF_CHANGE" });
    expect(user().status).toBe("INVITED");
  });
});

describe("M3 approval decisions are claimed atomically", () => {
  test("approve and reject claim the pending approval with a conditional update inside the transaction", () => {
    expect(admin).toContain("const claimPendingApproval");
    expect(slice(admin, "const claimPendingApproval", "router.post(\"/approvals/:id/approve\"")).toContain(
      'state: { in: ["PENDING_REVIEW", "DRAFT"] }',
    );
    const approve = slice(admin, 'router.post("/approvals/:id/approve"', 'router.post("/approvals/:id/reject"');
    // BACKUP_POLICY delegates to `executeBackupPolicyApproval`, which claims the request with a
    // conditional update BEFORE it calls the backup daemon (and is shared with PUT /policy).
    expect((approve.match(/claimPendingApproval\(tx as never/g) ?? []).length).toBe(2);
    expect(approve).toContain("executeBackupPolicyApproval({");
    const backups = readFileSync("api/internal/backups.ts", "utf8");
    const helper = slice(backups, "export const executeBackupPolicyApproval", 'router.put("/policy"');
    expect(helper).toContain("assertCheckerAuthority(actor)");
    expect(helper).toContain("assertCheckerIsNotMaker(approval.makerUserId, actor.userId)");
    expect(helper).toContain('state: { in: ["PENDING_REVIEW", "DRAFT"] }');
    expect(helper.indexOf("approvalRequest.updateMany")).toBeLessThan(helper.indexOf("getBackupControlClient().updatePolicy"));
    const reject = slice(admin, 'router.post("/approvals/:id/reject"', "\n});");
    expect(reject).toContain("claimPendingApproval(tx as never");
    expect(reject).toContain("APPROVAL_NOT_PENDING");
  });
});

describe("Merchant dispute evidence and statement export", () => {
  test("evidence is only accepted while the dispute waits for it, with a conditional update", () => {
    const body = slice(merchant, 'router.post("/disputes/:id/evidence"', "\n});");
    expect(body).toContain("DISPUTE_NOT_ACCEPTING_EVIDENCE");
    expect(body).toContain("updateMany");
    expect(body).toContain('["OPENED", "EVIDENCE_REQUESTED"]');
  });

  test("the statement export is filtered by the currency of the wallet", () => {
    const body = slice(merchant, 'router.get("/wallets/:id/statements/:month/export"', "\n});");
    expect(body).toContain("currency: wallet.currency");
  });
});

describe("M16 create-admin bootstrap", () => {
  test("the CLI never reads the password from argv and the main script keeps using the env password", () => {
    const plan = readFileSync("scripts/createAdminPlan.ts", "utf8");
    expect(plan).toContain("--password is not accepted");
    expect(plan).toContain('(env.ADMIN_MFA ?? "true")');
  });
});
