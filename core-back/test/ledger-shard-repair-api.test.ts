/**
 * Manual shard repair through the admin API (live PostgreSQL): the preview, the immediate RECOMPUTE of an intact shard,
 * and the approval-bound REBASELINE of a damaged one executed by a different checker.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { client } from "../prisma/client";
import { adminLedgerRouter } from "../api/internal/adminLedger";
import { executeApprovalSubject } from "../engine/governance/GovernanceExecution";
import { PrismaRepositories } from "../engine/db/repositories";
import { CheckpointService } from "../engine/ledger/CheckpointService";
import { clearShardWidthCache } from "../lib/storageEngine/shardRouting";
import { withLedgerMaintenance } from "./helpers/ledgerMaintenance";
import { createStaffUser, dbAvailable, makePrincipal, neutraliseLedgerSince, postEntry, startApp, type TestApp } from "./admin-slice/harness";

let app: TestApp;
let maker: string;
let checker: string;
const reader = () => makePrincipal(maker, ["finance:read"], "FINANCE");
const writer = () => makePrincipal(maker, ["finance:read", "finance:write"], "FINANCE");
const startedAt = new Date(Date.now() - 2000);

if (dbAvailable) beforeAll(async () => {
  maker = await createStaffUser("FINANCE");
  checker = await createStaffUser("FINANCE");
  app = await startApp([adminLedgerRouter]);
  app.setPrincipal(writer());
});
if (dbAvailable) afterAll(async () => {
  await client.glShardRepair.deleteMany({ where: { reason: { startsWith: "api-test" } } });
  await neutraliseLedgerSince(startedAt);
  await app.close();
  await client.$disconnect();
});

const makeAccounts = async () => {
  const treasury = await client.glAccount.create({ data: { accountType: "TREASURY", currency: "LYD", shardCount: 1 } });
  const wallet = await client.glAccount.create({ data: { accountType: "MERCHANT_WALLET", currency: "LYD", ownerId: randomUUID() } });
  clearShardWidthCache();
  const pay = () =>
    postEntry([
      { glAccountId: treasury.id, direction: "DEBIT", amount: "4.0000" },
      { glAccountId: wallet.id, direction: "CREDIT", amount: "4.0000" },
    ]);
  return { treasury: treasury.id, wallet: wallet.id, pay };
};

const executeApproval = async (approvalId: string, checkerUserId: string) => {
  const approval = await client.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
  return client.$transaction(async (tx) => {
    const result = await executeApprovalSubject({ ledgerPoster: {} as never, repositories: new PrismaRepositories(client as never) } as never, tx as never, {
      approval: approval as never,
      checkerUserId,
      checkerRole: "FINANCE",
    });
    await tx.approvalRequest.update({ where: { id: approvalId }, data: { state: "EXECUTED", checkerUserId } });
    return result;
  });
};

describe.skipIf(!dbAvailable)("shard repair API", () => {
  test("preview, authority checks, the stale-plan guard and an immediate recompute of an intact shard", async () => {
    const { treasury, pay } = await makeAccounts();
    for (let i = 0; i < 4; i += 1) await pay();
    await client.$executeRawUnsafe(`UPDATE gl_account_shards SET current_balance = current_balance + 1.25 WHERE gl_account_id = $1::uuid AND shard_id = 0`, treasury);

    app.setPrincipal(reader());
    const preview = await app.request("GET", `/finance/gl-accounts/${treasury}/shards/0/repair-plan`);
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ needsRepair: true, kind: "RECOMPUTE", sequenceIntact: true, delta: "-1.2500" });
    expect(preview.json.planHash).toMatch(/^[0-9a-f]{64}$/);
    const denied = await app.request("POST", `/finance/gl-accounts/${treasury}/shards/0/repair`, { reason: "api-test read only", planHash: preview.json.planHash });
    expect(denied.status).toBe(403);
    expect((await app.request("GET", `/finance/gl-accounts/${randomUUID()}/shards/0/repair-plan`)).status).toBe(404);
    expect((await app.request("GET", `/finance/gl-accounts/${treasury}/shards/999/repair-plan`)).status).toBe(404);

    app.setPrincipal(writer());
    expect((await app.request("POST", `/finance/gl-accounts/${treasury}/shards/0/repair`, { reason: "short", planHash: preview.json.planHash })).status).toBe(400);
    expect((await app.request("POST", `/finance/gl-accounts/${treasury}/shards/0/repair`, { reason: "api-test stale plan hash", planHash: "0".repeat(64) })).json.code).toBe("SHARD_REPAIR_PLAN_CHANGED");

    const done = await app.request("POST", `/finance/gl-accounts/${treasury}/shards/0/repair`, { reason: "api-test recompute", planHash: preview.json.planHash });
    expect(done.status).toBe(200);
    expect(done.json.repaired).toBe(true);
    expect(done.json.shards[0].status).toBe("OK");
    const after = await app.request("GET", `/finance/gl-accounts/${treasury}/shards/0/repair-plan`);
    expect(after.json.needsRepair).toBe(false);
    const again = await app.request("POST", `/finance/gl-accounts/${treasury}/shards/0/repair`, { reason: "api-test again", planHash: after.json.planHash });
    expect(again.json.code).toBe("SHARD_REPAIR_NOT_NEEDED");
  });

  test("a damaged sequence needs a second person: the single-user path refuses and the approved one re-baselines", async () => {
    const { treasury, pay } = await makeAccounts();
    for (let i = 0; i < 6; i += 1) await pay();
    const service = new CheckpointService(client as never);
    await service.captureShard(treasury, 0);
    for (let i = 0; i < 3; i += 1) await pay();
    // Damage the SEQUENCE without touching any amount (the journal stays balanced for the shared test database): the
    // line numbered 8 is renumbered beyond the shard's high-water mark, so a number is missing and one is out of range.
    await withLedgerMaintenance(client, (tx) => tx.journalLine.updateMany({ where: { glAccountId: treasury, shardId: 0, shardSeq: 8n }, data: { shardSeq: 99n } }));
    expect((await service.captureShard(treasury, 0)).status).toBe("GAP");

    const preview = await app.request("GET", `/finance/gl-accounts/${treasury}/shards/0/repair-plan`);
    expect(preview.json).toMatchObject({ needsRepair: true, kind: "REBASELINE", sequenceIntact: false });
    const direct = await app.request("POST", `/finance/gl-accounts/${treasury}/shards/0/repair`, { reason: "api-test single user", planHash: preview.json.planHash });
    expect(direct.status).toBe(409);
    expect(direct.json.code).toBe("SHARD_REPAIR_NEEDS_APPROVAL");

    const requested = await app.request("POST", `/finance/gl-accounts/${treasury}/shards/0/repair/request`, { reason: "api-test re-baseline after a lost line", planHash: preview.json.planHash });
    expect(requested.status).toBe(202);
    const approvalId = requested.json.approvalRequestId as string;
    const duplicate = await app.request("POST", `/finance/gl-accounts/${treasury}/shards/0/repair/request`, { reason: "api-test duplicate request", planHash: preview.json.planHash });
    expect(duplicate.json.code).toBe("SHARD_REPAIR_APPROVAL_PENDING");

    // nothing changed yet
    expect((await client.glShardRepair.count({ where: { glAccountId: treasury } }))).toBe(0);
    // the maker can never be the checker
    await expect(executeApproval(approvalId, maker)).rejects.toMatchObject({ code: "APPROVAL_MAKER_EQUALS_CHECKER" });
    // a different checker executes it
    const executed = await executeApproval(approvalId, checker);
    expect(executed.status).toBe("EXECUTED");
    const repair = await client.glShardRepair.findFirstOrThrow({ where: { glAccountId: treasury } });
    expect(repair).toMatchObject({ kind: "REBASELINE", mode: "APPROVED", actorId: checker, approvalRequestId: approvalId });
    expect((await app.request("GET", `/finance/gl-accounts/${treasury}/shards/0/repair-plan`)).json.needsRepair).toBe(false);
    for (let i = 0; i < 3; i += 1) await pay();
    expect((await service.captureShard(treasury, 0)).status).toBe("ADVANCED");
    const audits = (await client.auditLog.findMany({ where: { entityId: treasury } })).map((row) => row.action);
    expect(audits).toContain("GL_SHARD_REPAIR_REQUESTED");
    expect(audits).toContain("GL_SHARD_REPAIRED");
  });

  test("an approval is refused when the shard moved since the preview", async () => {
    const { treasury, pay } = await makeAccounts();
    for (let i = 0; i < 3; i += 1) await pay();
    await client.$executeRawUnsafe(`UPDATE gl_account_shards SET current_balance = current_balance + 2 WHERE gl_account_id = $1::uuid AND shard_id = 0`, treasury);
    const preview = await app.request("GET", `/finance/gl-accounts/${treasury}/shards/0/repair-plan`);
    const requested = await app.request("POST", `/finance/gl-accounts/${treasury}/shards/0/repair/request`, { reason: "api-test stale approval", planHash: preview.json.planHash });
    expect(requested.status).toBe(202);
    await pay(); // the shard moves between the request and the approval
    await expect(executeApproval(requested.json.approvalRequestId, checker)).rejects.toMatchObject({ code: "SHARD_REPAIR_PLAN_CHANGED" });
    expect(await client.glShardRepair.count({ where: { glAccountId: treasury } })).toBe(0);
    // leave the shared database consistent: repair the forged shard with a fresh preview
    const fresh = await app.request("GET", `/finance/gl-accounts/${treasury}/shards/0/repair-plan`);
    expect((await app.request("POST", `/finance/gl-accounts/${treasury}/shards/0/repair`, { reason: "api-test cleanup recompute", planHash: fresh.json.planHash })).status).toBe(200);
  });
});
