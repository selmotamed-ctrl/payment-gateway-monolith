import { describe, expect, test } from "bun:test";
import {
  CommandTimeoutError,
  SpawnCommandRunner,
  type SpawnFn,
  type SpawnedProcessLike,
} from "../src/commandRunner";

const streamOf = (value: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });

const emptyStream = (): ReadableStream<Uint8Array> => streamOf("");

describe("command runner", () => {
  test("dry-run records commands without spawning them", async () => {
    const runner = new SpawnCommandRunner({ dryRun: true });
    const result = await runner.run("wal-g", ["backup-push", "/var/lib/postgresql/18/main"], {
      env: { WALG_S3_PREFIX: "s3://bucket", AWS_SECRET_ACCESS_KEY: "hidden" },
      timeoutMs: 1234,
    });
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(runner.recorded).toEqual([
      {
        command: "wal-g",
        args: ["backup-push", "/var/lib/postgresql/18/main"],
        envKeys: ["WALG_S3_PREFIX", "AWS_SECRET_ACCESS_KEY"],
        timeoutMs: 1234,
      },
    ]);
  });

  test("passes arguments as argv and never through a shell", async () => {
    let capturedArgv: string[] = [];
    const spawn: SpawnFn = (argv): SpawnedProcessLike => {
      capturedArgv = argv;
      return { stdout: streamOf(argv.slice(1).join("|")), stderr: emptyStream(), exited: Promise.resolve(0) };
    };
    const runner = new SpawnCommandRunner({ spawn });
    const result = await runner.run("fake", ["one two", "semi;colon", "$(not-a-substitution)"]);
    expect(result.code).toBe(0);
    expect(capturedArgv).toEqual(["fake", "one two", "semi;colon", "$(not-a-substitution)"]);
    expect(result.stdout).toBe("one two|semi;colon|$(not-a-substitution)");
  });

  test("kills and reports commands that exceed their timeout", async () => {
    const spawn: SpawnFn = (_argv, options): SpawnedProcessLike => {
      const exited = new Promise<number>((resolve) => {
        options.signal.addEventListener("abort", () => resolve(137), { once: true });
      });
      return { stdout: emptyStream(), stderr: emptyStream(), exited };
    };
    const runner = new SpawnCommandRunner({ spawn });
    await expect(runner.run("fake-sleeper", [], { timeoutMs: 20 })).rejects.toBeInstanceOf(CommandTimeoutError);
  });
});
