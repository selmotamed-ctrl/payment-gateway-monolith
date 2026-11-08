import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_STAMP, frontendFingerprint, isBuildFresh, startFrontendBuilds } from "../lib/frontendBuild";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A tiny frontend whose `build` script really runs: it writes dist/index.html and a build counter. */
const makeRepo = (frontends: Record<string, { build?: string; files?: Record<string, string> }>): string => {
  const root = mkdtempSync(join(tmpdir(), "pg-fe-test-"));
  roots.push(root);
  for (const [name, spec] of Object.entries(frontends)) {
    const dir = join(root, name);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "main.ts"), "export const x = 1;\n");
    for (const [file, content] of Object.entries(spec.files ?? {})) writeFileSync(join(dir, file), content);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name, scripts: { build: spec.build ?? 'mkdir -p dist && echo built > dist/index.html && echo x >> "$COUNTER_FILE"' } }),
    );
  }
  return root;
};

const quiet = (): { logs: string[]; logger: (message: string) => void } => {
  const logs: string[] = [];
  return { logs, logger: (message) => logs.push(message) };
};

describe("frontend fingerprint", () => {
  test("is stable, and changes with sources, build env and added files", () => {
    const root = makeRepo({ web: {} });
    const dir = join(root, "web");
    const base = frontendFingerprint(dir, { VITE_A: "1" });
    expect(frontendFingerprint(dir, { VITE_A: "1" })).toBe(base);
    expect(frontendFingerprint(dir, { VITE_A: "2" })).not.toBe(base);
    writeFileSync(join(dir, "src", "main.ts"), "export const x = 2;\n");
    const edited = frontendFingerprint(dir, { VITE_A: "1" });
    expect(edited).not.toBe(base);
    writeFileSync(join(dir, "src", "new.ts"), "export {};\n");
    expect(frontendFingerprint(dir, { VITE_A: "1" })).not.toBe(edited);
  });

  test("ignores dist, node_modules and logs but not .env files", () => {
    const root = makeRepo({ web: {} });
    const dir = join(root, "web");
    const base = frontendFingerprint(dir, {});
    mkdirSync(join(dir, "dist"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.html"), "x");
    writeFileSync(join(dir, "node_modules", "pkg", "i.js"), "x");
    writeFileSync(join(dir, "build.log"), "x");
    expect(frontendFingerprint(dir, {})).toBe(base);
    writeFileSync(join(dir, ".env.production"), "VITE_X=1\n");
    expect(frontendFingerprint(dir, {})).not.toBe(base);
  });

  test("env ordering does not matter", () => {
    const root = makeRepo({ web: {} });
    const dir = join(root, "web");
    expect(frontendFingerprint(dir, { A: "1", B: "2" })).toBe(frontendFingerprint(dir, { B: "2", A: "1" }));
  });
});

describe("startFrontendBuilds", () => {
  test("builds once, then skips on an unchanged tree, and rebuilds after an edit or --rebuild", async () => {
    const root = makeRepo({ web: {} });
    const counter = join(root, "counter");
    process.env.COUNTER_FILE = counter;
    const count = (): number => (existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").length : 0);
    const run = async (force = false): Promise<boolean> => {
      const handle = startFrontendBuilds({ repoRoot: root, frontends: ["web"], envFor: () => ({}), force, logger: quiet().logger });
      return (await handle.wait("web")).cached;
    };
    expect(await run()).toBe(false);
    expect(count()).toBe(1);
    expect(existsSync(join(root, "web", "dist", BUILD_STAMP))).toBe(true);
    expect(await run()).toBe(true);
    expect(count()).toBe(1);
    writeFileSync(join(root, "web", "src", "main.ts"), "export const x = 3;\n");
    expect(await run()).toBe(false);
    expect(count()).toBe(2);
    expect(await run(true)).toBe(false);
    expect(count()).toBe(3);
  });

  test("a build that rewrites a tracked source file (components.d.ts) still hits the cache next time", async () => {
    const root = makeRepo({
      web: { files: { "gen.d.ts": "// v0\n" }, build: 'mkdir -p dist && echo built > dist/index.html && echo "// generated" > gen.d.ts && echo x >> "$COUNTER_FILE"' },
    });
    const counter = join(root, "counter2");
    process.env.COUNTER_FILE = counter;
    const run = async (): Promise<boolean> =>
      (await startFrontendBuilds({ repoRoot: root, frontends: ["web"], envFor: () => ({}), logger: quiet().logger }).wait("web")).cached;
    expect(await run()).toBe(false);
    expect(await run()).toBe(true);
    expect(readFileSync(counter, "utf8").trim().split("\n").length).toBe(1);
  });

  test("a changed build env invalidates the cache", async () => {
    const root = makeRepo({ web: {} });
    process.env.COUNTER_FILE = join(root, "counter3");
    const run = async (value: string): Promise<boolean> =>
      (await startFrontendBuilds({ repoRoot: root, frontends: ["web"], envFor: () => ({ VITE_SHOW_HELP_PANELS: value }), logger: quiet().logger }).wait("web")).cached;
    expect(await run("false")).toBe(false);
    expect(await run("false")).toBe(true);
    expect(await run("true")).toBe(false);
  });

  test("a failing build rejects with its log tail, and does not stamp the cache", async () => {
    const root = makeRepo({ web: { build: 'echo "type error TS2322 in App.vue" >&2; exit 3' } });
    const handle = startFrontendBuilds({ repoRoot: root, frontends: ["web"], envFor: () => ({}), logger: quiet().logger });
    await expect(handle.wait("web")).rejects.toThrow(/web build failed \(exit 3\).*TS2322/s);
    expect(existsSync(join(root, "web", "dist", BUILD_STAMP))).toBe(false);
    expect(isBuildFresh(join(root, "web"), "anything")).toBe(false);
  });

  test("builds run in parallel up to the limit", async () => {
    const root = makeRepo({
      a: { build: "sleep 1; mkdir -p dist && echo a > dist/index.html" },
      b: { build: "sleep 1; mkdir -p dist && echo b > dist/index.html" },
      c: { build: "sleep 1; mkdir -p dist && echo c > dist/index.html" },
    });
    const started = Date.now();
    const handle = startFrontendBuilds({ repoRoot: root, frontends: ["a", "b", "c"], envFor: () => ({}), maxParallel: 3, logger: quiet().logger });
    const results = await handle.waitAll();
    const elapsed = Date.now() - started;
    expect(results.every((result) => !result.cached)).toBe(true);
    expect(elapsed).toBeLessThan(2600); // serial would be >= 3 s
  });

  test("maxParallel=1 serialises the builds", async () => {
    const root = makeRepo({
      a: { build: "sleep 0.6; mkdir -p dist && echo a > dist/index.html" },
      b: { build: "sleep 0.6; mkdir -p dist && echo b > dist/index.html" },
    });
    const started = Date.now();
    await startFrontendBuilds({ repoRoot: root, frontends: ["a", "b"], envFor: () => ({}), maxParallel: 1, logger: quiet().logger }).waitAll();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1150);
  });

  test("a failure that nobody is waiting on yet does not crash the process", async () => {
    const root = makeRepo({ web: { build: "exit 1" } });
    const handle = startFrontendBuilds({ repoRoot: root, frontends: ["web"], envFor: () => ({}), logger: quiet().logger });
    await new Promise((resolve) => setTimeout(resolve, 700)); // the rejection happens while nobody awaits
    await expect(handle.wait("web")).rejects.toThrow(/build failed/);
  });

  test("abort() stops builds that are still running", async () => {
    const root = makeRepo({ web: { build: "sleep 30; mkdir -p dist && echo x > dist/index.html" } });
    const handle = startFrontendBuilds({ repoRoot: root, frontends: ["web"], envFor: () => ({}), logger: quiet().logger });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    handle.abort();
    await expect(handle.wait("web")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("waiting for an unknown frontend is an error", async () => {
    const root = makeRepo({ web: {} });
    process.env.COUNTER_FILE = join(root, "c");
    const handle = startFrontendBuilds({ repoRoot: root, frontends: ["web"], envFor: () => ({}), logger: quiet().logger });
    await expect(handle.wait("nope")).rejects.toThrow(/no build was started/);
    await handle.waitAll();
  });
});
