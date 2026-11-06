import { humanizeKey, isPlainObject } from "@/components/ui/jsonDiffModel";

export interface SeverityStep {
    source: string;
    /** Humanised `source`, e.g. `MERCHANT_RISK_TIER_HIGH` -> `Merchant Risk Tier High`. */
    label: string;
    effect: string;
    from: string | null;
    to: string | null;
}

export type SeverityInputsView =
    | { kind: "empty" }
    | { kind: "steps"; steps: SeverityStep[] }
    | { kind: "generic"; value: unknown };

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

const isStep = (value: unknown): boolean =>
    isPlainObject(value) && typeof value.source === "string" && (typeof value.to === "string" || typeof value.effect === "string");

/**
 * `AmlCase.severityInputsJson` is either the rule engine's escalation trail
 * (`[{ source, effect, from, to }]`) or a free-form object written by the
 * screening flow (`screening_id`, `highest_score`, `matches`...). The first is
 * rendered as ordered steps, the second as humanised key/value rows.
 */
export const describeSeverityInputs = (value: unknown): SeverityInputsView => {
    if (value === null || value === undefined) return { kind: "empty" };
    if (Array.isArray(value)) {
        if (value.length === 0) return { kind: "empty" };
        if (value.every(isStep)) {
            return {
                kind: "steps",
                steps: (value as Array<Record<string, unknown>>).map((step) => ({
                    source: String(step.source),
                    label: humanizeKey(String(step.source)),
                    effect: text(step.effect) ?? "",
                    from: text(step.from),
                    to: text(step.to),
                })),
            };
        }
        return { kind: "generic", value };
    }
    if (isPlainObject(value)) return Object.keys(value).length === 0 ? { kind: "empty" } : { kind: "generic", value };
    return { kind: "generic", value };
};
