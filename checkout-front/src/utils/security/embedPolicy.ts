/**
 * Security policy for the embedded-widget renderer (scripts, iframes, SRI, sandbox).
 *
 * Pure TypeScript (no Vue, no `@/` aliases) so it is unit-testable directly.
 *
 * The allow-list holds bare ORIGINS (`https://host[:port]`) and is compared against
 * `new URL(src).origin` with exact equality: no wildcard subdomains, https only.
 */

const PRODUCTION_ORIGINS: readonly string[] = [
    "https://payments.moamalat.ly",
    "https://secure.moamalat.ly",
    "https://pay.evowallet.net",
    "https://js.numo-pay.com",
];

/** Only ever added to the allow-list in non-production builds. */
const NON_PRODUCTION_ORIGINS: readonly string[] = ["https://test.mpgmerchant.test"];

export const getEmbedAllowlist = (nonProduction: boolean): ReadonlySet<string> =>
    new Set([...PRODUCTION_ORIGINS, ...(nonProduction ? NON_PRODUCTION_ORIGINS : [])]);

/** True only for non-production builds (`vite dev` / a MODE other than "production"). */
export const isNonProductionBuild = (): boolean => {
    const env = ((import.meta as unknown as { env?: Record<string, unknown> }).env ?? {}) as Record<string, unknown>;
    return env.DEV === true || (typeof env.MODE === "string" && env.MODE !== "production" && env.PROD !== true);
};

/** The local Fake Rails emulator is plain http on loopback; every other origin must be https. */
export const isLoopbackHttpOrigin = (origin: string): boolean => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);

const parseOrigin = (url: unknown): string | null => {
    if (typeof url !== "string" || !url) {
        return null;
    }
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) {
            return null;
        }
        if (parsed.protocol === "https:") {
            return parsed.origin;
        }
        if (parsed.protocol === "http:" && isLoopbackHttpOrigin(parsed.origin)) {
            return parsed.origin;
        }
        return null;
    } catch {
        return null;
    }
};

export const isAllowedEmbedUrl = (url: unknown, allowlist: ReadonlySet<string>): boolean => {
    const origin = parseOrigin(url);
    return origin !== null && (allowlist.has(origin) || isLoopbackHttpOrigin(origin));
};

/** Normalises a server-supplied `allowed_origins` list to exact https origins (invalid entries dropped). */
export const normalizeOrigins = (origins: unknown): string[] => {
    if (!Array.isArray(origins)) {
        return [];
    }
    const out = new Set<string>();
    for (const entry of origins) {
        const origin = parseOrigin(entry);
        if (origin) {
            out.add(origin);
        }
    }
    return [...out];
};

const SRI_PATTERN = /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

export type ScriptPlan = { url: string; integrity: string };

/**
 * Builds the list of scripts to load. Hash `i` of the server list belongs to script `i`
 * of the server list (matched by index BEFORE filtering). A script without its own valid
 * SRI hash is rejected: there is no fallback to another script's hash.
 */
export const planEmbedScripts = (
    scriptUrls: unknown,
    sriHashes: unknown,
    allowlist: ReadonlySet<string>,
): ScriptPlan[] => {
    if (!Array.isArray(scriptUrls)) {
        return [];
    }
    const hashes: unknown[] = Array.isArray(sriHashes) ? sriHashes : [];
    const plan: ScriptPlan[] = [];
    scriptUrls.forEach((url, index) => {
        if (!isAllowedEmbedUrl(url, allowlist)) {
            return;
        }
        const integrity = hashes[index];
        const hasIntegrity = typeof integrity === "string" && SRI_PATTERN.test(integrity.trim());
        // SRI is mandatory for external https scripts. The loopback Fake Rails
        // emulator serves a dynamic script that cannot carry a stable hash.
        const loopback = isLoopbackHttpOrigin(parseOrigin(url) ?? "");
        if (!hasIntegrity && !loopback) {
            return;
        }
        plan.push({ url: url as string, integrity: hasIntegrity ? (integrity as string).trim() : "" });
    });
    return plan;
};

/** Fixed safe sandbox flags. `allow-same-origin` and top-navigation flags are never granted. */
export const SAFE_SANDBOX_FLAGS: readonly string[] = ["allow-scripts", "allow-forms", "allow-popups"];
export const DEFAULT_SANDBOX = "allow-scripts allow-forms";

export const sanitizeSandbox = (requested: unknown): string => {
    if (typeof requested !== "string") {
        return DEFAULT_SANDBOX;
    }
    const wanted = new Set(requested.split(/\s+/).filter(Boolean));
    const granted = SAFE_SANDBOX_FLAGS.filter((flag) => wanted.has(flag));
    return granted.length ? granted.join(" ") : DEFAULT_SANDBOX;
};

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;
const DATA_KEY = /^[A-Za-z0-9_]{1,40}$/;
const MAX_DATA_KEYS = 20;
const MAX_STRING = 256;

export type BridgePayload = { event: string; data: Record<string, unknown> };

/** Reduces an untrusted message body to `{ event, data }` with primitive values only. */
export const sanitizeBridgePayload = (raw: unknown): BridgePayload | null => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return null;
    }
    const body = raw as Record<string, unknown>;
    const rawEvent = body.event ?? body.type ?? "callback";
    if (typeof rawEvent !== "string" || !EVENT_NAME.test(rawEvent)) {
        return null;
    }
    const data: Record<string, unknown> = {};
    let count = 0;
    const copy = (source: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(source)) {
            if (key === "event" || key === "type" || !DATA_KEY.test(key)) {
                continue;
            }
            if (count >= MAX_DATA_KEYS) {
                return;
            }
            if (typeof value === "string") {
                data[key] = value.slice(0, MAX_STRING);
            } else if (typeof value === "number" && Number.isFinite(value)) {
                data[key] = value;
            } else if (typeof value === "boolean") {
                data[key] = value;
            } else {
                continue;
            }
            count += 1;
        }
    };
    const nested = body.payload;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        copy(nested as Record<string, unknown>);
    }
    copy(body);
    return { event: rawEvent, data };
};

export type BridgeEvent = { origin?: unknown; source?: unknown; data?: unknown };

/**
 * postMessage handler factory. Fails CLOSED: with no valid allowed origin, or when the
 * message does not come from the embedded iframe's own window, nothing is forwarded.
 */
export const createBridgeHandler = (opts: {
    allowedOrigins: unknown;
    getIframeWindow: () => unknown;
    onCallback: (payload: BridgePayload) => void;
}) => {
    const allowed = new Set([
        ...normalizeOrigins(opts.allowedOrigins),
        ...getEmbedAllowlist(isNonProductionBuild()),
    ]);
    return (event: BridgeEvent): void => {
        const originAllowed = typeof event.origin === "string" && (allowed.has(event.origin) || isLoopbackHttpOrigin(event.origin));
        if (!allowed.size || !originAllowed) {
            return;
        }
        const iframeWindow = opts.getIframeWindow();
        // Script/SDK widgets (no iframe in this component) create their own
        // frame; the origin allow-list is the control there. An iframe we own
        // must also match event.source.
        if (iframeWindow && event.source !== iframeWindow) {
            return;
        }
        const payload = sanitizeBridgePayload(event.data);
        if (payload) {
            opts.onCallback(payload);
        }
    };
};
