export type RuleFn = (value: any) => true | string | false | void;

/** Required-ness: `0` and `false` are valid values, never "empty". */
export const isEmpty = (value: any): boolean => {
    if (value === null || value === undefined) return true;
    if (typeof value === "string") return value.trim().length === 0;
    if (Array.isArray(value)) return value.length === 0;
    if (value instanceof FileList) return value.length === 0;
    if (value instanceof Map || value instanceof Set) return value.size === 0;
    return false;
};

const runRuleList = (value: any, rules: RuleFn[]): string => {
    for (const rule of rules) {
        if (typeof rule !== "function") continue;
        try {
            const result = rule(value);
            if (typeof result === "string" && result.length > 0) return result;
            if (result === false) return "Invalid value";
        } catch {
            /* a throwing rule must not break the field */
        }
    }
    return "";
};

/**
 * Runs the Vuetify-style `rules` prop and returns the first message.
 *
 * Both call styles are supported:
 *   runRules({ rules, errorMessages }, value)   // component internals
 *   runRules(value, [v => !!v || 'Required'])   // blueprint contract
 */
export const runRules = (input: any, valueOrRules?: any): string => {
    if (Array.isArray(valueOrRules)) return runRuleList(input, valueOrRules);
    const attrs = input && typeof input === "object" ? input : {};
    const value = valueOrRules;
    const rules = Array.isArray(attrs.rules) ? attrs.rules : attrs.rules ? [attrs.rules] : [];
    const ruleError = runRuleList(value, rules);
    if (ruleError) return ruleError;
    const messages = attrs.errorMessages;
    if (Array.isArray(messages)) {
        const first = messages.find((message: any) => typeof message === "string" && message.trim().length > 0);
        if (first) return String(first);
    }
    if (typeof attrs.error === "string" && attrs.error) return attrs.error;
    return "";
};

/**
 * Chooses the single visible error string.
 *
 * Legacy signature: `visibleError(attrs, localRuleError)`.
 * Blueprint signature: `visibleError(explicitError, ruleError, touched, forceShow)`.
 */
export const visibleError = (
    explicitOrAttrs: any,
    ruleOrLocal?: any,
    touched = true,
    forceShow = false,
): string => {
    if (explicitOrAttrs && typeof explicitOrAttrs === "object" && !Array.isArray(explicitOrAttrs)) {
        const attrs = explicitOrAttrs;
        const local = typeof ruleOrLocal === "string" ? ruleOrLocal : "";
        const explicit =
            typeof attrs.error === "string"
                ? attrs.error
                : Array.isArray(attrs.errorMessages)
                  ? (attrs.errorMessages.find((message: any) => typeof message === "string" && message) ?? "")
                  : "";
        if (attrs.hideDetails) return "";
        return String(explicit || local || "");
    }
    const explicit = typeof explicitOrAttrs === "string" ? explicitOrAttrs : "";
    const ruleError = typeof ruleOrLocal === "string" ? ruleOrLocal : "";
    if (explicit) return explicit;
    if (!touched && !forceShow) return "";
    return ruleError;
};
