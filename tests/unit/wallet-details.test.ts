import { describe, expect, test } from "vitest";
import { accountLineFilters, netChangeOf } from "@/components/ledger/accountLinesModel";
import { referenceRouteOfRefType } from "@/components/ledger/journalModel";
import { WALLET_TABS, parseWalletTab, postedSinceCheckpoint, shardIntegrity, shardTotalNatural, statusChangeOf } from "@/pages/wallets/walletModel";

describe("wallet page tabs live in the URL", () => {
  test("an unknown or missing tab falls back to the overview", () => {
    expect(parseWalletTab(undefined)).toBe("overview");
    expect(parseWalletTab("nope")).toBe("overview");
    expect(parseWalletTab(["statement", "links"])).toBe("statement");
    for (const tab of WALLET_TABS) expect(parseWalletTab(tab)).toBe(tab);
  });
});

describe("shard integrity of a wallet", () => {
  const shards = [{ currentBalance: "-50.0000" }, { currentBalance: "-20.0000" }];

  test("shards are stored debit-positive; the total is read in the wallet's natural sign", () => {
    expect(shardTotalNatural("MERCHANT_WALLET", shards)).toBe("70.0000");
    expect(shardTotalNatural("MERCHANT_WALLET", [])).toBe("0.0000");
  });

  test("agrees when the live balance equals the shard total", () => {
    expect(shardIntegrity("MERCHANT_WALLET", shards, "70.0000")).toEqual({ shardTotal: "70.0000", drift: "0.0000", matches: true });
  });

  test("reports the drift when they differ, without floating point error", () => {
    const result = shardIntegrity("MERCHANT_WALLET", [{ currentBalance: "-0.1000" }, { currentBalance: "-0.2000" }], "0.4000");
    expect(result).toEqual({ shardTotal: "0.3000", drift: "0.1000", matches: false });
  });

  test("is not applicable without shards or without permission to see money", () => {
    expect(shardIntegrity("MERCHANT_WALLET", [], "70.0000")).toBeNull();
    expect(shardIntegrity("MERCHANT_WALLET", shards, null)).toBeNull();
  });
});

describe("posted since checkpoint", () => {
  test("is live minus checkpoint, both in the natural sign", () => {
    expect(postedSinceCheckpoint("125.5000", "100.0000")).toBe("25.5000");
    expect(postedSinceCheckpoint("90.0000", "100.0000")).toBe("-10.0000");
    expect(postedSinceCheckpoint("100.0000", "100.0000")).toBe("0.0000");
  });
  test("is unknown when either balance is hidden", () => {
    expect(postedSinceCheckpoint(null, "1.0000")).toBeNull();
    expect(postedSinceCheckpoint("1.0000", null)).toBeNull();
  });
});

describe("status history rows", () => {
  test("read the transition and the reason; redacted events give nothing", () => {
    expect(statusChangeOf({ before: { status: "ACTIVE" }, after: { status: "FROZEN", reason: "AML case 1042 is open" } })).toEqual({
      from: "ACTIVE",
      to: "FROZEN",
      reason: "AML case 1042 is open",
    });
    expect(statusChangeOf({ before: null, after: null })).toEqual({ from: null, to: null, reason: null });
  });
});

describe("statement lines table model", () => {
  test("net change is shown in the account's natural sign (a credit grows a wallet)", () => {
    expect(netChangeOf("MERCHANT_WALLET", { netDebit: "-70.0000" })).toBe("70.0000");
    expect(netChangeOf("TREASURY", { netDebit: "70.0000" })).toBe("70.0000");
    expect(netChangeOf("MERCHANT_WALLET", { netDebit: "0.0000" })).toBe("0.0000");
    expect(netChangeOf("MERCHANT_WALLET", { netDebit: null })).toBeNull();
    expect(netChangeOf("MERCHANT_WALLET", null)).toBeNull();
  });

  test("filters map to the query parameters the lines endpoints accept", () => {
    expect(accountLineFilters.map((filter) => filter.key)).toEqual(["direction", "refType", "date"]);
    const date = accountLineFilters.find((filter) => filter.key === "date");
    expect(date).toMatchObject({ type: "date", queryFrom: "from", queryTo: "to" });
  });

  test("only reference types that have an open-by-id page are linkable", () => {
    expect(referenceRouteOfRefType("PAYMENT_ATTEMPT")).toBe("attempt");
    expect(referenceRouteOfRefType("ADJUSTMENT")).toBe("adjustment");
    expect(referenceRouteOfRefType("AML_RELEASE")).toBe("aml-case");
    expect(referenceRouteOfRefType("DISPUTE_OUTCOME")).toBe("dispute");
    expect(referenceRouteOfRefType("SETTLEMENT_SWEEP")).toBeNull();
    expect(referenceRouteOfRefType(undefined)).toBeNull();
  });
});
