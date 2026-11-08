import { isPlainObject } from "@/components/ui/jsonDiffModel";

/**
 * Dispute evidence <-> form mapping (single place that knows the wire keys).
 *
 * Core (`POST /internal/admin/disputes/:id/evidence`, strict body) accepts
 * `{ evidence: Record<string, unknown> (keys <= 64 chars), notes?: string (<= 2000),
 *   checklist?: enum[] }` and merges `evidence` + `notes` + `submittedAt` into
 * `Dispute.evidenceJson`. The portal therefore writes these keys inside `evidence`:
 * `receiptRef`, `customerProofSummary`, `merchantResponse`, `documentUrls`; the free text
 * `notes` travels in the top-level `notes` field.
 */
export const EVIDENCE_FIELD_LIMIT = 2000;
export const EVIDENCE_REF_LIMIT = 200;
export const MAX_DOCUMENT_URLS = 10;

export interface EvidenceForm {
    receiptRef: string;
    customerProofSummary: string;
    merchantResponse: string;
    /** One URL per line. */
    documentUrls: string;
    notes: string;
}

export const emptyEvidenceForm = (): EvidenceForm => ({
    receiptRef: "",
    customerProofSummary: "",
    merchantResponse: "",
    documentUrls: "",
    notes: "",
});

export type EvidenceErrorCode = "EMPTY" | "TOO_LONG" | "TOO_MANY_URLS" | "INVALID_URL";
export interface EvidenceError {
    field: keyof EvidenceForm | "form";
    code: EvidenceErrorCode;
    /** Offending URL for INVALID_URL. */
    value?: string;
}

export const parseDocumentUrls = (text: string): string[] =>
    Array.from(new Set(text.split(/[\r\n,]+/).map((line) => line.trim()).filter(Boolean)));

export const isHttpUrl = (value: string): boolean => {
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
    } catch {
        return false;
    }
};

export const validateEvidenceForm = (form: EvidenceForm): EvidenceError[] => {
    const errors: EvidenceError[] = [];
    const urls = parseDocumentUrls(form.documentUrls);
    const filled = [form.receiptRef, form.customerProofSummary, form.merchantResponse, form.notes].some((value) => value.trim() !== "") || urls.length > 0;
    if (!filled) errors.push({ field: "form", code: "EMPTY" });
    if (form.receiptRef.trim().length > EVIDENCE_REF_LIMIT) errors.push({ field: "receiptRef", code: "TOO_LONG" });
    for (const field of ["customerProofSummary", "merchantResponse", "notes"] as const) {
        if (form[field].trim().length > EVIDENCE_FIELD_LIMIT) errors.push({ field, code: "TOO_LONG" });
    }
    if (urls.length > MAX_DOCUMENT_URLS) errors.push({ field: "documentUrls", code: "TOO_MANY_URLS" });
    for (const url of urls) {
        if (!isHttpUrl(url)) errors.push({ field: "documentUrls", code: "INVALID_URL", value: url });
    }
    return errors;
};

/** Request body for the core evidence endpoint (checklist is added by the caller). */
export const buildEvidenceSubmission = (form: EvidenceForm): { evidence: Record<string, unknown>; notes?: string } => {
    const evidence: Record<string, unknown> = {};
    const receiptRef = form.receiptRef.trim();
    const customerProofSummary = form.customerProofSummary.trim();
    const merchantResponse = form.merchantResponse.trim();
    const urls = parseDocumentUrls(form.documentUrls);
    if (receiptRef) evidence.receiptRef = receiptRef;
    if (customerProofSummary) evidence.customerProofSummary = customerProofSummary;
    if (merchantResponse) evidence.merchantResponse = merchantResponse;
    if (urls.length > 0) evidence.documentUrls = urls;
    const notes = form.notes.trim();
    return notes ? { evidence, notes } : { evidence };
};

/** English labels (translated by the view) for the keys written by this form and by older submissions. */
export const EVIDENCE_LABELS: Record<string, string> = {
    receiptRef: "Receipt / RRN reference",
    customerProofSummary: "Customer proof summary",
    merchantResponse: "Merchant explanation",
    documentUrls: "Supporting documents",
    documentUrl: "Supporting documents",
    notes: "Notes",
    reference: "Evidence reference",
    summary: "Summary",
    submittedAt: "Submitted at",
};

export const EVIDENCE_ORDER = ["receiptRef", "reference", "customerProofSummary", "merchantResponse", "summary", "notes", "submittedAt"];

/** Keys rendered as links instead of rows (and the legacy `summary` that duplicated `notes`). */
export const evidenceHiddenKeys = (evidenceJson: unknown): string[] => {
    const hidden = ["documentUrls", "documentUrl"];
    if (isPlainObject(evidenceJson) && evidenceJson.summary !== undefined && evidenceJson.summary === evidenceJson.notes) hidden.push("summary");
    return hidden;
};

/** http(s) links stored in the evidence (`documentUrls[]` and the legacy single `documentUrl`). */
export const evidenceDocumentLinks = (evidenceJson: unknown): string[] => {
    if (!isPlainObject(evidenceJson)) return [];
    const raw: unknown[] = [
        ...(Array.isArray(evidenceJson.documentUrls) ? evidenceJson.documentUrls : []),
        evidenceJson.documentUrl,
    ];
    return Array.from(new Set(raw.filter((item): item is string => typeof item === "string" && isHttpUrl(item))));
};
