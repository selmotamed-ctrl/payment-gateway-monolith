import Decimal from "decimal.js";
import { flipToNatural } from "@/components/ledger/journalModel";
import type { WalletAuditEvent } from "./types";

/** Tabs of the wallet page; the value is kept in `?tab=` so a refresh or a shared link lands on the same tab. */
export const WALLET_TABS = ["overview", "statement", "links", "activity"] as const;
export type WalletTab = (typeof WALLET_TABS)[number];

export const parseWalletTab = (value: unknown): WalletTab => {
    const raw = Array.isArray(value) ? value[0] : value;
    return (WALLET_TABS as readonly string[]).includes(String(raw)) ? (String(raw) as WalletTab) : "overview";
};

/** Sum of the shard rows in the wallet's natural sign (shards are stored debit-positive). */
export const shardTotalNatural = (accountType: string, shards: ReadonlyArray<{ currentBalance: string }>): string => {
    let stored = new Decimal(0);
    for (const shard of shards) {
        try {
            stored = stored.plus(new Decimal(shard.currentBalance || "0"));
        } catch {
            // an unreadable shard value counts as zero; the integrity badge then reports the drift
        }
    }
    return flipToNatural(accountType, stored.toFixed(4));
};

export interface ShardIntegrity {
    /** Sum of the shards in the wallet's natural sign. */
    shardTotal: string;
    /** Live balance minus the shard total; zero when they agree. */
    drift: string;
    matches: boolean;
}

/**
 * The live balance of a wallet comes from the shard total, so the two must agree. A difference
 * means the page is showing inconsistent data and is worth a finance review. `null` when the
 * comparison is meaningless (no shard rows, or the role may not see money).
 */
export const shardIntegrity = (
    accountType: string,
    shards: ReadonlyArray<{ currentBalance: string }>,
    liveBalance: string | null,
): ShardIntegrity | null => {
    if (liveBalance === null || shards.length === 0) return null;
    try {
        const shardTotal = shardTotalNatural(accountType, shards);
        const drift = new Decimal(liveBalance).minus(new Decimal(shardTotal));
        return { shardTotal, drift: drift.toFixed(4), matches: drift.isZero() };
    } catch {
        return null;
    }
};

/** Posted since the last checkpoint rollup (both balances are in the natural sign). */
export const postedSinceCheckpoint = (liveBalance: string | null, checkpointBalance: string | null): string | null => {
    if (liveBalance === null || checkpointBalance === null) return null;
    try {
        return new Decimal(liveBalance).minus(new Decimal(checkpointBalance)).toFixed(4);
    } catch {
        return null;
    }
};

export interface StatusChange {
    from: string | null;
    to: string | null;
    reason: string | null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/** The status transition and reason recorded by a wallet audit event (`null` fields when redacted). */
export const statusChangeOf = (event: Pick<WalletAuditEvent, "before" | "after">): StatusChange => ({
    from: text(event.before?.status),
    to: text(event.after?.status),
    reason: text(event.after?.reason),
});
