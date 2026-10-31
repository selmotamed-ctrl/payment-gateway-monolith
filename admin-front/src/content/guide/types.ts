export type GuideChapter = {
    id: string;
    number: string;
    titleEn: string;
    titleAr?: string;
    bodyEn: string;
    bodyAr?: string;
    humanErrorWarning?: string;
    sopChecklist?: string[];
    tags: string[];
};

export type GuideBook = {
    id: string;
    number: number;
    titleEn: string;
    titleAr: string;
    summaryEn: string;
    summaryAr?: string;
    chapters: GuideChapter[];
    sopChecklist: string[];
    humanErrorWarning: string;
    tags: string[];
};

export type GlossaryTerm = {
    term: string;
    category: string;
    definitionEn: string;
    definitionAr?: string;
    analogyEn: string;
    analogyAr?: string;
    fatalErrorEn: string;
    fatalErrorAr?: string;
    tags: string[];
};

export type GlossaryEntry = {
    code: string;
    meaningEn: string;
    meaningAr?: string;
    category?: string;
    tags?: string[];
};

export type CollectionModeDefinition = {
    code: string;
    titleEn: string;
    titleAr: string;
    meaningEn: string;
    meaningAr: string;
    customerActionEn: string;
    customerActionAr: string;
    tags?: string[];
};

export type ConfirmationChannelDefinition = {
    code: string;
    titleEn: string;
    titleAr: string;
    trustLevel: "ZERO_TRUST" | "SERVER_TRUSTED";
    meaningEn: string;
    meaningAr: string;
    tags?: string[];
};

export type RunbookDefinition = {
    id: string;
    titleEn: string;
    titleAr: string;
    triggerEn: string;
    triggerAr: string;
    stepsEn: string[];
    stepsAr: string[];
};

export type EdgeCaseDefinition = {
    id: string;
    titleEn: string;
    titleAr: string;
    descriptionEn: string;
    descriptionAr: string;
    tags?: string[];
};

export type GuideSearchEntry = {
    id: string;
    kind: "book" | "chapter" | "glossary" | "error" | "gl" | "status" | "collection" | "channel" | "runbook" | "edge-case" | "simulator";
    titleEn: string;
    titleAr: string;
    bodyEn: string;
    bodyAr?: string;
    bookNumber?: number;
    chapterId?: string;
    tags: string[];
};
