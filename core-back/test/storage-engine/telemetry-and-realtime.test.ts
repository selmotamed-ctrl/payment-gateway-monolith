import { describe, expect, test } from "bun:test";
import { InvalidationBus } from "../../lib/invalidationBus";
import { recordReadSource, storageTelemetry } from "../../lib/storageEngine/telemetry";

describe("storage telemetry", () => {
  test("records the serving store on the response", () => {
    const headers: Record<string, string> = {};
    storageTelemetry.run({ response: { setHeader: (name, value) => { headers[name] = value; } } }, () => {
      recordReadSource("replica-2", "0/ABC");
    });
    expect(headers["x-pg-served-by"]).toBe("replica-2");
    expect(headers["x-pg-min-lsn"]).toBe("0/ABC");
  });
});

describe("realtime bridge", () => {
  test("attempt transitions are republished on the realtime topic", async () => {
    const published: Array<{ channel: string; message: string }> = [];
    const bus = new InvalidationBus({
      namespace: "test-ns",
      publisher: {
        publish: (channel, message) => {
          published.push({ channel, message });
          return 1;
        },
      },
    });
    const realtime: unknown[] = [];
    const unsubscribe = bus.subscribe("realtime:attempt", (event) => {
      realtime.push(event.payload);
    });
    await bus.publish("attempt:transition", { attemptId: "attempt-1", status: "SUCCEEDED", merchantId: "merchant-1" });
    unsubscribe();
    expect(realtime).toContainEqual({ attemptId: "attempt-1", status: "SUCCEEDED", merchantId: "merchant-1" });
    expect(published.map((entry) => entry.channel)).toContain("test-ns:invalidation:realtime:attempt");
  });
});
