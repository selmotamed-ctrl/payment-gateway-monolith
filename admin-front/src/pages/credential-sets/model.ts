/**
 * Pure model of the credential set vault page. Secrets are write only: the UI never receives a
 * stored value back, so a rotation always re-enters the whole entry list.
 */

export const ENTRY_TYPES = ["HEADER", "QUERY", "BODY", "CERTIFICATE"] as const;
export type CredentialEntryType = (typeof ENTRY_TYPES)[number];

export const ENV_VALUES = ["SANDBOX", "LIVE"] as const;
export const OWNER_TYPES = ["PLATFORM", "MERCHANT"] as const;
export const SETTLEMENT_TARGETS = ["PLATFORM_CLEARING", "MERCHANT_DIRECT", "PROVIDER_HELD"] as const;
export const CREDENTIAL_STATUSES = ["UNTESTED", "VERIFIED", "FAILING", "REVOKED"] as const;

export interface EntryDraft {
    /** Local id so rows keep their identity while the list is edited. */
    uid: number;
    key: string;
    type: CredentialEntryType;
    value: string;
    isSecret: boolean;
}

export interface CredentialEntryPayload {
    key: string;
    type: CredentialEntryType;
    value: string;
    isSecret: boolean;
}

export const MAX_ENTRIES = 40;
export const MAX_KEY_LENGTH = 64;
export const MAX_VALUE_LENGTH = 4096;

let nextUid = 1;
export const newEntry = (partial: Partial<Omit<EntryDraft, "uid">> = {}): EntryDraft => ({
    uid: nextUid++,
    key: partial.key ?? "",
    type: partial.type ?? "HEADER",
    value: partial.value ?? "",
    isSecret: partial.isSecret ?? true,
});

/** Detail rows carry only key/type/isSecret (the value is a placeholder); values must be typed again. */
export const draftsFromDetail = (entries: ReadonlyArray<{ key: string; type: string; isSecret: boolean }> | null | undefined): EntryDraft[] =>
    (entries ?? []).map((entry) =>
        newEntry({
            key: entry.key,
            type: (ENTRY_TYPES as readonly string[]).includes(entry.type) ? (entry.type as CredentialEntryType) : "HEADER",
            isSecret: entry.isSecret,
            value: "",
        }),
    );

export type EntryError = "KEY_REQUIRED" | "KEY_TOO_LONG" | "KEY_DUPLICATE" | "VALUE_REQUIRED" | "VALUE_TOO_LONG";

export interface EntryValidation {
    ok: boolean;
    /** Error code per entry uid. */
    errors: Record<number, EntryError>;
    tooMany: boolean;
    empty: boolean;
}

export const validateEntries = (entries: readonly EntryDraft[]): EntryValidation => {
    const errors: Record<number, EntryError> = {};
    const seen = new Set<string>();
    for (const entry of entries) {
        const key = entry.key.trim();
        if (!key) {
            errors[entry.uid] = "KEY_REQUIRED";
            continue;
        }
        if (key.length > MAX_KEY_LENGTH) {
            errors[entry.uid] = "KEY_TOO_LONG";
            continue;
        }
        const identity = `${entry.type}:${key.toLowerCase()}`;
        if (seen.has(identity)) {
            errors[entry.uid] = "KEY_DUPLICATE";
            continue;
        }
        seen.add(identity);
        if (entry.value === "") {
            errors[entry.uid] = "VALUE_REQUIRED";
        } else if (entry.value.length > MAX_VALUE_LENGTH) {
            errors[entry.uid] = "VALUE_TOO_LONG";
        }
    }
    const tooMany = entries.length > MAX_ENTRIES;
    const empty = entries.length === 0;
    return { ok: !tooMany && !empty && Object.keys(errors).length === 0, errors, tooMany, empty };
};

export const toEntriesPayload = (entries: readonly EntryDraft[]): CredentialEntryPayload[] =>
    entries.map((entry) => ({ key: entry.key.trim(), type: entry.type, value: entry.value, isSecret: entry.isSecret }));

export interface CreateDraft {
    gatewayCode: string;
    env: string;
    ownerType: string;
    ownerMerchantId: string;
    externalMerchantId: string;
    settlementTarget: string;
}

export type CreateError = "GATEWAY_REQUIRED" | "OWNER_MERCHANT_REQUIRED" | "EXTERNAL_ID_LENGTH";

export const validateCreateDraft = (draft: CreateDraft): CreateError[] => {
    const errors: CreateError[] = [];
    if (!draft.gatewayCode.trim()) errors.push("GATEWAY_REQUIRED");
    if (draft.ownerType === "MERCHANT" && !draft.ownerMerchantId.trim()) errors.push("OWNER_MERCHANT_REQUIRED");
    const external = draft.externalMerchantId.trim();
    if (external && (external.length < 2 || external.length > 120)) errors.push("EXTERNAL_ID_LENGTH");
    return errors;
};

/** The core schema is strict: optional fields are omitted, never sent empty. */
export const toCreatePayload = (draft: CreateDraft, entries: readonly EntryDraft[]): Record<string, unknown> => ({
    gatewayCode: draft.gatewayCode.trim(),
    env: draft.env,
    ownerType: draft.ownerType,
    ...(draft.ownerType === "MERCHANT" && draft.ownerMerchantId.trim() ? { ownerMerchantId: draft.ownerMerchantId.trim() } : {}),
    ...(draft.externalMerchantId.trim() ? { externalMerchantId: draft.externalMerchantId.trim() } : {}),
    settlementTarget: draft.settlementTarget,
    entries: toEntriesPayload(entries),
});

export type CredentialAction = "verify" | "rotate" | "revoke";

/** A revoked credential set is terminal: nothing may be done to it from the console. */
export const availableActions = (status: string | null | undefined, canWrite: boolean): CredentialAction[] => {
    if (!canWrite || status === "REVOKED") return [];
    return ["verify", "rotate", "revoke"];
};

/** Credential sets expire; flag the ones that are already past or about to be (14 days). */
export const expiryState = (expiresAt: string | null | undefined, now: number = Date.now()): "none" | "expired" | "soon" | "ok" => {
    if (!expiresAt) return "none";
    const time = new Date(expiresAt).getTime();
    if (Number.isNaN(time)) return "none";
    if (time <= now) return "expired";
    return time - now <= 14 * 86_400_000 ? "soon" : "ok";
};

export type StatusTone = "success" | "warning" | "danger" | "neutral";

export const credentialStatusTone = (status: string | null | undefined): StatusTone => {
    switch (status) {
        case "VERIFIED":
            return "success";
        case "FAILING":
            return "danger";
        case "UNTESTED":
            return "warning";
        default:
            return "neutral";
    }
};

/** `?highlight=<id>` from the merchant 360 or the global search; anything but a non-empty string is ignored. */
export const highlightIdFromQuery = (value: unknown): string | null => {
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === "string" && first.trim() ? first.trim() : null;
};

export const emptyCreateDraft = (): CreateDraft => ({
    gatewayCode: "",
    env: "SANDBOX",
    ownerType: "PLATFORM",
    ownerMerchantId: "",
    externalMerchantId: "",
    settlementTarget: "PLATFORM_CLEARING",
});

/** A merchant-owned set settles to the merchant by default, a platform one to platform clearing. */
export const defaultSettlementFor = (ownerType: string): string => (ownerType === "MERCHANT" ? "MERCHANT_DIRECT" : "PLATFORM_CLEARING");
