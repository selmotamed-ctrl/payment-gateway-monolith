import { describe, expect, test } from "vitest";
import {
    DISPUTE_OPEN_STATES,
    DISPUTE_RESOLVED_STATES,
    disputeViewFilters,
    initialDisputeFilters,
    queryString,
} from "../queryFilters";

describe("dispute query filters", () => {
    test("reads route query strings, including repeated keys", () => {
        expect(queryString("  abc  ")).toBe("abc");
        expect(queryString(["", "  def  "])).toBe("def");
        expect(queryString(undefined)).toBe("");
        expect(queryString(["", "   "])).toBe("");
    });

    test("an attempt link starts on the All view with the attempt and merchant filters", () => {
        const filters = initialDisputeFilters("attempt-1", "merchant-1");
        expect(filters).toEqual({ merchantId: "merchant-1", attemptId: "attempt-1" });
        expect(filters.status).toBeUndefined();
    });

    test("a merchant-only link keeps the open scope", () => {
        expect(initialDisputeFilters("", "merchant-1")).toEqual({
            merchantId: "merchant-1",
            status: [...DISPUTE_OPEN_STATES],
        });
    });

    test("without a link the page keeps the open queue", () => {
        expect(initialDisputeFilters("", "")).toEqual({ status: [...DISPUTE_OPEN_STATES] });
    });

    test("view changes preserve attempt scope and replace the status scope", () => {
        expect(disputeViewFilters("open", { attemptId: "attempt-1", merchantId: "merchant-1" })).toEqual({
            attemptId: "attempt-1",
            merchantId: "merchant-1",
            status: [...DISPUTE_OPEN_STATES],
        });
        expect(disputeViewFilters("resolved", { attemptId: "attempt-1" })).toEqual({
            attemptId: "attempt-1",
            status: [...DISPUTE_RESOLVED_STATES],
        });
        expect(disputeViewFilters("all", { attemptId: "attempt-1" })).toEqual({ attemptId: "attempt-1" });
    });
});
