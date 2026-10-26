import { ApiError } from "../../lib/error";
import type { NotificationTemplateRow } from "../db/ports";

const AML_VARIABLE_PATTERN =
  /(aml[_.-]?(case|screen|rule|report|match)|sanction|pep[_.-]?flag|str[_.-]?draft|watch[_.-]?list|structuring|screening[_.-]?result|confirmed[_.-]?match|potential[_.-]?match)/i;

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export const extractTemplateVariables = (template: string): string[] => {
  const variables: string[] = [];
  VARIABLE_PATTERN.lastIndex = 0;
  let match = VARIABLE_PATTERN.exec(template);
  while (match) {
    const name = match[1];
    if (name) variables.push(name);
    match = VARIABLE_PATTERN.exec(template);
  }
  VARIABLE_PATTERN.lastIndex = 0;
  return variables;
};

export const containsAmlVariable = (template: string): boolean => {
  const variables = extractTemplateVariables(template);
  if (variables.length > 0) {
    return variables.some((variable) => AML_VARIABLE_PATTERN.test(variable));
  }
  return AML_VARIABLE_PATTERN.test(template);
};

export const isConfidentialTemplateClass = (confidentialityClass: string): boolean =>
  confidentialityClass === "INTERNAL";

export const assertNoTippingOff = (template: {
  code?: string;
  subjectTemplate?: string | null;
  bodyTemplate: string;
  confidentialityClass: string;
}): void => {
  if (isConfidentialTemplateClass(template.confidentialityClass)) {
    return;
  }
  const subject = template.subjectTemplate ?? "";
  if (containsAmlVariable(subject) || containsAmlVariable(template.bodyTemplate)) {
    throw new ApiError(
      400,
      "TIPPING_OFF_TEMPLATE_REJECTED",
      `Template ${template.code ?? "unknown"} of class ${template.confidentialityClass} may not reference AML variables`,
      { code: template.code, confidentialityClass: template.confidentialityClass },
    );
  }
};

export const assertTemplateAllowedForChannel = (
  template: NotificationTemplateRow,
  channel: string,
  lang: string,
): void => {
  if (template.channel !== channel) {
    throw new ApiError(400, "TEMPLATE_CHANNEL_MISMATCH", "Template channel does not match the notification channel");
  }
  if (template.lang !== lang) {
    throw new ApiError(400, "TEMPLATE_LANGUAGE_MISMATCH", "Template language does not match the notification language");
  }
};

export const renderTemplate = (template: string, payload: Record<string, unknown>): string =>
  template.replace(VARIABLE_PATTERN, (_match, name: string) => {
    const value = payload[name];
    if (value === null || value === undefined) return "";
    return String(value);
  });

const SENSITIVE_KEY_PATTERN =
  /(aml|sanction|pep|screening|watchlist|watch_list|case_reason|risk_score|internal_note|investigation)/i;

export const redactAmlPayload = (
  payload: Record<string, unknown>,
  confidentialityClass: string,
): Record<string, unknown> => {
  if (isConfidentialTemplateClass(confidentialityClass)) {
    return payload;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      continue;
    }
    redacted[key] = value;
  }
  return redacted;
};
