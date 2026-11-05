/** Pure helpers for the backups admin page (validation, text clipping, action gating). */

export const clipServerText = (text: unknown, max = 200): string => {
    // Strip control characters (incl. newlines) and cap the length of server-supplied text.
    const clean = String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

export const canRunBackupActions = (overview: { configured?: boolean; daemonReachable?: boolean } | null | undefined): boolean =>
    !!overview && overview.configured === true && overview.daemonReachable === true;

/** Full backup of every target is the expensive/disruptive combination and needs an extra confirmation. */
export const needsExtraConfirm = (form: { kind: string; target: string }): boolean =>
    form.kind === "full" && form.target === "all";

const fallbackRandomId = (): string => {
    const webCrypto = globalThis.crypto;
    if (webCrypto && typeof webCrypto.randomUUID === "function") {
        return webCrypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (webCrypto && typeof webCrypto.getRandomValues === "function") {
        webCrypto.getRandomValues(bytes);
    } else {
        for (let index = 0; index < bytes.length; index += 1) {
            bytes[index] = Math.floor(Math.random() * 256);
        }
    }
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export const newIdempotencyKey = (): string => `bkp-${fallbackRandomId()}`;

export type PolicyForm = {
    fullCron: string;
    deltaCron: string;
    drillCron: string;
    fullRetentionDays: string;
    walRetentionDays: string;
    alertLagSeconds: string;
};

const CRON_FIELD = /^(?:[\d*/,\-?LW#]+|[A-Za-z]{3}(?:[-,][A-Za-z]{3})*)$/;

export const isPlausibleCron = (value: string): boolean => {
    const parts = value.trim().split(/\s+/);
    return (parts.length === 5 || parts.length === 6) && parts.every((p) => CRON_FIELD.test(p));
};

const RANGES = {
    fullRetentionDays: [1, 3650],
    walRetentionDays: [1, 3650],
    alertLagSeconds: [1, 86400],
} as const;

export type PolicyValue = {
    fullCron: string;
    deltaCron: string;
    drillCron: string;
    fullRetentionDays: number;
    walRetentionDays: number;
    alertLagSeconds: number;
};

export type PolicyValidation = { ok: true; value: PolicyValue } | { ok: false };

export const validatePolicyForm = (form: PolicyForm): PolicyValidation => {
    const crons = [form.fullCron, form.deltaCron, form.drillCron].map((c) => c.trim());
    if (!crons.every((c) => c && isPlausibleCron(c))) {
        return { ok: false };
    }
    const ints: Record<string, number> = {};
    for (const key of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
        const raw = form[key].trim();
        if (!/^\d+$/.test(raw)) {
            return { ok: false };
        }
        const n = Number(raw);
        const [min, max] = RANGES[key];
        if (!Number.isInteger(n) || n < min || n > max) {
            return { ok: false };
        }
        ints[key] = n;
    }
    return {
        ok: true,
        value: {
            fullCron: crons[0]!,
            deltaCron: crons[1]!,
            drillCron: crons[2]!,
            fullRetentionDays: ints.fullRetentionDays!,
            walRetentionDays: ints.walRetentionDays!,
            alertLagSeconds: ints.alertLagSeconds!,
        },
    };
};
