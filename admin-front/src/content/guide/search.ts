import {
    ATTEMPT_STATUS_DEFINITIONS,
    COLLECTION_MODE_DEFINITIONS,
    CONFIRMATION_CHANNEL_DEFINITIONS,
    EDGE_CASE_DEFINITIONS,
    ERROR_CODE_GLOSSARY,
    GL_ACCOUNT_DEFINITIONS,
    GLOSSARY_TERMS,
    GUIDE_BOOKS,
    RUNBOOK_DEFINITIONS,
} from "./index";
import type { GuideSearchEntry } from "./types";

const asTags = (...values: string[]): string[] => {
    const set = new Set<string>();
    for (const value of values) {
        for (const token of value.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, " ").split(/\s+/)) {
            if (token.length >= 2) {
                set.add(token);
            }
        }
    }
    return [...set].slice(0, 24);
};

export const buildGuideSearchIndex = (): GuideSearchEntry[] => {
    const entries: GuideSearchEntry[] = [];

    for (const book of GUIDE_BOOKS) {
        entries.push({
            id: book.id,
            kind: "book",
            titleEn: `Book ${book.number}: ${book.titleEn}`,
            titleAr: `الكتاب ${book.number}: ${book.titleAr}`,
            bodyEn: `${book.summaryEn}\n\n${book.humanErrorWarning}\n\n${book.sopChecklist.join("\n")}`,
            bodyAr: book.summaryAr,
            bookNumber: book.number,
            tags: asTags(book.titleEn, book.titleAr, book.tags.join(" ")),
        });
        for (const chapter of book.chapters) {
            entries.push({
                id: chapter.id,
                kind: "chapter",
                titleEn: `Book ${book.number} · Chapter ${chapter.number}: ${chapter.titleEn}`,
                titleAr: `الكتاب ${book.number} · الفصل ${chapter.number}: ${chapter.titleAr ?? chapter.titleEn}`,
                bodyEn: chapter.bodyEn,
                bodyAr: chapter.bodyAr,
                bookNumber: book.number,
                chapterId: chapter.id,
                tags: asTags(chapter.titleEn, chapter.tags.join(" ")),
            });
        }
    }

    for (const term of GLOSSARY_TERMS) {
        entries.push({
            id: `glossary-${term.term}`,
            kind: "glossary",
            titleEn: term.term,
            titleAr: term.term,
            bodyEn: `${term.category}\n\n${term.definitionEn}\n\nAnalogy: ${term.analogyEn}\n\nFatal error: ${term.fatalErrorEn}`,
            bodyAr: `${term.definitionAr ?? ""}\n\n${term.analogyAr ?? ""}\n\n${term.fatalErrorAr ?? ""}`,
            tags: asTags(term.term, term.category, term.tags.join(" ")),
        });
    }

    for (const entry of ERROR_CODE_GLOSSARY) {
        entries.push({
            id: `error-${entry.code}`,
            kind: "error",
            titleEn: entry.code,
            titleAr: entry.code,
            bodyEn: entry.meaningEn,
            bodyAr: entry.meaningAr,
            tags: asTags(entry.code, entry.meaningEn),
        });
    }

    for (const entry of GL_ACCOUNT_DEFINITIONS) {
        entries.push({
            id: `gl-${entry.code}`,
            kind: "gl",
            titleEn: entry.code,
            titleAr: entry.code,
            bodyEn: `${entry.normalBalance}\n\n${entry.meaningEn}`,
            bodyAr: entry.meaningAr,
            tags: asTags(entry.code, entry.normalBalance, entry.meaningEn),
        });
    }

    for (const entry of ATTEMPT_STATUS_DEFINITIONS) {
        entries.push({
            id: `status-${entry.code}`,
            kind: "status",
            titleEn: entry.code,
            titleAr: entry.code,
            bodyEn: `${entry.category}\n\n${entry.meaningEn}\n\nSlot: ${entry.slotLocked}\n\nAction: ${entry.operatorAction}`,
            bodyAr: entry.meaningAr,
            tags: asTags(entry.code, entry.category, entry.meaningEn),
        });
    }

    for (const entry of COLLECTION_MODE_DEFINITIONS) {
        entries.push({
            id: `collection-${entry.code}`,
            kind: "collection",
            titleEn: `${entry.code} — ${entry.titleEn}`,
            titleAr: `${entry.code} — ${entry.titleAr}`,
            bodyEn: entry.meaningEn,
            bodyAr: entry.meaningAr,
            tags: asTags(entry.code, entry.titleEn, entry.meaningEn),
        });
    }

    for (const entry of CONFIRMATION_CHANNEL_DEFINITIONS) {
        entries.push({
            id: `channel-${entry.code}`,
            kind: "channel",
            titleEn: `${entry.code} — ${entry.titleEn}`,
            titleAr: `${entry.code} — ${entry.titleAr}`,
            bodyEn: `${entry.trustLevel}\n\n${entry.meaningEn}`,
            bodyAr: entry.meaningAr,
            tags: asTags(entry.code, entry.titleEn, entry.trustLevel, entry.meaningEn),
        });
    }

    for (const entry of RUNBOOK_DEFINITIONS) {
        entries.push({
            id: entry.id,
            kind: "runbook",
            titleEn: `${entry.id}: ${entry.titleEn}`,
            titleAr: `${entry.id}: ${entry.titleAr}`,
            bodyEn: `${entry.triggerEn}\n\n${entry.stepsEn.join("\n")}`,
            bodyAr: `${entry.triggerAr}\n\n${entry.stepsAr.join("\n")}`,
            tags: asTags(entry.id, entry.titleEn, entry.triggerEn),
        });
    }

    for (const entry of EDGE_CASE_DEFINITIONS) {
        entries.push({
            id: entry.id,
            kind: "edge-case",
            titleEn: `${entry.id}: ${entry.titleEn}`,
            titleAr: `${entry.id}: ${entry.titleAr}`,
            bodyEn: entry.descriptionEn,
            bodyAr: entry.descriptionAr,
            tags: asTags(entry.id, entry.titleEn, entry.descriptionEn),
        });
    }

    entries.push(
        {
            id: "simulator-transform",
            kind: "simulator",
            titleEn: "Transform Playground",
            titleAr: "مختبر التحويلات",
            bodyEn: "Test scale, round, to_int, to_string, arabic_digits_to_ascii, phone_normalize and the rest of the closed TransformPipe library without eval.",
            bodyAr: "اختبر scale وround وto_int وto_string وتحويل الأرقام العربية وتطبيع الهاتف وبقية مكتبة TransformPipe المغلقة دون eval.",
            tags: asTags("transform", "TransformPipe", "scale", "round", "phone", "arabic digits"),
        },
        {
            id: "simulator-crypto",
            kind: "simulator",
            titleEn: "Crypto Signature Lab",
            titleAr: "مختبر التوقيع التشفيري",
            bodyEn: "Compare SORTED_KEY_VALUE_AMP, TIMESTAMP_DOT_RAW_BODY, SORTED_VALUES_HASH, RAW_BODY, TEMPLATE_STRING and JSON_CANONICAL canonicalization modes.",
            bodyAr: "قارن أنماط التوحيد القياسي SORTED_KEY_VALUE_AMP وTIMESTAMP_DOT_RAW_BODY وSORTED_VALUES_HASH وRAW_BODY وTEMPLATE_STRING وJSON_CANONICAL.",
            tags: asTags("crypto", "hmac", "signature", "canonical", "moamalat", "dpay", "plutu"),
        },
        {
            id: "simulator-ledger",
            kind: "simulator",
            titleEn: "Ledger T-Account Visualizer",
            titleAr: "مصور حسابات الدفتر",
            bodyEn: "Build balanced debit and credit lines for confirmations, T+1 sweeps, refunds, chargebacks and MERCHANT_DIRECT commission.",
            bodyAr: "ابنِ سطور مدين ودائن متوازنة للتأكيدات ومسح T+1 والاستردادات والاسترداد العكسي وعمولة MERCHANT_DIRECT.",
            tags: asTags("ledger", "debit", "credit", "journal", "t-account", "clearing"),
        },
    );

    return entries;
};

type LoweredEntry = {
    title: string;
    tags: string;
    body: string;
};

let cachedIndex: GuideSearchEntry[] | null = null;
const loweredById = new Map<string, LoweredEntry>();

const getIndex = (): GuideSearchEntry[] => {
    if (cachedIndex) {
        return cachedIndex;
    }
    cachedIndex = buildGuideSearchIndex();
    for (const entry of cachedIndex) {
        loweredById.set(entry.id, {
            title: `${entry.titleEn} ${entry.titleAr}`.toLowerCase(),
            tags: entry.tags.join(" ").toLowerCase(),
            body: `${entry.bodyEn} ${entry.bodyAr ?? ""}`.toLowerCase(),
        });
    }
    return cachedIndex;
};

const scoreEntry = (entry: GuideSearchEntry, terms: string[]): number => {
    const lowered = loweredById.get(entry.id);
    if (!lowered) {
        return 0;
    }
    let score = 0;
    for (const term of terms) {
        const inTitle = lowered.title.includes(term);
        const inTags = lowered.tags.includes(term);
        const inBody = lowered.body.includes(term);
        if (!inTitle && !inTags && !inBody) {
            return 0;
        }
        if (inTitle) score += 120;
        if (inTags) score += 45;
        if (inBody) score += 10;
    }
    return score;
};

export const searchGuide = (query: string, limit = 40): GuideSearchEntry[] => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const index = getIndex();
    if (terms.length === 0) {
        return index.slice(0, limit);
    }
    return index
        .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
        .filter((row) => row.score > 0)
        .sort((left, right) => right.score - left.score || left.entry.titleEn.localeCompare(right.entry.titleEn))
        .slice(0, limit)
        .map((row) => row.entry);
};
