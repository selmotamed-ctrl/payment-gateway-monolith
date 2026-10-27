import { describe, expect, test } from "bun:test";
import {
  assertBackgroundJobQueueDrainable,
  readBackgroundJobQueueHealth,
} from "../engine/workers/productionRuntime";
import { createApp } from "../index";

const NOW = new Date("2026-10-28T12:00:00.000Z");

interface FakeJob {
  state: string;
  createdAt: Date;
}

const fakeDb = (jobs: FakeJob[]) => ({
  backgroundJob: {
    count: async ({ where }: { where: { state: string } }) =>
      jobs.filter((job) => job.state === where.state).length,
    findFirst: async ({ where }: { where: { state: string } }) => {
      const queued = jobs
        .filter((job) => job.state === where.state)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
      return queued[0] ? { createdAt: queued[0].createdAt } : null;
    },
  },
});

const health = async (jobs: FakeJob[]): Promise<{
  status: number;
  body: {
    msg: string;
    status: string;
    queue: {
      enabled: boolean;
      queued: number;
      oldestQueuedAgeMs: number | null;
      degraded: boolean;
      thresholdMs: number;
    };
  };
}> => {
  const app = createApp({ db: fakeDb(jobs) as never, now: () => NOW });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return {
      status: response.status,
      body: (await response.json()) as Awaited<ReturnType<typeof health>>["body"],
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

describe("the durable queue startup guard", () => {
  test("accepts a deployment whose queue is drained", () => {
    expect(() =>
      assertBackgroundJobQueueDrainable({
        workerEnabled: true,
        backgroundJobsEnabled: true,
      }),
    ).not.toThrow();
  });

  test("refuses to boot when WORKER_ENABLED is disabled", () => {
    expect(() =>
      assertBackgroundJobQueueDrainable({
        workerEnabled: false,
        backgroundJobsEnabled: true,
      }),
    ).toThrow(/WORKER_ENABLED/);
  });

  test("refuses to boot when the background job worker is disabled", () => {
    expect(() =>
      assertBackgroundJobQueueDrainable({
        workerEnabled: true,
        backgroundJobsEnabled: false,
      }),
    ).toThrow(/WORKER_BACKGROUND_JOBS_ENABLED/);
  });
});

describe("the durable queue health payload", () => {
  test("reports an empty, healthy queue", async () => {
    const response = await health([]);
    expect(response.status).toBe(200);
    expect(response.body.msg).toBe("OK");
    expect(response.body.status).toBe("ok");
    expect(response.body.queue.enabled).toBe(true);
    expect(response.body.queue.queued).toBe(0);
    expect(response.body.queue.oldestQueuedAgeMs).toBeNull();
    expect(response.body.queue.degraded).toBe(false);
  });

  test("reports a fresh queued job without degrading", async () => {
    const response = await health([
      { state: "QUEUED", createdAt: new Date(NOW.getTime() - 1_000) },
      { state: "SUCCEEDED", createdAt: new Date(NOW.getTime() - 60_000) },
    ]);
    expect(response.body.msg).toBe("OK");
    expect(response.body.queue.queued).toBe(1);
    expect(response.body.queue.oldestQueuedAgeMs).toBe(1_000);
    expect(response.body.queue.degraded).toBe(false);
  });

  test("degrades when the oldest queued job exceeds the threshold", async () => {
    const response = await health([
      { state: "QUEUED", createdAt: new Date(NOW.getTime() - 10 * 60_000) },
    ]);
    expect(response.status).toBe(200);
    expect(response.body.msg).toBe("DEGRADED");
    expect(response.body.status).toBe("degraded");
    expect(response.body.queue.queued).toBe(1);
    expect(response.body.queue.oldestQueuedAgeMs).toBe(10 * 60_000);
    expect(response.body.queue.degraded).toBe(true);
  });

  test("the helper honours an explicit threshold", async () => {
    const snapshot = await readBackgroundJobQueueHealth(
      fakeDb([
        { state: "QUEUED", createdAt: new Date(NOW.getTime() - 2_000) },
      ]) as never,
      { now: NOW, thresholdMs: 1_000 },
    );
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.oldestQueuedAgeMs).toBe(2_000);
    expect(snapshot.thresholdMs).toBe(1_000);
  });
});
