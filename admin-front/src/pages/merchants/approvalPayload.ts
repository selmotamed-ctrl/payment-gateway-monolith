/**
 * Human-readable rows for the `payloadDiffJson` of the commerce approval
 * requests (WALLET, APPLICATION, POS_TERMINAL). The backend stores a flat
 * object `{ action, fromStatus?, toStatus?, status?, railWhitelist?, ... , reason }`.
 * Rendering raw JSON is forbidden, so this turns it into labelled rows.
 */

export type ApprovalPayloadRow =
    | { key: string; label: string; kind: "text"; value: string }
    | { key: string; label: string; kind: "status"; value: string }
    | { key: string; label: string; kind: "mono"; value: string }
    | { key: string; label: string; kind: "chips"; value: string[]; emptyLabel: string };

/** English label keys (catalogued). */
export const APPROVAL_ACTION_LABELS: Record<string, string> = {
    WALLET_UNFREEZE: "Unfreeze wallet",
    APPLICATION_REACTIVATE: "Reactivate application",
    APPLICATION_UPDATE: "Update application policy",
    POS_TERMINAL_REACTIVATE: "Reactivate POS terminal",
};

const humanize = (raw: string): string =>
    raw
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (letter) => letter.toUpperCase());

export const approvalActionLabel = (action: string | null | undefined): string =>
    action ? APPROVAL_ACTION_LABELS[action] ?? humanize(action) : "Change request";

const HIDDEN_KEYS = new Set(["action", "reason", "baseUpdatedAt"]);

const asStringList = (value: unknown): string[] | null =>
    Array.isArray(value) ? value.map((entry) => String(entry)) : null;

export const describeApprovalPayload = (payload: unknown): ApprovalPayloadRow[] => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
    const source = payload as Record<string, unknown>;
    const rows: ApprovalPayloadRow[] = [];
    if (typeof source.fromStatus === "string") rows.push({ key: "fromStatus", label: "Current status", kind: "status", value: source.fromStatus });
    const target = typeof source.toStatus === "string" ? source.toStatus : typeof source.status === "string" ? source.status : null;
    if (target) rows.push({ key: "toStatus", label: "Requested status", kind: "status", value: target });
    if (typeof source.assignedWalletId === "string") rows.push({ key: "assignedWalletId", label: "New settlement wallet", kind: "mono", value: source.assignedWalletId });
    if ("railWhitelist" in source) {
        const list = asStringList(source.railWhitelist);
        rows.push(
            list === null
                ? { key: "railWhitelist", label: "Rail whitelist", kind: "text", value: "All active rails allowed" }
                : { key: "railWhitelist", label: "Rail whitelist", kind: "chips", value: list, emptyLabel: "No rails allowed" },
        );
    }
    if ("redirectDomainAllowlist" in source) {
        rows.push({
            key: "redirectDomainAllowlist",
            label: "Redirect domains",
            kind: "chips",
            value: asStringList(source.redirectDomainAllowlist) ?? [],
            emptyLabel: "No redirect domains",
        });
    }
    for (const [key, value] of Object.entries(source)) {
        if (HIDDEN_KEYS.has(key) || ["fromStatus", "toStatus", "status", "assignedWalletId", "railWhitelist", "redirectDomainAllowlist"].includes(key)) continue;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            rows.push({ key, label: humanize(key.replace(/([a-z])([A-Z])/g, "$1_$2")), kind: "text", value: String(value) });
        }
    }
    return rows;
};
