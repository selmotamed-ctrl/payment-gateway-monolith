import { BOOKS_PART_1 } from "./booksPart1";
import { BOOKS_PART_2 } from "./booksPart2";
import {
    ATTEMPT_STATUS_DEFINITIONS,
    COLLECTION_MODE_DEFINITIONS,
    CONFIRMATION_CHANNEL_DEFINITIONS,
    EDGE_CASE_DEFINITIONS,
    ERROR_CODE_GLOSSARY,
    GL_ACCOUNT_DEFINITIONS,
    GLOSSARY_TERMS,
    RUNBOOK_DEFINITIONS,
} from "./glossaryData";
import type { GuideBook, GuideChapter } from "./types";

export * from "./types";
export {
    ATTEMPT_STATUS_DEFINITIONS,
    COLLECTION_MODE_DEFINITIONS,
    CONFIRMATION_CHANNEL_DEFINITIONS,
    EDGE_CASE_DEFINITIONS,
    ERROR_CODE_GLOSSARY,
    GL_ACCOUNT_DEFINITIONS,
    GLOSSARY_TERMS,
    RUNBOOK_DEFINITIONS,
};

export const GUIDE_BOOKS: GuideBook[] = [...BOOKS_PART_1, ...BOOKS_PART_2];

export const GUIDE_CHAPTERS: GuideChapter[] = GUIDE_BOOKS.flatMap((book) => book.chapters);

export const findBookByNumber = (number: number): GuideBook | undefined =>
    GUIDE_BOOKS.find((book) => book.number === number);

export const findChapter = (bookNumber: number, chapterNumber: string): GuideChapter | undefined =>
    findBookByNumber(bookNumber)?.chapters.find((chapter) => chapter.number === chapterNumber);

export const SIMULATOR_IDS = ["transform", "crypto", "ledger"] as const;
export type SimulatorId = (typeof SIMULATOR_IDS)[number];

export const GUIDE_ROUTE_HELP: Record<string, { bookNumber: number; chapterNumber?: string; titleEn: string }> = {
    Dashboard: { bookNumber: 1, chapterNumber: "1.1", titleEn: "What the platform does" },
    Approvals: { bookNumber: 2, chapterNumber: "2.4", titleEn: "Approvals queue SOP" },
    JoinRequests: { bookNumber: 9, chapterNumber: "9.1", titleEn: "Join request lifecycle" },
    KybReview: { bookNumber: 9, chapterNumber: "9.2", titleEn: "7-point KYB reviewer checklist" },
    AmlCases: { bookNumber: 10, chapterNumber: "10.1", titleEn: "AML case management" },
    AmlScreenings: { bookNumber: 10, chapterNumber: "10.1", titleEn: "Screening dispositions" },
    AmlRules: { bookNumber: 10, chapterNumber: "10.1", titleEn: "AML rules" },
    AmlReports: { bookNumber: 10, chapterNumber: "10.1", titleEn: "Regulatory reporting" },
    OperatorCases: { bookNumber: 7, chapterNumber: "7.2", titleEn: "Operator cases and runbooks" },
    OperatorCaseDetail: { bookNumber: 7, chapterNumber: "7.2", titleEn: "Operator cases and runbooks" },
    Disputes: { bookNumber: 11, chapterNumber: "11.1", titleEn: "Dispute and chargeback SOP" },
    Adjustments: { bookNumber: 11, chapterNumber: "11.2", titleEn: "Refund adjustment SOP" },
    CashOuts: { bookNumber: 12, chapterNumber: "12.1", titleEn: "Liquidity before cash-outs" },
    Reconciliation: { bookNumber: 8, chapterNumber: "8.2", titleEn: "Statement reconciliation" },
    Profitability: { bookNumber: 12, chapterNumber: "12.1", titleEn: "Profitability dashboard" },
    Liquidity: { bookNumber: 12, chapterNumber: "12.1", titleEn: "Liquidity and clearing ageing" },
    Invariant: { bookNumber: 12, chapterNumber: "12.1", titleEn: "Ledger invariant monitor" },
    Gateways: { bookNumber: 6, chapterNumber: "6.1", titleEn: "Gateway wizard" },
    GatewayWizard: { bookNumber: 6, chapterNumber: "6.1", titleEn: "8-step gateway wizard" },
    GatewayAiImport: { bookNumber: 6, chapterNumber: "6.2", titleEn: "Smart AI importer" },
    Rails: { bookNumber: 3, chapterNumber: "3.2", titleEn: "Visible rails formula" },
    GatewayRoutes: { bookNumber: 3, chapterNumber: "3.2", titleEn: "Route diagnostics" },
    Merchants: { bookNumber: 9, chapterNumber: "9.1", titleEn: "Merchant onboarding" },
    AdminCheckoutHelp: { bookNumber: 4, chapterNumber: "4.2", titleEn: "Checkout confirmation channels" },
    AdminGuide: { bookNumber: 1, chapterNumber: "1.1", titleEn: "Admin system guide" },
    AdminAcademy: { bookNumber: 1, chapterNumber: "1.1", titleEn: "Employee academy" },
};

export type TermExplanation = {
    title: string;
    category: string;
    meaningEn: string;
    meaningAr?: string;
    actionEn?: string;
    actionAr?: string;
};

const termExplanationCache = new Map<string, TermExplanation | undefined>();

export const lookupTerm = (term: string): TermExplanation | undefined => {
    const needle = term.trim().toLowerCase();
    if (!needle) return undefined;
    if (termExplanationCache.has(needle)) {
        return termExplanationCache.get(needle);
    }
    const result = lookupTermUncached(needle);
    termExplanationCache.set(needle, result);
    return result;
};

const lookupTermUncached = (needle: string): TermExplanation | undefined => {
    const glossary = GLOSSARY_TERMS.find((entry) => entry.term.toLowerCase() === needle);
    if (glossary) {
        return {
            title: glossary.term,
            category: glossary.category,
            meaningEn: `${glossary.definitionEn}\n\nAnalogy: ${glossary.analogyEn}`,
            meaningAr: glossary.definitionAr,
            actionEn: `Fatal human error to avoid: ${glossary.fatalErrorEn}`,
            actionAr: glossary.fatalErrorAr,
        };
    }
    const status = ATTEMPT_STATUS_DEFINITIONS.find((entry) => entry.code.toLowerCase() === needle);
    if (status) {
        return {
            title: status.code,
            category: `Attempt status · ${status.category}`,
            meaningEn: status.meaningEn,
            meaningAr: status.meaningAr,
            actionEn: `Slot locked: ${status.slotLocked}. Action: ${status.operatorAction}`,
        };
    }
    const gl = GL_ACCOUNT_DEFINITIONS.find((entry) => entry.code.toLowerCase() === needle);
    if (gl) {
        return {
            title: gl.code,
            category: `GL account · ${gl.normalBalance}`,
            meaningEn: gl.meaningEn,
            meaningAr: gl.meaningAr,
        };
    }
    const collection = COLLECTION_MODE_DEFINITIONS.find((entry) => entry.code.toLowerCase() === needle);
    if (collection) {
        return {
            title: collection.code,
            category: "Collection mode (Axis A)",
            meaningEn: collection.meaningEn,
            meaningAr: collection.meaningAr,
            actionEn: `Customer action: ${collection.customerActionEn}`,
            actionAr: collection.customerActionAr,
        };
    }
    const channel = CONFIRMATION_CHANNEL_DEFINITIONS.find((entry) => entry.code.toLowerCase() === needle);
    if (channel) {
        return {
            title: channel.code,
            category: `Confirmation channel · ${channel.trustLevel}`,
            meaningEn: channel.meaningEn,
            meaningAr: channel.meaningAr,
            actionEn: channel.trustLevel === "ZERO_TRUST" ? "Never post money from this channel; run VERIFY / INQUIRY." : "Server-trusted channel when signature/reference/amount/currency/environment match.",
        };
    }
    const error = ERROR_CODE_GLOSSARY.find((entry) => entry.code.toLowerCase() === needle);
    if (error) {
        return {
            title: error.code,
            category: "Canonical error code",
            meaningEn: error.meaningEn,
            meaningAr: error.meaningAr,
        };
    }
    const runbook = RUNBOOK_DEFINITIONS.find((entry) => entry.id.toLowerCase() === needle);
    if (runbook) {
        return {
            title: runbook.id,
            category: "Incident runbook",
            meaningEn: `${runbook.triggerEn}\n\n${runbook.stepsEn.join("\n")}`,
            meaningAr: `${runbook.triggerAr}\n\n${runbook.stepsAr.join("\n")}`,
        };
    }
    return undefined;
};
