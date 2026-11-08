/**
 * The inbound inbox claim statement against live PostgreSQL. `claimed_at` is `timestamptz` and `updated_at` is
 * `timestamp`; one untyped parameter used for both is rejected at parse time (42P08 "inconsistent types deduced for
 * parameter $3") and the worker then failed every tick. Fakes cannot see that, so the real statement is prepared here.
 * `batchSize: 0` makes the claim take no row, which keeps the shared test database untouched.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { InboundInboxWorker } from "../engine/workers/InboundInboxWorker";
import { emptyRepositories } from "./helpers/fakeRepositories";
import { createPrisma, databaseIsReachable } from "./storage-engine/helpers/db";

const client = createPrisma({ max: 5 });
const describeDb = databaseIsReachable ? describe : describe.skip;

afterAll(async () => {
  await client.$disconnect();
});

describeDb("InboundInboxWorker claim (live PostgreSQL)", () => {
  test("the claim statement is accepted by PostgreSQL and a tick completes without an error", async () => {
    const errors: unknown[][] = [];
    const worker = new InboundInboxWorker({
      db: client as never,
      repositories: emptyRepositories(),
      logger: { info: () => undefined, warn: () => undefined, error: (...args: unknown[]) => void errors.push(args) },
      handler: { handle: async () => ({ processed: true }) },
      workerId: "claim-test",
      batchSize: 0,
    });
    await worker.runOnce();
    expect(errors).toEqual([]);
  });
});
