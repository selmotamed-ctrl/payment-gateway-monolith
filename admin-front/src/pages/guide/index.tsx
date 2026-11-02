import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { useRoute } from "vue-router";
import { VAlert, VBtn, VExpansionPanel, VExpansionPanelText, VExpansionPanelTitle, VExpansionPanels, VFileInput, VIcon, VList, VListItem, VListSubheader, VSwitch, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { showSnackBar } from "@/utils/snackBar";
import { GuideMarkdown } from "@/components/guide/GuideMarkdown";
import { GlobalGuideSearchModal } from "@/components/guide/GlobalGuideSearchModal";
import { TermTooltip } from "@/components/guide/TermTooltip";
import { TransformPlayground } from "@/components/guide/parts/TransformPlayground";
import { CryptoSignatureLab } from "@/components/guide/parts/CryptoSignatureLab";
import { LedgerTAccountVisualizer } from "@/components/guide/parts/LedgerTAccountVisualizer";
import { buildGuideSearchIndex } from "@/content/guide/search";
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
    type GuideBook,
    type GuideChapter,
    type GuideSearchEntry,
} from "@/content/guide";

import { FormModal } from "@/components/ui/FormModal";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { MetaPill } from "@/components/ui/MetaPill";
type ViewMode = "glossary" | "book" | "simulators" | "checklists";

type DailyChecklist = {
    id: string;
    titleEn: string;
    titleAr: string;
    steps: string[];
};

const DAILY_CHECKLISTS: DailyChecklist[] = [
    {
        id: "support",
        titleEn: "Support specialist — daily checklist",
        titleAr: "أخصائي الدعم — قائمة يومية",
        steps: [
            "Never ask a payer for a card PIN or SMS OTP; support never needs an OTP to check a payment.",
            "Read the attempt status from the portal, not from a customer screenshot.",
            "For UNKNOWN or VERIFYING, tell the customer not to pay a second time.",
            "Never mention AML, sanctions, PEP, or watchlists; use neutral operational wording.",
            "Escalate any request to change a payout IBAN or commission to the governed approval flow.",
        ],
    },
    {
        id: "operations",
        titleEn: "Operations officer — daily checklist",
        titleAr: "ضابط عمليات — قائمة يومية",
        steps: [
            "Open /operator-cases and clear the oldest UNKNOWN cases first using RB-03.",
            "Check that no terminal attempt still holds active_locked_count above zero.",
            "Confirm routes in DRAINING are draining only, not receiving new attempts.",
            "Review the UNKNOWN backlog age before the end of the shift.",
            "Record the runbook id in every operator case you resolve.",
        ],
    },
    {
        id: "compliance",
        titleEn: "Compliance analyst — daily checklist",
        titleAr: "محلل امتثال — قائمة يومية",
        steps: [
            "Disposition every screening candidate with the discriminating evidence.",
            "Never share AML-CONFIDENTIAL data with Support, Operations, merchants, or payers.",
            "Check correlated escalation cases first; they carry a 4-hour SLA.",
            "Verify no merchant notification template mentions AML, screening, or an STR.",
            "Route every case resolution to the MLRO Checker; never self-approve.",
        ],
    },
    {
        id: "finance",
        titleEn: "Finance controller — daily checklist",
        titleAr: "مراقب مالي — قائمة يومية",
        steps: [
            "Confirm /finance/invariant-check reads exactly 0.0000 LYD drift.",
            "Review clearing ageing buckets before approving large cash-outs.",
            "Check every chargeback is capped to settled_amount minus executed refunds.",
            "Verify MERCHANT_DIRECT commission receivable against the ceiling.",
            "Never edit a statement amount to force a reconciliation match.",
        ],
    },
    {
        id: "gateway",
        titleEn: "Gateway architect — daily checklist",
        titleAr: "مهندس بوابات — قائمة يومية",
        steps: [
            "Never edit a LIVE gateway version; create a DRAFT version instead.",
            "Confirm every MOVES_MONEY step has retry_policy = NEVER unless idempotency is proven.",
            "Confirm every weak confirmation channel has must_inquire = true.",
            "Confirm every URL is https and its host is in allowed_hosts.",
            "Do not promote a version until all twelve go-live gates are green and a Checker approves.",
        ],
    },
];

const BOOKMARK_KEY = "admin-guide-bookmarks";
const CHECKLIST_KEY = "admin-guide-daily-checklists";

const readJson = <T,>(key: string, fallback: T): T => {
    if (typeof localStorage === "undefined") return fallback;
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
};

const writeJson = (key: string, value: unknown) => {
    if (typeof localStorage === "undefined") return;
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // A full or disabled localStorage must never break the guide.
    }
};

const AdminGuidePage = dc(() => {
    const { current } = useLocale();
    const route = useRoute();
    const isArabic = computed(() => current.value === "ar");

    const view = ref<ViewMode>("book");
    const selectedBook = ref<GuideBook>(GUIDE_BOOKS[0]!);
    const searchOpen = ref(false);
    const searchSelection = ref<GuideSearchEntry | null>(null);
    const searchDetailOpen = ref(false);
    const expandedChapters = ref<string[]>([]);
    const bookmarks = ref<string[]>(readJson<string[]>(BOOKMARK_KEY, []));
    const importOpen = ref(false);
    const importError = ref<string | null>(null);
    const importLoading = ref(false);
    const importResult = ref<{ imported: number; skipped: number; total: number } | null>(null);
    const replaceBookmarks = ref(false);
    const checklistState = ref<Record<string, boolean>>(readJson<Record<string, boolean>>(CHECKLIST_KEY, {}));
    const glossaryFilter = ref("");

    const bookTitle = (book: GuideBook): string => (isArabic.value ? book.titleAr : book.titleEn);
    const chapterTitle = (chapter: GuideChapter): string => (isArabic.value ? chapter.titleAr ?? chapter.titleEn : chapter.titleEn);
    const chapterBody = (chapter: GuideChapter): string => (isArabic.value && chapter.bodyAr ? chapter.bodyAr : chapter.bodyEn);

    const chapterRoutes = (body: string): string[] => {
        const matches = body.match(/(?<![\w:/])\/[a-zA-Z0-9][a-zA-Z0-9\-/]*/g) ?? [];
        return [...new Set(matches)]
            .filter((route) => route.length > 1 && route.length < 60 && !route.startsWith("//"))
            .slice(0, 8);
    };

    const openBook = (book: GuideBook, chapterId?: string) => {
        selectedBook.value = book;
        view.value = "book";
        if (chapterId) {
            expandedChapters.value = [chapterId];
        } else {
            expandedChapters.value = book.chapters.slice(0, 1).map((chapter) => chapter.id);
        }
        if (typeof window !== "undefined") {
            window.scrollTo({ top: 0, behavior: "smooth" });
        }
    };

    const importBookmarks = async (value: File | File[] | null) => {
        const file = Array.isArray(value) ? value[0] : value;
        if (!file) return;
        importLoading.value = true;
        importError.value = null;
        importResult.value = null;
        try {
            const text = await file.text();
            let parsed: unknown;
            try {
                parsed = JSON.parse(text);
            } catch {
                importError.value = isArabic.value ? "الملف ليس JSON صالحاً." : "The selected file is not valid JSON.";
                return;
            }
            const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray((parsed as Record<string, unknown>).bookmarks)
                ? (parsed as Record<string, unknown>).bookmarks
                : parsed;
            if (!Array.isArray(raw)) {
                importError.value = isArabic.value ? "صيغة النسخة غير صحيحة." : "The backup format is invalid.";
                return;
            }
            const candidateIds = raw
                .map((entry) => (typeof entry === "string" ? entry : entry && typeof entry === "object" && "id" in entry ? String((entry as Record<string, unknown>).id ?? "") : ""))
                .filter(Boolean);
            const known = new Set(GUIDE_BOOKS.map((book) => book.id));
            const valid = candidateIds.filter((id) => known.has(id));
            const skipped = candidateIds.length - valid.length;
            const next = replaceBookmarks.value
                ? [...new Set(valid)]
                : [...new Set([...bookmarks.value, ...valid])];
            bookmarks.value = next;
            writeJson(BOOKMARK_KEY, next);
            importResult.value = { imported: valid.length, skipped, total: candidateIds.length };
            showSnackBar({
                type: skipped > 0 ? "warning" : "success",
                message: `${isArabic.value ? "تم استيراد العلامات" : "Bookmarks imported"}: ${valid.length}`,
            });
        } catch {
            importError.value = isArabic.value ? "تعذر قراءة الملف." : "Could not read the selected file.";
        } finally {
            importLoading.value = false;
        }
    };

    const exportBookmarks = () => {
        const books = bookmarks.value
            .map((id) => GUIDE_BOOKS.find((book) => book.id === id))
            .filter((book): book is GuideBook => Boolean(book));
        if (books.length === 0) {
            showSnackBar({
                type: "warning",
                message: isArabic.value ? "لا توجد كتب محفوظة للتصدير." : "No bookmarked books to export.",
            });
            return;
        }
        const payload = {
            exportedAt: new Date().toISOString(),
            bookmarks: books.map((book) => ({
                id: book.id,
                number: book.number,
                titleEn: book.titleEn,
                titleAr: book.titleAr,
                summaryEn: book.summaryEn,
                summaryAr: book.summaryAr,
                chapters: book.chapters.map((chapter) => ({
                    id: chapter.id,
                    number: chapter.number,
                    titleEn: chapter.titleEn,
                    titleAr: chapter.titleAr,
                })),
            })),
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `admin-guide-bookmarks-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        showSnackBar({
            type: "success",
            message: `${isArabic.value ? "تم تصدير العلامات" : "Bookmarks exported"}: ${books.length}`,
        });
    };

    const copyBookLink = async () => {
        const url = new URL(window.location.href);
        url.searchParams.set("book", selectedBook.value.id);
        const chapter = expandedChapters.value[0];
        if (chapter) url.searchParams.set("chapter", chapter);
        else url.searchParams.delete("chapter");
        const link = url.toString();
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(link);
            } else {
                throw new Error("clipboard unavailable");
            }
        } catch {
            const input = document.createElement("textarea");
            input.value = link;
            input.style.position = "fixed";
            input.style.opacity = "0";
            document.body.appendChild(input);
            input.select();
            document.execCommand("copy");
            input.remove();
        }
        showSnackBar({
            type: "success",
            message: isArabic.value ? "تم نسخ رابط الكتاب" : "Book link copied",
        });
    };

    const exportBook = (book: GuideBook) => {
        const summary = isArabic.value && book.summaryAr ? book.summaryAr : book.summaryEn;
        const lines: string[] = [
            `# ${book.number}. ${bookTitle(book)}`,
            "",
            summary,
            "",
            `${isArabic.value ? "الوسوم" : "Tags"}: ${book.tags.join(", ")}`,
            "",
        ];
        for (const chapter of book.chapters) {
            lines.push(`## ${chapter.number}. ${chapterTitle(chapter)}`, "", chapterBody(chapter), "");
        }
        if (book.humanErrorWarning) lines.push(`> ${book.humanErrorWarning}`, "");
        if (book.sopChecklist.length > 0) {
            lines.push(`## ${isArabic.value ? "قائمة التحقق" : "SOP checklist"}`, "");
            for (const step of book.sopChecklist) lines.push(`- ${step}`);
        }
        const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `admin-guide-book-${book.number}-${new Date().toISOString().slice(0, 10)}.md`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        showSnackBar({
            type: "success",
            message: isArabic.value ? "تم تنزيل الكتاب" : "Book downloaded",
        });
    };

    const toggleBookmark = (book: GuideBook) => {
        const next = bookmarks.value.includes(book.id)
            ? bookmarks.value.filter((id) => id !== book.id)
            : [...bookmarks.value, book.id];
        bookmarks.value = next;
        writeJson(BOOKMARK_KEY, next);
    };

    const toggleChecklist = (id: string) => {
        const next = { ...checklistState.value, [id]: !checklistState.value[id] };
        checklistState.value = next;
        writeJson(CHECKLIST_KEY, next);
    };

    const handleSearchSelect = (entry: GuideSearchEntry) => {
        searchSelection.value = entry;
        searchDetailOpen.value = true;
        if (entry.bookNumber) {
            const book = GUIDE_BOOKS.find((candidate) => candidate.number === entry.bookNumber);
            if (book) {
                openBook(book, entry.chapterId);
            }
        }
    };

    onMounted(() => {
        const entryId = typeof route.query.entry === "string" ? route.query.entry : "";
        const bookId = typeof route.query.book === "string" ? route.query.book : "";
        if (route.query.search === "1") searchOpen.value = true;
        const chapterId = typeof route.query.chapter === "string" ? route.query.chapter : "";
        if (entryId) {
            const entry = buildGuideSearchIndex().find((candidate) => candidate.id === entryId);
            if (entry) {
                handleSearchSelect(entry);
            }
            return;
        }
        if (bookId) {
            const book = GUIDE_BOOKS.find((candidate) => candidate.id === bookId);
            if (book) openBook(book, chapterId || undefined);
        }
    });

    const filteredGlossary = computed(() => {
        const needle = glossaryFilter.value.trim().toLowerCase();
        if (!needle) return GLOSSARY_TERMS;
        return GLOSSARY_TERMS.filter((term) =>
            `${term.term} ${term.category} ${term.definitionEn} ${term.analogyEn} ${term.fatalErrorEn}`.toLowerCase().includes(needle),
        );
    });

    const filteredEdgeCases = computed(() => {
        const needle = glossaryFilter.value.trim().toLowerCase();
        if (!needle) return EDGE_CASE_DEFINITIONS;
        return EDGE_CASE_DEFINITIONS.filter((entry) =>
            `${entry.id} ${entry.titleEn} ${entry.descriptionEn}`.toLowerCase().includes(needle),
        );
    });

    const renderGlossary = () => (
        <ThemedView style={{ gap: "14px" }}>
            <SurfaceCard>
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    <ThemedView style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                        <ThemedView style={{ gap: "4px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "20px" }}>
                                {isArabic.value ? "القاموس التأسيسي بلا افتراضات مسبقة" : "Zero-assumption foundational glossary"}
                            </ThemedText>
                            <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                                {isArabic.value
                                    ? "كل مصطلح مشروح لشخص لا يعرف شيئاً عن البنوك أو المحاسبة أو البرمجة."
                                    : "Every term explained for someone with no prior banking, accounting, or software background."}
                            </ThemedText>
                        </ThemedView>
                        <VTextField
                            modelValue={glossaryFilter.value}
                            onUpdate:modelValue={(value: string) => (glossaryFilter.value = value ?? "")}
                            label={isArabic.value ? "ابحث في القاموس" : "Filter glossary"}
                            prependInnerIcon="mdi-magnify"
                            clearable
                            hideDetails
                            style={{ maxWidth: "320px" }}
                        />
                    </ThemedView>
                </SurfaceCardText>
            </SurfaceCard>

            <VExpansionPanels multiple>
                <VExpansionPanel value="terms">
                    <VExpansionPanelTitle>
                        {`${filteredGlossary.value.length} ${isArabic.value ? "مصطلح أساسي" : "core terms"}`}
                    </VExpansionPanelTitle>
                    <VExpansionPanelText>
                        <ThemedView style={{ gap: "14px", paddingTop: "6px" }}>
                            {filteredGlossary.value.map((term) => (
                                <SurfaceCard key={term.term} variant="outlined">
                                    <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                            <TermTooltip term={term.term} label={term.term} tone="primary" size="small" />
                                            <StatusChip label={term.category} tone="neutral" size="x-small" />
                                        </ThemedView>
                                        <ThemedText style={{ fontSize: "13px", lineHeight: 1.7 }}>
                                            {isArabic.value && term.definitionAr ? term.definitionAr : term.definitionEn}
                                        </ThemedText>
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.75 }}>
                                            {`${isArabic.value ? "تشبيه:" : "Analogy:"} ${isArabic.value && term.analogyAr ? term.analogyAr : term.analogyEn}`}
                                        </ThemedText>
                                        <div
                                            style={{
                                                fontSize: "12px",
                                                lineHeight: 1.6,
                                                padding: "8px 10px",
                                                borderRadius: "8px",
                                                background: "rgba(239,68,68,0.08)",
                                                whiteSpace: "pre-wrap",
                                            }}
                                        >
                                            {`${isArabic.value ? "خطأ قاتل يجب تجنبه:" : "Fatal human error to avoid:"} ${isArabic.value && term.fatalErrorAr ? term.fatalErrorAr : term.fatalErrorEn}`}
                                        </div>
                                    </SurfaceCardText>
                                </SurfaceCard>
                            ))}
                        </ThemedView>
                    </VExpansionPanelText>
                </VExpansionPanel>

                <VExpansionPanel value="statuses">
                    <VExpansionPanelTitle>{isArabic.value ? "حالات المحاولة الأربع عشرة" : "The 14 attempt statuses"}</VExpansionPanelTitle>
                    <VExpansionPanelText>
                        <ThemedView style={{ gap: "8px", paddingTop: "6px" }}>
                            {ATTEMPT_STATUS_DEFINITIONS.map((status) => (
                                <ThemedView key={status.code} style={{ gap: "4px", padding: "8px 0", borderBottom: "1px solid rgba(100,116,139,0.15)" }}>
                                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                        <TermTooltip term={status.code} tone="info" size="small" />
                                        <StatusChip label={status.category} tone="neutral" size="x-small" />
                                        <StatusChip label={status.slotLocked} tone={status.slotLocked.startsWith("YES") ? "error" : "success"} size="x-small" />
                                    </ThemedView>
                                    <ThemedText style={{ fontSize: "13px", lineHeight: 1.6 }}>
                                        {isArabic.value && status.meaningAr ? status.meaningAr : status.meaningEn}
                                    </ThemedText>
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.72 }}>{status.operatorAction}</ThemedText>
                                </ThemedView>
                            ))}
                        </ThemedView>
                    </VExpansionPanelText>
                </VExpansionPanel>

                <VExpansionPanel value="gl">
                    <VExpansionPanelTitle>{isArabic.value ? "أنواع حسابات الدفتر العشرة" : "The 10 GL account types"}</VExpansionPanelTitle>
                    <VExpansionPanelText>
                        <ThemedView style={{ gap: "8px", paddingTop: "6px" }}>
                            {GL_ACCOUNT_DEFINITIONS.map((account) => (
                                <ThemedView key={account.code} style={{ gap: "4px", padding: "8px 0", borderBottom: "1px solid rgba(100,116,139,0.15)" }}>
                                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                        <TermTooltip term={account.code} tone="warning" size="small" />
                                        <StatusChip label={account.normalBalance} tone="neutral" size="x-small" />
                                    </ThemedView>
                                    <ThemedText style={{ fontSize: "13px", lineHeight: 1.6 }}>
                                        {isArabic.value && account.meaningAr ? account.meaningAr : account.meaningEn}
                                    </ThemedText>
                                </ThemedView>
                            ))}
                        </ThemedView>
                    </VExpansionPanelText>
                </VExpansionPanel>

                <VExpansionPanel value="collections">
                    <VExpansionPanelTitle>{isArabic.value ? "أنماط التحصيل التسعة" : "The 9 collection modes (Axis A)"}</VExpansionPanelTitle>
                    <VExpansionPanelText>
                        <ThemedView style={{ gap: "8px", paddingTop: "6px" }}>
                            {COLLECTION_MODE_DEFINITIONS.map((mode) => (
                                <ThemedView key={mode.code} style={{ gap: "4px", padding: "8px 0", borderBottom: "1px solid rgba(100,116,139,0.15)" }}>
                                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                        <TermTooltip term={mode.code} tone="primary" size="small" />
                                        <StatusChip label={isArabic.value ? mode.titleAr : mode.titleEn} tone="neutral" size="x-small" />
                                    </ThemedView>
                                    <ThemedText style={{ fontSize: "13px", lineHeight: 1.6 }}>
                                        {isArabic.value ? mode.meaningAr : mode.meaningEn}
                                    </ThemedText>
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>
                                        {isArabic.value ? mode.customerActionAr : mode.customerActionEn}
                                    </ThemedText>
                                </ThemedView>
                            ))}
                        </ThemedView>
                    </VExpansionPanelText>
                </VExpansionPanel>

                <VExpansionPanel value="channels">
                    <VExpansionPanelTitle>{isArabic.value ? "قنوات التأكيد السبع" : "The 7 confirmation channels (Axis B)"}</VExpansionPanelTitle>
                    <VExpansionPanelText>
                        <ThemedView style={{ gap: "8px", paddingTop: "6px" }}>
                            {CONFIRMATION_CHANNEL_DEFINITIONS.map((channel) => (
                                <ThemedView key={channel.code} style={{ gap: "4px", padding: "8px 0", borderBottom: "1px solid rgba(100,116,139,0.15)" }}>
                                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                        <TermTooltip term={channel.code} tone={channel.trustLevel === "ZERO_TRUST" ? "error" : "success"} size="small" />
                                        <StatusChip label={channel.trustLevel} tone={channel.trustLevel === "ZERO_TRUST" ? "error" : "success"} size="x-small" />
                                        <StatusChip label={isArabic.value ? channel.titleAr : channel.titleEn} tone="neutral" size="x-small" />
                                    </ThemedView>
                                    <ThemedText style={{ fontSize: "13px", lineHeight: 1.6 }}>
                                        {isArabic.value ? channel.meaningAr : channel.meaningEn}
                                    </ThemedText>
                                </ThemedView>
                            ))}
                        </ThemedView>
                    </VExpansionPanelText>
                </VExpansionPanel>

                <VExpansionPanel value="errors">
                    <VExpansionPanelTitle>{isArabic.value ? "أكواد الأخطاء القياسية" : "Canonical error codes"}</VExpansionPanelTitle>
                    <VExpansionPanelText>
                        <ThemedView style={{ gap: "8px", paddingTop: "6px" }}>
                            {ERROR_CODE_GLOSSARY.map((entry) => (
                                <ThemedView key={entry.code} style={{ gap: "4px", padding: "8px 0", borderBottom: "1px solid rgba(100,116,139,0.15)" }}>
                                    <TermTooltip term={entry.code} tone="error" size="small" />
                                    <ThemedText style={{ fontSize: "13px", lineHeight: 1.6 }}>
                                        {isArabic.value && entry.meaningAr ? entry.meaningAr : entry.meaningEn}
                                    </ThemedText>
                                </ThemedView>
                            ))}
                        </ThemedView>
                    </VExpansionPanelText>
                </VExpansionPanel>

                <VExpansionPanel value="runbooks">
                    <VExpansionPanelTitle>{isArabic.value ? "الأدلة التشغيلية RB-01 إلى RB-05" : "Incident runbooks RB-01 to RB-05"}</VExpansionPanelTitle>
                    <VExpansionPanelText>
                        <ThemedView style={{ gap: "12px", paddingTop: "6px" }}>
                            {RUNBOOK_DEFINITIONS.map((runbook) => (
                                <SurfaceCard key={runbook.id} variant="outlined">
                                    <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                            <TermTooltip term={runbook.id} tone="error" size="small" />
                                            <ThemedText type="defaultSemiBold">{isArabic.value ? runbook.titleAr : runbook.titleEn}</ThemedText>
                                        </ThemedView>
                                        <ThemedText style={{ fontSize: "13px", opacity: 0.8 }}>{isArabic.value ? runbook.triggerAr : runbook.triggerEn}</ThemedText>
                                        <ol style={{ margin: 0, paddingInlineStart: "22px", lineHeight: 1.7, fontSize: "13px" }}>
                                            {(isArabic.value ? runbook.stepsAr : runbook.stepsEn).map((step, index) => (
                                                <li key={`${runbook.id}-${index}`}>{step}</li>
                                            ))}
                                        </ol>
                                    </SurfaceCardText>
                                </SurfaceCard>
                            ))}
                        </ThemedView>
                    </VExpansionPanelText>
                </VExpansionPanel>

                <VExpansionPanel value="edge-cases">
                    <VExpansionPanelTitle>{`${isArabic.value ? "سجل الحالات الطرفية" : "Edge case registry"} (${filteredEdgeCases.value.length} / 140)`}</VExpansionPanelTitle>
                    <VExpansionPanelText>
                        <ThemedView style={{ gap: "6px", paddingTop: "6px" }}>
                            {filteredEdgeCases.value.map((edgeCase) => (
                                <ThemedView key={edgeCase.id} style={{ gap: "2px", padding: "6px 0", borderBottom: "1px solid rgba(100,116,139,0.12)" }}>
                                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                        <StatusChip label={edgeCase.id} tone="neutral" size="x-small" />
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>
                                            {isArabic.value ? edgeCase.titleAr : edgeCase.titleEn}
                                        </ThemedText>
                                    </ThemedView>
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.72 }}>
                                        {isArabic.value ? edgeCase.descriptionAr : edgeCase.descriptionEn}
                                    </ThemedText>
                                </ThemedView>
                            ))}
                        </ThemedView>
                    </VExpansionPanelText>
                </VExpansionPanel>
            </VExpansionPanels>
        </ThemedView>
    );

    const renderBook = () => (
        <ThemedView style={{ gap: "14px" }}>
            <SurfaceCard>
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                        <StatusChip label={`Book ${selectedBook.value.number}`} tone="primary" />
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "22px", flex: "1 1 320px" }}>
                            {bookTitle(selectedBook.value)}
                        </ThemedText>
                        <VBtn
                            size="small"
                            variant="tonal"
                            prependIcon="mdi-download"
                            onClick={() => exportBook(selectedBook.value)}
                        >
                            {isArabic.value ? "تنزيل الكتاب" : "Download book"}
                        </VBtn>
                        <VBtn
                            size="small"
                            variant="tonal"
                            prependIcon="mdi-link-variant"
                            onClick={() => void copyBookLink()}
                        >
                            {isArabic.value ? "نسخ الرابط" : "Copy link"}
                        </VBtn>
                        <VBtn
                            size="small"
                            variant={bookmarks.value.includes(selectedBook.value.id) ? "flat" : "tonal"}
                            color={bookmarks.value.includes(selectedBook.value.id) ? "success" : undefined}
                            prependIcon="mdi-bookmark-outline"
                            onClick={() => toggleBookmark(selectedBook.value)}
                        >
                            {bookmarks.value.includes(selectedBook.value.id)
                                ? isArabic.value ? "محفوظ" : "Bookmarked"
                                : isArabic.value ? "حفظ" : "Bookmark"}
                        </VBtn>
                    </ThemedView>
                    <ThemedText style={{ fontSize: "14px", opacity: 0.8, lineHeight: 1.7 }}>
                        {isArabic.value && selectedBook.value.summaryAr ? selectedBook.value.summaryAr : selectedBook.value.summaryEn}
                    </ThemedText>
                    <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                        {selectedBook.value.tags.slice(0, 12).map((tag) => (
                            <MetaPill key={`book-tag-${tag}`} size="x-small" variant="tonal">{tag}</MetaPill>
                        ))}
                    </ThemedView>
                </SurfaceCardText>
            </SurfaceCard>

            {selectedBook.value.humanErrorWarning ? (
                <VAlert type="error" variant="tonal" border="start">
                    <ThemedText type="defaultSemiBold" style={{ fontSize: "13px", marginBottom: "4px" }}>
                        {isArabic.value ? "تحذير خطأ بشري حرج — ما لا يجب فعله أبداً" : "CRITICAL HUMAN ERROR WARNING — What never to do"}
                    </ThemedText>
                    <ThemedText style={{ fontSize: "13px", whiteSpace: "pre-wrap", lineHeight: 1.7 }}>
                        {selectedBook.value.humanErrorWarning}
                    </ThemedText>
                </VAlert>
            ) : null}

            <SurfaceCard variant="outlined">
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <ThemedText type="defaultSemiBold">{isArabic.value ? "قائمة SOP لهذا الكتاب" : "SOP checklist for this book"}</ThemedText>
                    <ol style={{ margin: 0, paddingInlineStart: "22px", lineHeight: 1.7, fontSize: "13px" }}>
                        {selectedBook.value.sopChecklist.map((step, index) => (
                            <li key={`book-sop-${index}`}>{step}</li>
                        ))}
                    </ol>
                </SurfaceCardText>
            </SurfaceCard>

            <VExpansionPanels modelValue={expandedChapters.value} onUpdate:modelValue={(value: any) => (expandedChapters.value = value as string[])} multiple>
                {selectedBook.value.chapters.map((chapter) => (
                    <VExpansionPanel key={chapter.id} value={chapter.id}>
                        <VExpansionPanelTitle>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <StatusChip label={chapter.number} tone="info" size="x-small" />
                                <span>{chapterTitle(chapter)}</span>
                            </ThemedView>
                        </VExpansionPanelTitle>
                        <VExpansionPanelText>
                            <ThemedView style={{ gap: "10px", paddingTop: "4px" }}>
                                {chapterRoutes(chapterBody(chapter)).length > 0 ? (
                                    <ThemedView style={{ gap: "4px" }}>
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>
                                            {isArabic.value ? "أين تنقر في البوابة" : "Where to click in the portal"}
                                        </ThemedText>
                                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                            {chapterRoutes(chapterBody(chapter)).map((route) => (
                                                <MetaPill key={`${chapter.id}-route-${route}`} size="x-small" variant="tonal" prependIcon="mdi-map-marker-path">
                                                    {route}
                                                </MetaPill>
                                            ))}
                                        </ThemedView>
                                    </ThemedView>
                                ) : null}
                                <GuideMarkdown source={chapterBody(chapter)} />
                                {selectedBook.value.number === 5 && chapter.number === "5.2" ? (
                                    <ThemedView style={{ gap: "8px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "14px" }}>
                                            {isArabic.value ? "جرّب التحويلات الآن" : "Try the transform pipeline now"}
                                        </ThemedText>
                                        <TransformPlayground />
                                    </ThemedView>
                                ) : null}
                                {selectedBook.value.number === 5 && chapter.number === "5.3" ? (
                                    <ThemedView style={{ gap: "8px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "14px" }}>
                                            {isArabic.value ? "جرّب التوقيع التشفيري الآن" : "Try the cryptographic signing now"}
                                        </ThemedText>
                                        <CryptoSignatureLab />
                                    </ThemedView>
                                ) : null}
                                {selectedBook.value.number === 8 && chapter.number === "8.2" ? (
                                    <ThemedView style={{ gap: "8px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "14px" }}>
                                            {isArabic.value ? "جرّب قيود الدفتر الآن" : "Try the double-entry journal now"}
                                        </ThemedText>
                                        <LedgerTAccountVisualizer />
                                    </ThemedView>
                                ) : null}
                                <VBtn size="small" variant="text" prependIcon="mdi-flask-outline" onClick={() => (view.value = "simulators")}>
                                    {isArabic.value ? "جرّب هذا في المحاكيات التفاعلية" : "Try this in the interactive simulators"}
                                </VBtn>
                            </ThemedView>
                        </VExpansionPanelText>
                    </VExpansionPanel>
                ))}
            </VExpansionPanels>

            <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                <VBtn
                    variant="tonal"
                    prependIcon="mdi-arrow-left"
                    disabled={selectedBook.value.number <= 1}
                    onClick={() => {
                        const previous = GUIDE_BOOKS.find((book) => book.number === selectedBook.value.number - 1);
                        if (previous) openBook(previous);
                    }}
                >
                    {isArabic.value ? "الكتاب السابق" : "Previous book"}
                </VBtn>
                <VBtn
                    variant="tonal"
                    appendIcon="mdi-arrow-right"
                    disabled={selectedBook.value.number >= GUIDE_BOOKS.length}
                    onClick={() => {
                        const next = GUIDE_BOOKS.find((book) => book.number === selectedBook.value.number + 1);
                        if (next) openBook(next);
                    }}
                >
                    {isArabic.value ? "الكتاب التالي" : "Next book"}
                </VBtn>
            </ThemedView>
        </ThemedView>
    );

    const renderSimulators = () => (
        <ThemedView style={{ gap: "14px" }}>
            <SurfaceCard>
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <ThemedText type="defaultSemiBold" style={{ fontSize: "20px" }}>
                        {isArabic.value ? "المحاكيات التفاعلية الثلاثة" : "The three interactive simulators"}
                    </ThemedText>
                    <ThemedText style={{ fontSize: "13px", opacity: 0.72 }}>
                        {isArabic.value
                            ? "جرّب التحويلات والتوقيع التشفيري والقيود المحاسبية بأمان قبل لمس الإنتاج."
                            : "Exercise transforms, cryptographic signing, and double-entry journals safely before touching production."}
                    </ThemedText>
                </SurfaceCardText>
            </SurfaceCard>
            <SurfaceCard>
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <ThemedText type="defaultSemiBold">{isArabic.value ? "مختبر TransformPipe" : "TransformPipe Playground"}</ThemedText>
                    <TransformPlayground />
                </SurfaceCardText>
            </SurfaceCard>
            <SurfaceCard>
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <ThemedText type="defaultSemiBold">{isArabic.value ? "مختبر التوقيع التشفيري" : "Crypto Signature Lab"}</ThemedText>
                    <CryptoSignatureLab />
                </SurfaceCardText>
            </SurfaceCard>
            <SurfaceCard>
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <ThemedText type="defaultSemiBold">{isArabic.value ? "مصور حسابات الدفتر" : "Ledger T-Account Visualizer"}</ThemedText>
                    <LedgerTAccountVisualizer />
                </SurfaceCardText>
            </SurfaceCard>
        </ThemedView>
    );

    const renderChecklists = () => (
        <ThemedView style={{ gap: "14px" }}>
            <SurfaceCard>
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <ThemedText type="defaultSemiBold" style={{ fontSize: "20px" }}>
                        {isArabic.value ? "قوائم التحقق اليومية حسب الدور" : "Role-based daily checklists"}
                    </ThemedText>
                    <ThemedText style={{ fontSize: "13px", opacity: 0.72 }}>
                        {isArabic.value
                            ? "التحقق من هذه البنود كل صباح يحمي المنصة والعملاء من الأخطاء البشرية."
                            : "Checking these items every morning protects the platform and customers from human error."}
                    </ThemedText>
                </SurfaceCardText>
            </SurfaceCard>
            {DAILY_CHECKLISTS.map((checklist) => (
                <SurfaceCard key={checklist.id} variant="outlined">
                    <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                            <StatusChip label={checklist.id.toUpperCase()} tone="primary" size="x-small" />
                            <ThemedText type="defaultSemiBold">{isArabic.value ? checklist.titleAr : checklist.titleEn}</ThemedText>
                        </ThemedView>
                        {checklist.steps.map((step, index) => (
                            <ThemedView
                                key={`${checklist.id}-${index}`}
                                onClick={() => toggleChecklist(`${checklist.id}-${index}`)}
                                style={{
                                    flexDirection: "row",
                                    alignItems: "flex-start",
                                    gap: "8px",
                                    padding: "8px 10px",
                                    borderRadius: "8px",
                                    cursor: "pointer",
                                    background: checklistState.value[`${checklist.id}-${index}`] ? "rgba(5,150,105,0.10)" : "rgba(100,116,139,0.06)",
                                }}
                            >
                                <VIcon
                                    icon={checklistState.value[`${checklist.id}-${index}`] ? "mdi-checkbox-marked-circle" : "mdi-checkbox-blank-circle-outline"}
                                    color={checklistState.value[`${checklist.id}-${index}`] ? "success" : undefined}
                                    size="18px"
                                />
                                <ThemedText style={{ fontSize: "13px", lineHeight: 1.6 }}>{step}</ThemedText>
                            </ThemedView>
                        ))}
                    </SurfaceCardText>
                </SurfaceCard>
            ))}
        </ThemedView>
    );

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "16px" }}>
                <PageHeader
                    title={isArabic.value ? "دليل النظام التفاعلي" : "Interactive System Guide"}
                    subtitle={isArabic.value ? "إجراءات التشغيل والمعجم والمحاكيات والضوابط." : "Operational procedures, glossary, simulators, and controls."}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn size="small" variant="tonal" prependIcon="mdi-magnify" onClick={() => (searchOpen.value = true)}>
                                {isArabic.value ? "بحث فوري" : "Instant search"}
                            </VBtn>
                            <StatusChip label="Ctrl / Cmd + K" tone="neutral" size="x-small" />
                            <VBtn size="small" variant="tonal" prependIcon="mdi-download" onClick={exportBookmarks}>
                                {isArabic.value ? "تصدير العلامات" : "Export bookmarks"}
                            </VBtn>
                            <VBtn size="small" variant="tonal" prependIcon="mdi-upload" onClick={() => { importError.value = null; importResult.value = null; importOpen.value = true; }}>
                                {isArabic.value ? "استيراد العلامات" : "Import bookmarks"}
                            </VBtn>
                        </ThemedView>
                    )}
                />

                <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "16px", alignItems: "flex-start" }}>
                    <SurfaceCard style={{ flex: "1 1 300px", maxWidth: "380px" }}>
                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>
                                {isArabic.value ? "شجرة الدليل" : "Guide tree"}
                            </ThemedText>
                            <VList density="compact" nav>
                                <VListSubheader>{isArabic.value ? "القاموس والمحاكيات" : "Glossary & simulators"}</VListSubheader>
                                <VListItem
                                    active={view.value === "glossary"}
                                    prependIcon="mdi-book-alphabet"
                                    title={isArabic.value ? "القاموس التأسيسي" : "Zero-assumption glossary"}
                                    onClick={() => (view.value = "glossary")}
                                />
                                <VListItem
                                    active={view.value === "simulators"}
                                    prependIcon="mdi-flask-outline"
                                    title={isArabic.value ? "المحاكيات التفاعلية" : "Interactive simulators"}
                                    onClick={() => (view.value = "simulators")}
                                />
                                <VListItem
                                    active={view.value === "checklists"}
                                    prependIcon="mdi-checkbox-marked-circle-outline"
                                    title={isArabic.value ? "قوائم التحقق اليومية" : "Role-based daily checklists"}
                                    onClick={() => (view.value = "checklists")}
                                />
                                <VListSubheader>{isArabic.value ? "الكتب الاثنا عشر" : "The 12 books"}</VListSubheader>
                                {GUIDE_BOOKS.map((book) => (
                                    <div key={book.id}>
                                        <VListItem
                                            active={view.value === "book" && selectedBook.value.id === book.id}
                                            prependIcon={bookmarks.value.includes(book.id) ? "mdi-bookmark" : "mdi-book-open-variant"}
                                            title={`${book.number}. ${bookTitle(book)}`}
                                            onClick={() => openBook(book)}
                                        />
                                        {view.value === "book" && selectedBook.value.id === book.id ? (
                                            <ThemedView style={{ paddingInlineStart: "28px", paddingBottom: "4px", gap: "2px" }}>
                                                {book.chapters.map((chapter) => (
                                                    <VListItem
                                                        key={chapter.id}
                                                        active={expandedChapters.value.includes(chapter.id)}
                                                        title={`${chapter.number} ${chapterTitle(chapter)}`}
                                                        density="compact"
                                                        style={{ minHeight: "30px" }}
                                                        onClick={() => openBook(book, chapter.id)}
                                                    />
                                                ))}
                                            </ThemedView>
                                        ) : null}
                                    </div>
                                ))}
                            </VList>
                            {bookmarks.value.length > 0 ? (
                                <ThemedView style={{ gap: "4px" }}>
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                        {isArabic.value ? "الكتب المحفوظة" : "Bookmarked books"}
                                    </ThemedText>
                                    <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                        {bookmarks.value.map((id) => {
                                            const book = GUIDE_BOOKS.find((candidate) => candidate.id === id);
                                            return book ? (
                                                <MetaPill key={`bookmark-${id}`} size="x-small" variant="tonal" onClick={() => openBook(book)} style={{ cursor: "pointer" }}>
                                                    {`Book ${book.number}`}
                                                </MetaPill>
                                            ) : null;
                                        })}
                                    </ThemedView>
                                </ThemedView>
                            ) : null}
                        </SurfaceCardText>
                    </SurfaceCard>

                    <ThemedView style={{ flex: "3 1 620px", minWidth: "320px" }}>
                        {view.value === "glossary" ? renderGlossary() : null}
                        {view.value === "book" ? renderBook() : null}
                        {view.value === "simulators" ? renderSimulators() : null}
                        {view.value === "checklists" ? renderChecklists() : null}
                    </ThemedView>
                </ThemedView>
            </ThemedView>

            <FormModal
                modelValue={importOpen.value}
                onUpdate:modelValue={(value: boolean) => (importOpen.value = value)}
                title={isArabic.value ? "استيراد العلامات" : "Import bookmarks"}
                size="md"
            >
<VAlert type="info" variant="tonal" density="compact">
                            {isArabic.value
                                ? "اختر ملف نسخة العلامات الذي تم تصديره من هذا الدليل. سيتم تجاهل الكتب غير المعروفة."
                                : "Choose a bookmark backup exported from this guide. Unknown books are skipped."}
                        </VAlert>
                        <VFileInput
                            label={isArabic.value ? "ملف العلامات JSON" : "Bookmarks JSON"}
                            {...{ accept: ".json,application/json" }}
                            prependIcon="mdi-file-upload-outline"
                            onUpdate:modelValue={(value: File | File[] | null) => void importBookmarks(value)}
                        />
                        <VSwitch
                            label={isArabic.value ? "استبدال العلامات الحالية" : "Replace existing bookmarks"}
                            modelValue={replaceBookmarks.value}
                            onUpdate:modelValue={(value: boolean | null) => (replaceBookmarks.value = !!value)}
                            color="primary"
                            hideDetails
                        />
                        {importLoading.value && <StateView loading={true} minHeight="100px" />}
                        {importError.value && <VAlert type="error" variant="tonal" density="compact">{importError.value}</VAlert>}
                        {importResult.value && (
                            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                                <StatusChip label={`${isArabic.value ? "مستورد" : "Imported"}: ${importResult.value.imported}`} tone="success" />
                                <StatusChip label={`${isArabic.value ? "متجاهل" : "Skipped"}: ${importResult.value.skipped}`} tone={importResult.value.skipped > 0 ? "warning" : "neutral"} />
                                <StatusChip label={`${isArabic.value ? "إجمالي" : "Total"}: ${importResult.value.total}`} tone="info" />
                            </ThemedView>
                        )}
                        <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                            <VBtn variant="text" onClick={() => (importOpen.value = false)}>{isArabic.value ? "إغلاق" : "Close"}</VBtn>
                        </ThemedView>
            </FormModal>

            <GlobalGuideSearchModal
                modelValue={searchOpen.value}
                onUpdate:modelValue={(value: boolean) => (searchOpen.value = value)}
                onSelect={handleSearchSelect}
            />

            <FormModal
                modelValue={searchDetailOpen.value}
                onUpdate:modelValue={(value: boolean) => (searchDetailOpen.value = value)}
                title={searchSelection.value ? (isArabic.value ? searchSelection.value?.titleAr : searchSelection.value?.titleEn) : ""}
                size="lg"
            >
<ThemedView style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <StatusChip label={searchSelection.value?.kind ?? "guide"} tone="primary" size="x-small" />
                                
                            </ThemedView>
                            <VBtn icon="mdi-close" variant="text" onClick={() => (searchDetailOpen.value = false)} />
                        </ThemedView>
                        {searchSelection.value ? (
                            <GuideMarkdown source={isArabic.value && searchSelection.value.bodyAr ? searchSelection.value.bodyAr : searchSelection.value.bodyEn} />
                        ) : null}
            </FormModal>
        </ScreenContainer>
    );
});

export default AdminGuidePage;
