import { describe, expect, test } from "vitest";
import { assertBundleNotOlderThanInstalled } from "@/lib/updates";

describe("content update rollback protection", () => {
    const installed = "2026-11-07T00:00:00.000Z";

    test("an older authenticated bundle is refused, whatever its manifest says", () => {
        expect(() => assertBundleNotOlderThanInstalled(installed, "2026-11-01T00:00:00.000Z")).toThrow(/older than the installed/);
    });

    test("the same or a newer bundle is accepted", () => {
        expect(() => assertBundleNotOlderThanInstalled(installed, installed)).not.toThrow();
        expect(() => assertBundleNotOlderThanInstalled(installed, "2026-11-08T00:00:00.000Z")).not.toThrow();
    });

    test("a bundle without a valid generation date is refused", () => {
        expect(() => assertBundleNotOlderThanInstalled(installed, "")).toThrow(/valid generation date/);
        expect(() => assertBundleNotOlderThanInstalled(installed, "not a date")).toThrow(/valid generation date/);
    });

    test("an unreadable installed date does not block a first update", () => {
        expect(() => assertBundleNotOlderThanInstalled("", "2026-11-08T00:00:00.000Z")).not.toThrow();
    });
});
