import type { StatusTone } from "@/components/StatusChip";

export const COLUMN_HELP = {
    merchant: "The merchant that uploaded or owns this document.",
    subject: "Whether the document belongs to the merchant or to a beneficial owner.",
    documentType: "The controlled KYB document type. Required types depend on the merchant business category.",
    file: "Original file name, MIME type and size. The document bytes are encrypted at rest and never shown in the queue.",
    status: "Per-document state. Only UPLOADED documents can be reviewed; accepted, rejected and expired documents are final evidence rows.",
    avStatus: "Antivirus result. A file must be CLEAN before any reviewer can preview or accept it.",
    expiry: "The document expiry date. Expired documents cannot be accepted; request a replacement or re-verification.",
    duplicate: "The same SHA-256 file hash appears under another merchant. Reuse raises a duplicate flag and requires written justification when accepted.",
    request: "The related join request and its SLA. Draft-request documents are excluded from this queue.",
    uploaded: "Who uploaded the document and when.",
    reviewed: "Who made the latest document decision and when.",
    actions: "Review, preview, request a replacement, or open the linked join request.",
};

export const DOCUMENT_TYPE_HELP: Record<string, { label: string; meaning: string }> = {
    COMMERCIAL_REGISTRY: { label: "Commercial registry", meaning: "Official commercial registration certificate." },
    TAX_CERTIFICATE: { label: "Tax certificate", meaning: "Tax registration or tax payment certificate." },
    ARTICLES_OF_ASSOCIATION: { label: "Articles of association", meaning: "Company constitutional documents." },
    OWNER_ID: { label: "Owner ID", meaning: "Identity document of a beneficial owner." },
    SIGNATORY_ID: { label: "Signatory ID", meaning: "Identity document of an authorised signatory." },
    PROOF_OF_ADDRESS: { label: "Proof of address", meaning: "Evidence of the registered business address." },
    BANK_LETTER: { label: "Bank letter", meaning: "Bank confirmation of the payout account and account holder." },
    SECTOR_LICENSE: { label: "Sector licence", meaning: "Licence required for a regulated business category." },
    OTHER: { label: "Other", meaning: "Supporting document that does not fit another category." },
};

export const DOCUMENT_STATUS_HELP: Record<string, { label: string; meaning: string; tone: StatusTone }> = {
    UPLOADED: { label: "Uploaded", meaning: "Waiting for a reviewer decision.", tone: "info" },
    ACCEPTED: { label: "Accepted", meaning: "Evidence accepted by a reviewer.", tone: "success" },
    REJECTED: { label: "Rejected", meaning: "Evidence rejected; a replacement may be required.", tone: "error" },
    EXPIRED: { label: "Expired", meaning: "The document expiry date passed; it cannot support an active KYB file.", tone: "warning" },
};

export const AV_STATUS_HELP: Record<string, { label: string; meaning: string; tone: StatusTone }> = {
    PENDING: { label: "Scan pending", meaning: "The scanner has not cleared the file; preview and review are blocked.", tone: "warning" },
    CLEAN: { label: "Clean", meaning: "The scanner found no malware; the file can be previewed.", tone: "success" },
    INFECTED: { label: "Infected", meaning: "The scanner rejected the file; it must never be opened and a replacement is required.", tone: "error" },
};

export const EXPIRY_HELP: Record<string, { label: string; meaning: string; tone: StatusTone }> = {
    EXPIRED: { label: "Expired", meaning: "The expiry date is in the past.", tone: "error" },
    DUE_SOON: { label: "Due soon", meaning: "The expiry date is within 30 days.", tone: "warning" },
    VALID: { label: "Valid", meaning: "The expiry date is more than 30 days away.", tone: "success" },
    NONE: { label: "No expiry", meaning: "The document type does not carry an expiry date.", tone: "neutral" },
};

export const REVIEW_REASON_CODES = [
    { title: "Blurry or unreadable", value: "BLURRY_OR_UNREADABLE" },
    { title: "Expired document", value: "EXPIRED_DOCUMENT" },
    { title: "Wrong document type", value: "WRONG_DOCUMENT_TYPE" },
    { title: "Name mismatch", value: "NAME_MISMATCH" },
    { title: "Incomplete document", value: "INCOMPLETE_DOCUMENT" },
    { title: "Duplicate reuse", value: "DUPLICATE_REUSE" },
    { title: "Replacement requested", value: "REPLACEMENT_REQUESTED" },
    { title: "Other", value: "OTHER" },
];

export const documentTypeHelp = (docType: string) =>
    DOCUMENT_TYPE_HELP[docType] ?? { label: docType.replaceAll("_", " "), meaning: "No help is registered for this document type." };

export const documentStatusHelp = (status: string) =>
    DOCUMENT_STATUS_HELP[status] ?? { label: status, meaning: "Unknown document status.", tone: "neutral" as StatusTone };

export const avStatusHelp = (status: string) =>
    AV_STATUS_HELP[status] ?? { label: status, meaning: "Unknown antivirus status.", tone: "neutral" as StatusTone };

export const expiryHelp = (state: string) =>
    EXPIRY_HELP[state] ?? { label: state, meaning: "Unknown expiry state.", tone: "neutral" as StatusTone };

export const blockerLabel = (blocker: string): string =>
    blocker.replaceAll("_", " ").toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase());

export const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
};

export const formatBytes = (value: number): string => {
    if (!Number.isFinite(value) || value <= 0) return "0 B";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
};

export const KYB_HELP_SECTIONS = [
    {
        title: "What this queue contains",
        body: "This queue lists KYB document evidence for submitted join requests and active merchants. Documents that belong only to a DRAFT join request are deliberately excluded from reviewer queues. The related join request and SLA are shown so a document is never reviewed without its onboarding context.",
    },
    {
        title: "How to review a document",
        body: "1. Confirm the antivirus status is CLEAN. 2. Open the secure preview and confirm the file is genuine and legible. 3. Check the document type against the business and the required-document list. 4. Cross-check the legal name, registration number, tax certificate and expiry date. 5. For a bank letter, confirm the account belongs to the merchant legal entity. 6. Record the decision and any note. Checklist and final join-request approval stay on the Join Request page.",
    },
    {
        title: "Duplicate documents",
        body: "A duplicate is the same SHA-256 file hash uploaded under another merchant. A duplicate is a warning, not an automatic rejection. Investigate the related merchant and join request. Accepting a reused document requires a written justification; repeated reuse can open an AML case.",
    },
    {
        title: "Expiry and replacements",
        body: "A document due within 30 days is marked DUE_SOON. Once the expiry date passes it becomes EXPIRED and cannot be accepted as current evidence. Request a replacement or an active-merchant re-verification so the merchant uploads a new, never-overwritten document row.",
    },
    {
        title: "Access, privacy and audit",
        body: "Only clean files can be previewed. Every preview, review and replacement request is audit-logged. Document bytes are encrypted at rest and list responses never expose ciphertext. Merchant messages use neutral KYB language and never expose AML or screening details.",
    },
];
