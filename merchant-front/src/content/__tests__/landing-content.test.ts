import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appCatalogue } from "../../constants/i18nCatalogue";
import { landingCatalogue } from "../../constants/landingCatalogue";
import {
    LANDING_DEMO_STEPS,
    LANDING_RAIL_MODES,
    LANDING_SNIPPETS,
    LANDING_SNIPPET_REQUEST_FIELDS,
    computeLandingFees,
    journalImbalance,
    landingDemoJournal,
    nextDemoStep,
} from "../landing/landingModel";

const SRC = join(import.meta.dir, "..", "..");
const LANDING_DIR = join(SRC, "pages", "public", "landing");
const landingSources = readdirSync(LANDING_DIR)
    .filter((file) => file.endsWith(".tsx") || file.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(join(LANDING_DIR, file), "utf8") }));
landingSources.push({ file: "landingModel.ts", text: readFileSync(join(SRC, "content", "landing", "landingModel.ts"), "utf8") });

const ARABIC = /[؀-ۿ]/;
const merged: Record<string, [string, string]> = { ...landingCatalogue, ...appCatalogue };

/** Same heuristic the page relies on: t("…") calls, translated data fields and sectionHead() args. */
const extractKeys = (text: string): string[] => {
    const keys = new Set<string>();
    const unescape = (value: string) => value.replace(/\\"/g, '"');
    for (const match of text.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(unescape(match[1]!));
    for (const match of text.matchAll(/\b(?:label|title|text|q|a|caption)\s*:\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(unescape(match[1]!));
    for (const match of text.matchAll(/sectionHead\(\s*"[^"]*",((?:\s*"(?:[^"\\]|\\.)*",?)+)\s*\)/g)) {
        for (const inner of match[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)) keys.add(unescape(inner[1]!));
    }
    for (const match of text.matchAll(/\[\s*("(?:[^"\\]|\\.)*"(?:\s*,\s*"(?:[^"\\]|\\.)*")+)\s*\]\.map/g)) {
        for (const inner of match[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)) keys.add(unescape(inner[1]!));
    }
    return [...keys];
};

/** Literals that are intentionally not translated (code-language names, OTP digits). */
const UNTRANSLATED = new Set(["cURL", "TypeScript", "Python", "0", "1", "3", "4", "7", "9"]);

describe("landing catalogue", () => {
    test("every entry has English equal to its key and real Arabic", () => {
        for (const [key, [en, ar]] of Object.entries(landingCatalogue)) {
            expect(en, key).toBe(key);
            expect(ar.trim().length, key).toBeGreaterThan(0);
            expect(ARABIC.test(ar), `${key} Arabic`).toBe(true);
            // vue-i18n treats @ { } | as message syntax.
            expect(/[@{}|]/.test(en) || /[@{}|]/.test(ar), `${key} syntax chars`).toBe(false);
        }
    });

    test("does not redefine keys owned by the app catalogue", () => {
        const collisions = Object.keys(landingCatalogue).filter((key) => key in appCatalogue);
        expect(collisions).toEqual([]);
    });

    test("every user-facing literal on the landing page is in the EN/AR catalogues", () => {
        const missing: string[] = [];
        for (const { file, text } of landingSources) {
            for (const key of extractKeys(text)) {
                if (UNTRANSLATED.has(key)) continue;
                if (!merged[key]) missing.push(`${file}: ${key}`);
            }
        }
        expect(missing).toEqual([]);
    });
});

describe("landing fee preview", () => {
    test("merchant absorbs: payer pays the amount, wallet gets amount minus commission", () => {
        const r = computeLandingFees({ amount: "250.000", commissionPercent: "2.5", feeBearer: "MERCHANT_ABSORBS" });
        expect(r.customerTotal.toFixed(3)).toBe("250.000");
        expect(r.commission.toFixed(3)).toBe("6.250");
        expect(r.netToWallet.toFixed(3)).toBe("243.750");
    });

    test("payer surcharge: payer pays amount plus commission, wallet gets the full amount", () => {
        const r = computeLandingFees({ amount: "100", commissionPercent: "3", feeBearer: "PAYER_SURCHARGE" });
        expect(r.customerTotal.toFixed(3)).toBe("103.000");
        expect(r.netToWallet.toFixed(3)).toBe("100.000");
    });

    test("split: payer covers half of the commission", () => {
        const r = computeLandingFees({ amount: "100", commissionPercent: "3", feeBearer: "SPLIT", payerSharePercent: "50" });
        expect(r.payerShare.toFixed(3)).toBe("1.500");
        expect(r.customerTotal.toFixed(3)).toBe("101.500");
        expect(r.netToWallet.toFixed(3)).toBe("98.500");
    });

    test("is decimal-exact where floats are not (0.1 + 0.2 style inputs)", () => {
        const r = computeLandingFees({ amount: "0.3", commissionPercent: "10", feeBearer: "PAYER_SURCHARGE" });
        expect(r.customerTotal.toString()).toBe("0.33");
    });

    test("garbage and negative input clamps to zero instead of throwing", () => {
        const r = computeLandingFees({ amount: "-5", commissionPercent: "abc", feeBearer: "SPLIT" });
        expect(r.customerTotal.isZero()).toBe(true);
        expect(r.netToWallet.isZero()).toBe(true);
    });
});

describe("landing hero simulator", () => {
    test("illustrative journal balances (Σ Dr = Σ Cr)", () => {
        expect(journalImbalance(landingDemoJournal()).isZero()).toBe(true);
    });

    test("steps advance and wrap, and statuses are real attempt statuses", () => {
        expect(nextDemoStep(0)).toBe(1);
        expect(nextDemoStep(LANDING_DEMO_STEPS.length - 1)).toBe(0);
        for (const step of LANDING_DEMO_STEPS) {
            expect(["AWAITING_CUSTOMER", "VERIFYING", "SUCCEEDED"]).toContain(step.status);
        }
    });

    test("rail modes map to the five payer experiences (generic ids, no internal action names)", () => {
        expect(LANDING_RAIL_MODES.map((mode) => mode.experience).sort()).toEqual(
            ["app-approval", "bank-redirect", "card-form", "code-entry", "qr-code"].sort(),
        );
    });
});

describe("landing developer snippet", () => {
    // Mirrors core-back/api/internal/merchant.ts `linkCreateSchema` (z.object(...).strict()).
    const ALLOWED = [
        "title",
        "description",
        "amount",
        "currency",
        "feeBearer",
        "applicationId",
        "walletId",
        "expiresAt",
        "maxUses",
        "infiniteUse",
        "activeSlots",
        "allowedRails",
        "metadata",
        "idempotencyKey",
    ];

    test("request fields are accepted by the strict create-link schema and include the required title", () => {
        for (const field of LANDING_SNIPPET_REQUEST_FIELDS) expect(ALLOWED).toContain(field);
        expect(LANDING_SNIPPET_REQUEST_FIELDS).toContain("title");
        const body = LANDING_SNIPPETS.curl.slice(LANDING_SNIPPETS.curl.indexOf("{"), LANDING_SNIPPETS.curl.lastIndexOf("}") + 1);
        const parsed = JSON.parse(body) as Record<string, unknown>;
        expect(Object.keys(parsed).sort()).toEqual([...LANDING_SNIPPET_REQUEST_FIELDS].sort());
        expect(typeof parsed.amount).toBe("string");
    });

    test("every snippet language uses the same fields and a decimal-string amount", () => {
        for (const snippet of Object.values(LANDING_SNIPPETS)) {
            for (const field of LANDING_SNIPPET_REQUEST_FIELDS) expect(snippet).toContain(field);
            expect(snippet).toContain('"250.000"');
            expect(snippet).not.toContain("redirectUrl");
            expect(snippet).not.toContain("useCount");
        }
    });
});

describe("landing routes", () => {
    test("every route name the landing links to exists in the router", () => {
        const router = readFileSync(join(SRC, "router", "index.ts"), "utf8");
        const names = new Set<string>();
        for (const { text } of landingSources) {
            for (const match of text.matchAll(/to=\{\{\s*name:\s*"([A-Za-z]+)"/g)) names.add(match[1]!);
        }
        expect([...names].sort()).toEqual(["Login", "MerchantDeveloperGuide", "MerchantGuide", "Register"]);
        for (const name of names) expect(router).toContain(`name: "${name}"`);
    });
});
