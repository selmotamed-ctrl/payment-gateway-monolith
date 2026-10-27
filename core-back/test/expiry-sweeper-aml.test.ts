import { describe, expect, test } from "bun:test";
import { ExpirySweeperWorker } from "../engine/workers/ExpirySweeperWorker";
import { createFakeRepositories } from "./helpers/fakeRepositories";
import { createRecordingDb } from "./edge-cases/helpers";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const EXPIRED_AT = new Date("2026-05-31T00:00:00.000Z");

const attemptRow = (overrides: Record<string, unknown> = {}) => ({
  id: "attempt-1",
  status: "AWAITING_CUSTOMER",
  substatus: null,
  expires_at: EXPIRED_AT,
  terminal_at: null,
  route_id: "route-1",
  link_id: "link-1",
  ...overrides,
});

const createWorker = (
  queryRows: unknown[],
  options: {
    onExecute?: (sql: string, args: unknown[]) => number | undefined;
    onRelease?: (linkId: string, delta: number) => void;
  } = {},
) => {
  const { db, calls } = createRecordingDb({
    queryRows,
    onExecute: options.onExecute ?? (() => 1),
  });
  const worker = new ExpirySweeperWorker({
    db,
    repositories: createFakeRepositories({
      payments: {
        listRouteInquirySupport: async () => [],
        updateLinkSlotCount: async (_tx, linkId, delta) => {
          options.onRelease?.(linkId, delta);
        },
      },
      governance: {
        writeAuditLog: async () => undefined,
      },
    }),
    clock: () => NOW,
  });
  return { worker, calls };
};

describe("expiry sweeper and AML holds", () => {
  test("the expirable query excludes AML-held attempts", async () => {
    const { worker, calls } = createWorker([]);
    await worker.runOnce();

    const select = calls.find((call) =>
      call.kind === "query" && call.sql.includes("FROM payment_attempts")
    );
    expect(select?.sql).toContain("substatus <> ?");
    expect(select?.args).toContain("AML_HOLD");
  });

  test("the sweeper never expires or releases an AML-held attempt", async () => {
    const releases: Array<{ linkId: string; delta: number }> = [];
    const { worker, calls } = createWorker(
      [attemptRow({ status: "CREATED", substatus: "AML_HOLD" })],
      { onRelease: (linkId, delta) => releases.push({ linkId, delta }) },
    );

    await worker.runOnce();

    expect(
      calls.filter((call) => call.kind === "execute" && call.sql.includes("UPDATE payment_attempts")),
    ).toHaveLength(0);
    expect(releases).toEqual([]);
  });

  test("a normal expired attempt is still expired and its slot released", async () => {
    const releases: Array<{ linkId: string; delta: number }> = [];
    const { worker, calls } = createWorker([attemptRow()], {
      onRelease: (linkId, delta) => releases.push({ linkId, delta }),
    });

    await worker.runOnce();

    const update = calls.find((call) =>
      call.kind === "execute" && call.sql.includes("UPDATE payment_attempts")
    );
    expect(update?.args[0]).toBe("EXPIRED");
    expect(releases).toEqual([{ linkId: "link-1", delta: -1 }]);
  });
});
