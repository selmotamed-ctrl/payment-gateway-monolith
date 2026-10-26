import { describe, expect, test } from "bun:test";
import {
  ApprovalService,
  SYSTEM_AUTOMATION,
  applyJsonPatch,
  validateJsonPatch,
  type ApprovalPrismaClient,
  type ApprovalRequestRecord,
} from "../../engine/governance/ApprovalService";

const createFakeClient = () => {
  const requests: ApprovalRequestRecord[] = [];
  const executed: string[] = [];
  const client: ApprovalPrismaClient = {
    approvalRequest: {
      findUnique: async ({ where }) =>
        (requests.find((request) => request.id === where.id) as never) ?? null,
      create: async ({ data }) => {
        const request: ApprovalRequestRecord = {
          id: `req-${requests.length + 1}`,
          subjectType: String(data.subjectType),
          subjectId: String(data.subjectId),
          payloadDiffJson: data.payloadDiffJson,
          mode: (data.mode ?? "STANDARD") as ApprovalRequestRecord["mode"],
          baseVersion: (data.baseVersion ?? null) as number | null,
          makerUserId: String(data.makerUserId),
          checkerUserId: null,
          state: "PENDING_REVIEW",
        };
        requests.push(request);
        return request;
      },
      update: async ({ where, data }) => {
        const request = requests.find((entry) => entry.id === where.id);
        if (!request) {
          throw new Error("approval request not found");
        }
        Object.assign(request, data);
        return request;
      },
    },
  };
  return { client, requests, executed };
};

describe("maker checker separation", () => {
  test("proposes an approval in PENDING_REVIEW", async () => {
    const { client, requests } = createFakeClient();
    const service = new ApprovalService(client);
    const request = await service.proposeApproval({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "maker-1",
      payloadDiff: [{ op: "replace", path: "/riskTier", value: "HIGH" }],
      baseVersion: 3,
    });
    expect(request.state).toBe("PENDING_REVIEW");
    expect(request.makerUserId).toBe("maker-1");
    expect(request.checkerUserId).toBeNull();
    expect(requests).toHaveLength(1);
  });

  test("rejects an approval where the checker equals the maker", async () => {
    const { client } = createFakeClient();
    const service = new ApprovalService(client);
    const request = await service.proposeApproval({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "maker-1",
    });
    await expect(service.approveRequest(request.id, "maker-1")).rejects.toThrow();
  });

  test("SYSTEM_AUTOMATION can never act as a checker", async () => {
    const { client } = createFakeClient();
    const service = new ApprovalService(client);
    const request = await service.proposeApproval({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "maker-1",
    });
    await expect(service.approveRequest(request.id, SYSTEM_AUTOMATION)).rejects.toThrow();
    await expect(service.rejectRequest(request.id, SYSTEM_AUTOMATION, "nope")).rejects.toThrow();
  });

  test("a different checker approves and the state becomes EXECUTED", async () => {
    const { client, executed } = createFakeClient();
    const service = new ApprovalService(client, {
      execute: (_transaction, request, checker) => {
        executed.push(`${request.id}:${checker}`);
      },
    });
    const request = await service.proposeApproval({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "maker-1",
    });
    const approved = await service.approveRequest(request.id, "checker-1");
    expect(approved.state).toBe("EXECUTED");
    expect(approved.checkerUserId).toBe("checker-1");
    expect(executed).toEqual([`${request.id}:checker-1`]);
  });

  test("a rejection records the reason and never executes", async () => {
    const { client, executed } = createFakeClient();
    const service = new ApprovalService(client, {
      execute: () => {
        executed.push("should-not-run");
      },
    });
    const request = await service.proposeApproval({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "maker-1",
    });
    const rejected = await service.rejectRequest(request.id, "checker-1", "INSUFFICIENT_EVIDENCE");
    expect(rejected.state).toBe("REJECTED");
    expect(rejected.rejectionReason).toBe("INSUFFICIENT_EVIDENCE");
    expect(executed).toEqual([]);
  });
});

describe("JSON Patch base version validation", () => {
  test("rejects a stale base version", async () => {
    const { client } = createFakeClient();
    const service = new ApprovalService(client, {
      getCurrentVersion: () => 7,
    });
    const request = await service.proposeApproval({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "maker-1",
      baseVersion: 3,
    });
    await expect(service.approveRequest(request.id, "checker-1")).rejects.toThrow();
  });

  test("accepts a matching base version", async () => {
    const { client } = createFakeClient();
    const service = new ApprovalService(client, {
      getCurrentVersion: () => 3,
    });
    const request = await service.proposeApproval({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "maker-1",
      baseVersion: 3,
    });
    const approved = await service.approveRequest(request.id, "checker-1");
    expect(approved.state).toBe("EXECUTED");
  });

  test("rejects an invalid patch at proposal time", async () => {
    const { client } = createFakeClient();
    const service = new ApprovalService(client);
    await expect(
      service.proposeApproval({
        subjectType: "MERCHANT",
        subjectId: "merchant-1",
        makerUserId: "maker-1",
        payloadDiff: [{ op: "explode", path: "/a" } as never],
      }),
    ).rejects.toThrow();
  });

  test("applies add, replace, remove, move, copy and test operations", () => {
    const document: Record<string, unknown> & {
      a: number;
      b: { c: number };
      list: number[];
      d?: number;
      copied?: number;
      moved?: number;
    } = { a: 1, b: { c: 2 }, list: [1, 2, 3] };
    const patched = applyJsonPatch(document, [
      { op: "test", path: "/a", value: 1 },
      { op: "replace", path: "/a", value: 9 },
      { op: "add", path: "/d", value: 4 },
      { op: "remove", path: "/b/c" },
      { op: "copy", path: "/copied", from: "/a" },
      { op: "move", path: "/moved", from: "/list/0" },
    ]);
    expect(patched.a).toBe(9);
    expect(patched.d).toBe(4);
    expect(patched.b.c).toBeUndefined();
    expect(patched.copied).toBe(9);
    expect(patched.moved).toBe(1);
    expect(document.a).toBe(1);
  });

  test("a failed test operation aborts the patch", () => {
    expect(() =>
      applyJsonPatch({ a: 1 }, [{ op: "test", path: "/a", value: 2 }]),
    ).toThrow();
  });

  test("validates the patch shape", () => {
    expect(validateJsonPatch([{ op: "add", path: "/a", value: 1 }])).toHaveLength(1);
    expect(() => validateJsonPatch([{ op: "add", path: "a", value: 1 }])).toThrow();
    expect(() => validateJsonPatch([{ op: "add", path: "/a" }])).toThrow();
  });
});

describe("emergency ratification", () => {
  test("executes immediately with a ratification deadline", async () => {
    const { client } = createFakeClient();
    const service = new ApprovalService(client, {
      execute: () => undefined,
    });
    const request = await service.proposeApproval({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "mlro-1",
      mode: "EMERGENCY_RATIFICATION",
    });
    const executed = await service.emergencyExecuteWithRatification(request.id, "mlro-1");
    expect(executed.mode).toBe("EMERGENCY_RATIFICATION");
    expect(executed.state).toBe("EXECUTED");
    expect(executed.ratifyDueAt).toBeInstanceOf(Date);
  });

  test("a separate checker can ratify an emergency execution", async () => {
    const { client } = createFakeClient();
    const service = new ApprovalService(client);
    const request = await service.proposeApproval({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "mlro-1",
      mode: "EMERGENCY_RATIFICATION",
    });
    await service.emergencyExecuteWithRatification(request.id, "mlro-1");
    const ratified = await service.ratifyEmergencyRequest(request.id, "compliance-1", "RATIFIED");
    expect(ratified.checkerUserId).toBe("compliance-1");
    expect(ratified.riskAcceptanceNote).toBe("RATIFIED");
  });

  test("the maker cannot ratify their own emergency execution", async () => {
    const { client } = createFakeClient();
    const service = new ApprovalService(client);
    const request = await service.proposeApproval({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "mlro-1",
      mode: "EMERGENCY_RATIFICATION",
    });
    await service.emergencyExecuteWithRatification(request.id, "mlro-1");
    await expect(service.ratifyEmergencyRequest(request.id, "mlro-1")).rejects.toThrow();
  });

  test("SYSTEM_AUTOMATION cannot create an emergency execution", async () => {
    const { client } = createFakeClient();
    const service = new ApprovalService(client);
    await expect(
      service.emergencyExecuteWithRatification({
        subjectType: "MERCHANT",
        subjectId: "merchant-1",
        makerUserId: SYSTEM_AUTOMATION,
      }),
    ).rejects.toThrow();
  });
});
