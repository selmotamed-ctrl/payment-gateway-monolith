/** KYB revalidation request helpers (`POST /merchants/:id/revalidations`). */

export const KYB_DOC_TYPES = [
    "COMMERCIAL_REGISTRY",
    "TAX_CERTIFICATE",
    "ARTICLES_OF_ASSOCIATION",
    "OWNER_ID",
    "SIGNATORY_ID",
    "PROOF_OF_ADDRESS",
    "BANK_LETTER",
    "SECTOR_LICENSE",
    "OTHER",
] as const;

export type KybDocType = (typeof KYB_DOC_TYPES)[number];

/** English label keys (catalogued) for the document types. */
export const KYB_DOC_TYPE_LABELS: Record<KybDocType, string> = {
    COMMERCIAL_REGISTRY: "Commercial registry",
    TAX_CERTIFICATE: "Tax certificate",
    ARTICLES_OF_ASSOCIATION: "Articles of association",
    OWNER_ID: "Owner identification",
    SIGNATORY_ID: "Signatory identification",
    PROOF_OF_ADDRESS: "Proof of address",
    BANK_LETTER: "Bank letter",
    SECTOR_LICENSE: "Sector license",
    OTHER: "Other document",
};

export interface RevalidationForm {
    docType: KybDocType | "";
    dueAt: string;
    message: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

export const DEFAULT_REVALIDATION_DAYS = 14;

export const emptyRevalidationForm = (now: Date = new Date()): RevalidationForm => ({
    docType: "",
    dueAt: isoDate(new Date(now.getTime() + DEFAULT_REVALIDATION_DAYS * DAY_MS)),
    message: "",
});

export type RevalidationErrors = Partial<Record<keyof RevalidationForm, string>>;

/** Error values are English message keys; an empty object means valid. */
export const validateRevalidation = (form: RevalidationForm, now: Date = new Date()): RevalidationErrors => {
    const errors: RevalidationErrors = {};
    if (!form.docType) errors.docType = "Choose the document type to revalidate";
    const due = form.dueAt.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due))) errors.dueAt = "Use the format YYYY-MM-DD";
    else if (Date.parse(due) <= now.getTime()) errors.dueAt = "The due date must be in the future.";
    const message = form.message.trim();
    if (message.length < 3) errors.message = "Explain what the merchant must provide (at least 3 characters)";
    else if (message.length > 1000) errors.message = "The message is limited to 1000 characters";
    return errors;
};

export const buildRevalidationBody = (form: RevalidationForm): { docType: string; dueAt: string; message: string } => ({
    docType: String(form.docType),
    dueAt: form.dueAt.trim(),
    message: form.message.trim(),
});
