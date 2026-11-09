import { describe, expect, test } from "bun:test";
import { bootstrapGaps, hostProbeScript } from "../lib/hostProbe";

describe("DEPLOY_MODE=auto host probe", () => {
  test("the probe is read-only and checks nginx only where a portal is served", () => {
    const edge = hostProbeScript({ nginx: true });
    const coreOnly = hostProbeScript({ nginx: false });
    for (const script of [edge, coreOnly]) {
      expect(script).toContain("/usr/local/bin/bun");
      expect(script).toContain(".bun/bin/pm2");
      expect(script).toContain("rsync");
      // Nothing is installed, written or removed by the probe.
      expect(script).not.toMatch(/apt|dnf|pacman|install|curl -|wget|rm |tee |>>/);
      // The only redirect allowed is the silencing of `command -v`.
      expect(script.replaceAll(">/dev/null 2>&1", "")).not.toContain(">");
    }
    expect(edge).toContain("nginx=ok");
    expect(coreOnly).not.toContain("nginx");
  });

  test("a complete host has no gaps", () => {
    expect(bootstrapGaps("rsync=ok\ncurl=ok\nnginx=ok\nbun=ok\npm2=ok\n")).toEqual([]);
  });

  test("every missing requirement is reported", () => {
    expect(bootstrapGaps("rsync=ok\ncurl=ok\nnginx=missing\nbun=missing\npm2=missing\n")).toEqual(["nginx", "bun", "pm2"]);
    expect(bootstrapGaps("rsync=missing\r\ncurl=ok\r\nbun=ok\r\npm2=ok\r\n")).toEqual(["rsync"]);
  });

  test("an empty or garbled answer is a failed probe, never 'nothing is missing'", () => {
    for (const output of ["", "   \n", "Permission denied (publickey).", "bash: awk: command not found"]) {
      expect(bootstrapGaps(output)).toEqual(["probe-failed"]);
    }
  });

  test("noise around the answer is ignored", () => {
    expect(bootstrapGaps("Warning: Permanently added host\nrsync=ok\ncurl=ok\nbun=ok\npm2=missing\nbye\n")).toEqual(["pm2"]);
  });
});
