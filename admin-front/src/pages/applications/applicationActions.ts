import type { GovernanceMode } from "@/pages/merchants/commerceGovernance";

export interface EntityAction<K extends string = string> {
    key: K;
    /** English label key (catalogued). */
    label: string;
    icon: string;
    /** Status/state the API is asked to move the entity to. */
    target: string;
    mode: GovernanceMode;
    danger: boolean;
    /** The action cannot be undone by the same actor (e.g. token revoke, link cancel). */
    irreversible: boolean;
    disabled: boolean;
    disabledReason: string | null;
}

const PENDING_REASON = "A change to this entity is already awaiting approval.";

/* ------------------------------ Application ------------------------------ */

export type ApplicationActionKey = "suspend" | "reactivate" | "editPolicy";

export interface ApplicationActionContext {
    canWrite: boolean;
    hasPendingApproval?: boolean;
}

/**
 * ACTIVE -> SUSPENDED is immediate; SUSPENDED -> ACTIVE and any policy edit
 * (rail whitelist, redirect domains, settlement wallet) are approvals.
 * A CLOSED application accepts no change.
 */
export const applicationActionsFor = (status: string, context: ApplicationActionContext): Array<EntityAction<ApplicationActionKey>> => {
    if (!context.canWrite || status === "CLOSED") return [];
    const pending = context.hasPendingApproval === true;
    const actions: Array<EntityAction<ApplicationActionKey>> = [];
    if (status === "ACTIVE") {
        actions.push({
            key: "suspend",
            label: "Suspend application",
            icon: "mdi-pause-circle-outline",
            target: "SUSPENDED",
            mode: "immediate",
            danger: true,
            irreversible: false,
            disabled: false,
            disabledReason: null,
        });
    }
    if (status === "SUSPENDED") {
        actions.push({
            key: "reactivate",
            label: "Request reactivation",
            icon: "mdi-play-circle-outline",
            target: "ACTIVE",
            mode: "approval",
            danger: false,
            irreversible: false,
            disabled: pending,
            disabledReason: pending ? PENDING_REASON : null,
        });
    }
    actions.push({
        key: "editPolicy",
        label: "Edit policy",
        icon: "mdi-shield-edit-outline",
        target: status,
        mode: "approval",
        danger: false,
        irreversible: false,
        disabled: pending,
        disabledReason: pending ? PENDING_REASON : null,
    });
    return actions;
};

/* ------------------------------ Access token ----------------------------- */

export type TokenActionKey = "revoke";

/** Revocation is immediate and irreversible; an already revoked token has no action. */
export const tokenActionsFor = (status: string, canWrite: boolean): Array<EntityAction<TokenActionKey>> => {
    if (!canWrite || status === "REVOKED") return [];
    return [
        {
            key: "revoke",
            label: "Revoke token",
            icon: "mdi-key-remove",
            target: "REVOKED",
            mode: "immediate",
            danger: true,
            irreversible: true,
            disabled: false,
            disabledReason: null,
        },
    ];
};

/* ------------------------------ Payment link ----------------------------- */

export type PaymentLinkActionKey = "cancel";

/** Only a PENDING link can be cancelled; there is no reactivation. */
export const paymentLinkActionsFor = (state: string, canWrite: boolean): Array<EntityAction<PaymentLinkActionKey>> => {
    if (!canWrite || state !== "PENDING") return [];
    return [
        {
            key: "cancel",
            label: "Cancel link",
            icon: "mdi-link-off",
            target: "CANCELLED",
            mode: "immediate",
            danger: true,
            irreversible: true,
            disabled: false,
            disabledReason: null,
        },
    ];
};

/* ------------------------------ POS terminal ----------------------------- */

export type PosActionKey = "deactivate" | "block" | "activate";

/**
 * ACTIVE -> INACTIVE | BLOCKED and INACTIVE -> BLOCKED tighten (immediate).
 * INACTIVE | BLOCKED -> ACTIVE loosens and needs approval. A BLOCKED terminal
 * can only leave that state through an approved reactivation.
 */
export const posActionsFor = (status: string, canWrite: boolean): Array<EntityAction<PosActionKey>> => {
    if (!canWrite) return [];
    const actions: Array<EntityAction<PosActionKey>> = [];
    if (status === "ACTIVE") {
        actions.push({
            key: "deactivate",
            label: "Deactivate terminal",
            icon: "mdi-power-plug-off-outline",
            target: "INACTIVE",
            mode: "immediate",
            danger: true,
            irreversible: false,
            disabled: false,
            disabledReason: null,
        });
    }
    if (status === "ACTIVE" || status === "INACTIVE") {
        actions.push({
            key: "block",
            label: "Block terminal",
            icon: "mdi-block-helper",
            target: "BLOCKED",
            mode: "immediate",
            danger: true,
            irreversible: false,
            disabled: false,
            disabledReason: null,
        });
    }
    if (status === "INACTIVE" || status === "BLOCKED") {
        actions.push({
            key: "activate",
            label: "Request reactivation",
            icon: "mdi-play-circle-outline",
            target: "ACTIVE",
            mode: "approval",
            danger: false,
            irreversible: false,
            disabled: false,
            disabledReason: null,
        });
    }
    return actions;
};

/* ------------------------------ Redirect domains ------------------------- */

export const MAX_REDIRECT_DOMAINS = 100;
export const MAX_RAIL_CODES = 200;
const MAX_DOMAIN_LENGTH = 253;

/** Mirror of `HOSTNAME` in core-back/api/internal/adminCommerce.ts. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^localhost$/;

export type DomainResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Accepts a bare hostname or an https origin (no credentials, path, query or
 * fragment) and normalises it to lowercase exactly like the server does.
 * Error values are English message keys.
 */
export const normalizeRedirectDomain = (raw: string): DomainResult => {
    const value = raw.trim().toLowerCase();
    if (value.length === 0) return { ok: false, error: "Enter a domain or an https origin." };
    if (value.length > MAX_DOMAIN_LENGTH) return { ok: false, error: "A redirect domain is limited to 253 characters." };
    if (HOSTNAME.test(value)) return { ok: true, value };
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return { ok: false, error: "A redirect domain must be a hostname or an https origin without a path." };
    }
    if (url.protocol !== "https:" || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
        return { ok: false, error: "A redirect domain must be a hostname or an https origin without a path." };
    }
    return { ok: true, value: url.origin };
};

/** Splits pasted text on commas, whitespace and new lines. */
export const splitDomainInput = (text: string): string[] =>
    text
        .split(/[\s,;]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

export interface AddDomainsResult {
    domains: string[];
    /** One entry per rejected input: the raw text and an English message key. */
    errors: Array<{ input: string; error: string }>;
    added: number;
}

/** Adds the domains found in `text` to `current`, de-duplicated, reporting every rejected entry. */
export const addRedirectDomains = (current: readonly string[], text: string): AddDomainsResult => {
    const domains = [...current];
    const errors: Array<{ input: string; error: string }> = [];
    let added = 0;
    for (const input of splitDomainInput(text)) {
        const result = normalizeRedirectDomain(input);
        if (!result.ok) {
            errors.push({ input, error: result.error });
            continue;
        }
        if (domains.includes(result.value)) continue;
        if (domains.length >= MAX_REDIRECT_DOMAINS) {
            errors.push({ input, error: "An application can have at most 100 redirect domains." });
            continue;
        }
        domains.push(result.value);
        added += 1;
    }
    return { domains, errors, added };
};

/* ------------------------------ Rail whitelist --------------------------- */

export type RailWhitelistMode = "ALL" | "NONE" | "LIST";

export const railWhitelistModeOf = (whitelist: readonly string[] | null | undefined): RailWhitelistMode =>
    whitelist === null || whitelist === undefined ? "ALL" : whitelist.length === 0 ? "NONE" : "LIST";

/** `null` = every rail, `[]` = no rail, otherwise the listed codes. */
export const buildRailWhitelist = (mode: RailWhitelistMode, codes: readonly string[]): { ok: true; value: string[] | null } | { ok: false; error: string } => {
    if (mode === "ALL") return { ok: true, value: null };
    if (mode === "NONE") return { ok: true, value: [] };
    const unique = [...new Set(codes.map((code) => code.trim()).filter(Boolean))];
    if (unique.length === 0) return { ok: false, error: "Select at least one rail, or choose all rails or no rails." };
    if (unique.length > MAX_RAIL_CODES) return { ok: false, error: "A whitelist is limited to 200 rails." };
    return { ok: true, value: unique };
};

const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
    if (left.length !== right.length) return false;
    const set = new Set(left);
    return right.every((entry) => set.has(entry));
};

export interface PolicySnapshot {
    assignedWalletId: string | null;
    railWhitelist: string[] | null;
    redirectDomains: string[];
}

export interface PolicyDraft {
    assignedWalletId: string | null;
    railMode: RailWhitelistMode;
    railCodes: string[];
    redirectDomains: string[];
}

export interface PolicyPatch {
    assignedWalletId?: string;
    railWhitelist?: string[] | null;
    redirectDomainAllowlist?: string[];
}

export type PolicyPatchResult =
    | { ok: true; patch: PolicyPatch; changed: string[] }
    | { ok: false; error: string };

/**
 * The PATCH body for a policy edit: only the fields that really changed.
 * Everything in it is approval-based, so an empty change set is rejected here
 * instead of surfacing the server's APPLICATION_NO_CHANGE.
 */
export const buildPolicyPatch = (current: PolicySnapshot, draft: PolicyDraft): PolicyPatchResult => {
    const patch: PolicyPatch = {};
    const changed: string[] = [];
    if (draft.assignedWalletId && draft.assignedWalletId !== current.assignedWalletId) {
        patch.assignedWalletId = draft.assignedWalletId;
        changed.push("assignedWalletId");
    }
    const rails = buildRailWhitelist(draft.railMode, draft.railCodes);
    if (!rails.ok) return rails;
    const currentRails = current.railWhitelist;
    const railsChanged =
        rails.value === null || currentRails === null
            ? rails.value !== currentRails
            : !sameSet(rails.value, currentRails);
    if (railsChanged) {
        patch.railWhitelist = rails.value;
        changed.push("railWhitelist");
    }
    if (draft.redirectDomains.length > MAX_REDIRECT_DOMAINS) {
        return { ok: false, error: "An application can have at most 100 redirect domains." };
    }
    if (!sameSet([...new Set(draft.redirectDomains)], current.redirectDomains)) {
        patch.redirectDomainAllowlist = [...new Set(draft.redirectDomains)];
        changed.push("redirectDomainAllowlist");
    }
    if (changed.length === 0) return { ok: false, error: "Nothing changed: the request matches the current configuration." };
    return { ok: true, patch, changed };
};

/* ------------------------------ Rail options ----------------------------- */

export interface RailChoice {
    code: string;
    title: string;
}

/**
 * The rails option loader (`/options/rails`) answers `{ value: <rail id>,
 * title: "<English name> (<CODE>)" }`, while the whitelist stores rail CODES.
 * The code is therefore taken from the trailing parentheses of the title.
 * Returns null when the title does not carry a code.
 */
export const railCodeFromOptionTitle = (title: string): string | null => {
    const match = /\(([A-Za-z0-9_.-]{1,64})\)\s*$/.exec(title.trim());
    return match?.[1] ?? null;
};

/** Rail choices for the whitelist picker: loader options plus codes already whitelisted but no longer offered. */
export const railChoices = (options: ReadonlyArray<{ title: string }>, current: readonly string[]): RailChoice[] => {
    const byCode = new Map<string, RailChoice>();
    for (const option of options) {
        const code = railCodeFromOptionTitle(option.title);
        if (code && !byCode.has(code)) byCode.set(code, { code, title: option.title });
    }
    for (const code of current) {
        if (!byCode.has(code)) byCode.set(code, { code, title: code });
    }
    return [...byCode.values()].sort((left, right) => left.code.localeCompare(right.code));
};
