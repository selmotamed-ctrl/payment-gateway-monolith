/**
 * AUTO-28 certbot renewal scheduling: the files the deploy writes are valid, the deploy hook never reloads a broken
 * Nginx, and the enable script degrades to a warning on a host without certbot or systemd.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CERTBOT_TIMER_UNIT,
  certbotDeployHook,
  certbotRenewalEnableScript,
  certbotRenewalService,
  certbotRenewalTimer,
} from "../lib/certRenewal";

const dirs: string[] = [];
const sandbox = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pg-certbot-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Writes an executable stub that appends its arguments to `calls.log` and exits with `code`. */
const stub = (dir: string, name: string, code = 0): void => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "${join(dir, "calls.log")}"\nexit ${code}\n`);
  chmodSync(path, 0o755);
};

const runScript = (script: string, dir: string): { status: number | null; out: string; calls: string } => {
  const file = join(dir, "script.sh");
  writeFileSync(file, script);
  // PATH is the stub directory ONLY (the scripts use shell builtins and the stubs): no real nginx, certbot or systemctl
  // can be reached, and "no systemctl" really means none.
  const result = spawnSync("/bin/sh", [file], { encoding: "utf8", env: { PATH: dir }, timeout: 10_000 });
  let calls = "";
  try {
    calls = readFileSync(join(dir, "calls.log"), "utf8");
  } catch {
    calls = "";
  }
  return { status: result.status, out: `${result.stdout}${result.stderr}`, calls };
};

describe("certbot renewal files", () => {
  test("the unit files carry what systemd needs", () => {
    const service = certbotRenewalService();
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("certbot renew --quiet");
    const timer = certbotRenewalTimer();
    expect(timer).toContain("OnCalendar=*-*-* 03,15:00:00");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("RandomizedDelaySec=3600");
    expect(timer).toContain("WantedBy=timers.target");
    expect(CERTBOT_TIMER_UNIT).toBe("pg-certbot-renew.timer");
  });

  test("the deploy hook reloads Nginx only after the configuration test passes", () => {
    const ok = sandbox();
    stub(ok, "nginx", 0);
    stub(ok, "systemctl", 0);
    const passed = runScript(certbotDeployHook(), ok);
    expect(passed.status).toBe(0);
    expect(passed.calls.split("\n").filter(Boolean)).toEqual(["nginx -t", "systemctl reload nginx"]);

    const broken = sandbox();
    stub(broken, "nginx", 1);
    stub(broken, "systemctl", 0);
    const failed = runScript(certbotDeployHook(), broken);
    expect(failed.status).not.toBe(0);
    expect(failed.calls).toContain("nginx -t");
    expect(failed.calls).not.toContain("reload");
  });

  test("without systemctl the hook falls back to nginx -s reload", () => {
    const dir = sandbox();
    stub(dir, "nginx", 0);
    const result = runScript(certbotDeployHook(), dir);
    expect(result.status).toBe(0);
    expect(result.calls.split("\n").filter(Boolean)).toEqual(["nginx -t", "nginx -s reload"]);
  });

  test("the enable script enables the timer when certbot and systemd exist", () => {
    const dir = sandbox();
    stub(dir, "certbot");
    stub(dir, "systemctl");
    const result = runScript(certbotRenewalEnableScript(), dir);
    expect(result.status).toBe(0);
    expect(result.calls.split("\n").filter(Boolean)).toEqual(["systemctl daemon-reload", `systemctl enable --now ${CERTBOT_TIMER_UNIT}`]);
  });

  test("a host without certbot, or without systemd, gets a warning and the deploy does not fail", () => {
    const noCertbot = sandbox();
    stub(noCertbot, "systemctl");
    const first = runScript(certbotRenewalEnableScript(), noCertbot);
    expect(first.status).toBe(0);
    expect(first.out).toMatch(/certbot is not installed.*NOT scheduled/);
    expect(first.calls).toBe("");

    const noSystemd = sandbox();
    stub(noSystemd, "certbot");
    const second = runScript(certbotRenewalEnableScript(), noSystemd);
    expect(second.status).toBe(0);
    expect(second.out).toMatch(/systemd is not available.*NOT scheduled/);
  });
});
