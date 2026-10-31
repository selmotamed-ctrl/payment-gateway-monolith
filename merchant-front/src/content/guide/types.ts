export type MerchantChapterRole =
    | "MERCHANT_ADMIN"
    | "MERCHANT_STAFF"
    | "MERCHANT_CASHIER"
    | "DEVELOPER"
    | "ALL";

export type MerchantGuideChapter = {
    id: string;
    number: string;
    role: MerchantChapterRole;
    titleEn: string;
    titleAr?: string;
    bodyEn: string;
    bodyAr?: string;
    tags: string[];
};

export type DeveloperCodeLanguage = "typescript" | "php" | "python" | "curl";

export type DeveloperChapter = {
    id: string;
    number: string;
    titleEn: string;
    titleAr?: string;
    bodyEn: string;
    bodyAr?: string;
    codeTemplates?: Partial<Record<DeveloperCodeLanguage, string>>;
    tags: string[];
};
