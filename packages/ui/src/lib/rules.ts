export const isEmpty = (value: any): boolean => value === "" || value === null || value === undefined;

/**
 * Runs the Vuetify-style `rules` prop the pages already use and returns the
 * first message. `errorMessages` and `error` still win only when no rule
 * fails, matching the previous shim's behaviour.
 */
export const runRules = (attrs: Record<string, any>, value: any): string => {
    const rules = Array.isArray(attrs.rules) ? attrs.rules : attrs.rules ? [attrs.rules] : [];
    for (const rule of rules) {
        if (typeof rule !== "function") continue;
        try {
            const result = rule(value);
            if (typeof result === "string" && result.length > 0) return result;
        } catch {
            /* a throwing rule must not break the field */
        }
    }
    const messages = attrs.errorMessages;
    if (Array.isArray(messages) && messages.length > 0) return String(messages[0]);
    if (typeof attrs.error === "string" && attrs.error) return attrs.error;
    return "";
};

export const visibleError = (attrs: Record<string, any>, local: string): string =>
    attrs.hideDetails ? "" : local || (typeof attrs.error === "string" ? attrs.error : "");
