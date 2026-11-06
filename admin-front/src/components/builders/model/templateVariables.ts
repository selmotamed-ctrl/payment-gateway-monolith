/**
 * Notification-template placeholders (core `engine/compliance/tippingOff.ts`):
 * `{{ name }}` where name is `[a-zA-Z0-9_.]+`. Mirrors the server so the UI can warn before the 422.
 */
const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export const extractTemplateVariables = (template: string): string[] => {
    const found: string[] = [];
    for (const match of template.matchAll(VARIABLE_PATTERN)) if (match[1]) found.push(match[1]);
    return found;
};

export const uniqueTemplateVariables = (...templates: (string | null | undefined)[]): string[] => [
    ...new Set(templates.flatMap((template) => extractTemplateVariables(template ?? ""))),
];

/** Placeholders used by the draft that are not in the allowed set (sorted like the server). */
export const unknownTemplateVariables = (draft: readonly (string | null | undefined)[], allowed: Iterable<string>): string[] => {
    const allow = new Set(allowed);
    return uniqueTemplateVariables(...draft).filter((name) => !allow.has(name)).sort();
};

/** The `{{ name }}` text a chip inserts. */
export const placeholderText = (name: string): string => `{{${name}}}`;

/** Inserts a placeholder at the selection of `value`; returns the new text and caret position. */
export const insertPlaceholder = (value: string, name: string, selectionStart: number | null, selectionEnd: number | null): { value: string; caret: number } => {
    const start = selectionStart ?? value.length;
    const end = selectionEnd ?? start;
    const token = placeholderText(name);
    return { value: value.slice(0, start) + token + value.slice(end), caret: start + token.length };
};

/** Renders a template with sample values (unknown variables stay as `{{name}}` so they are visible). */
export const previewTemplate = (template: string, samples: Record<string, string>): string =>
    template.replace(VARIABLE_PATTERN, (match, name: string) => (name in samples ? samples[name]! : match));

export type TemplateRowLike = { code: string; channel: string; lang: string; version?: number };

/** Groups the latest versions by code so one card shows every channel/language of a template. */
export const groupTemplatesByCode = <T extends TemplateRowLike>(rows: readonly T[]): { code: string; rows: T[] }[] => {
    const map = new Map<string, T[]>();
    for (const row of rows) map.set(row.code, [...(map.get(row.code) ?? []), row]);
    return [...map.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([code, list]) => ({ code, rows: [...list].sort((a, b) => `${a.channel}:${a.lang}`.localeCompare(`${b.channel}:${b.lang}`)) }));
};
