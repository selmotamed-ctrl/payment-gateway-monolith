import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import {
    VBtn,
    VCard,
    VCardText,
    VCheckbox,
    VChip,
    VDialog,
    VIcon,
    VProgressLinear,
    VTab,
    VTabs,
    VTextField,
    VWindow,
    VWindowItem,
} from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { GuideMarkdown } from "@/components/guide/GuideMarkdown";
import { MerchantFeeCalculator, type MerchantFeeCalculatorForm } from "@/components/guide/MerchantFeeCalculator";
import { MERCHANT_OPERATIONS_CHAPTERS } from "@/content/guide/merchantOperationsGuide";
import { MERCHANT_DEVELOPER_CHAPTERS } from "@/content/guide/merchantDeveloperApiGuide";
import type { DeveloperCodeLanguage, MerchantChapterRole } from "@/content/guide/types";
import { urlsMap } from "@/constants/urlsMap";
import { getBaseUrl } from "@/constants/baseUrl";
import { api } from "@/state/api";
import { showSnackBar } from "@/utils/snackBar";

type ChecklistStep = {
    id: string;
    labelEn: string;
    labelAr: string;
    routeName: string;
    icon: string;
    altRouteName?: string;
    altLabelEn?: string;
    altLabelAr?: string;
};

type GuideCard = {
    id: string;
    role: MerchantChapterRole;
    titleEn: string;
    titleAr?: string;
    bodyEn: string;
    bodyAr?: string;
    tags: string[];
    codeTemplates?: Partial<Record<DeveloperCodeLanguage, string>>;
};

const CHECKLIST_KEY = "merchant-guide-checklist";

const ROLE_FILTERS: { value: MerchantChapterRole; labelEn: string; labelAr: string }[] = [
    { value: "ALL", labelEn: "All chapters", labelAr: "كل الفصول" },
    { value: "MERCHANT_ADMIN", labelEn: "Business Owner", labelAr: "صاحب العمل" },
    { value: "MERCHANT_STAFF", labelEn: "Manager / Accountant", labelAr: "مدير / محاسب" },
    { value: "MERCHANT_CASHIER", labelEn: "In-Store Cashier", labelAr: "كاشير المتجر" },
    { value: "DEVELOPER", labelEn: "Developer (API)", labelAr: "مطوّر (API)" },
];

const ROLE_LABELS: Record<MerchantChapterRole, string> = {
    ALL: "All",
    MERCHANT_ADMIN: "Business Owner",
    MERCHANT_STAFF: "Manager / Accountant",
    MERCHANT_CASHIER: "In-Store Cashier",
    DEVELOPER: "Developer",
};



const CHECKLIST_STEPS: ChecklistStep[] = [
    {
        id: "kyb",
        labelEn: "Pass KYB verification",
        labelAr: "اجتز التحقق من النشاط KYB",
        routeName: "Onboarding",
        icon: "mdi-file-certificate-outline",
    },
    {
        id: "wallet",
        labelEn: "Create your first LYD wallet",
        labelAr: "أنشئ أول محفظة LYD",
        routeName: "Wallets",
        icon: "mdi-wallet-outline",
    },
    {
        id: "application",
        labelEn: "Create your first application and connect the wallet",
        labelAr: "أنشئ أول تطبيق واربط المحفظة",
        routeName: "Applications",
        icon: "mdi-apps",
    },
    {
        id: "link",
        labelEn: "Create and share a payment link",
        labelAr: "أنشئ رابط دفع وشاركه",
        routeName: "Links",
        icon: "mdi-link-variant",
    },
    {
        id: "pos-or-token",
        labelEn: "Set up a POS screen or an API token",
        labelAr: "أعد شاشة نقطة بيع أو رمز API",
        routeName: "PosTerminals",
        icon: "mdi-point-of-sale",
        altRouteName: "DeveloperTokens",
        altLabelEn: "API Token",
        altLabelAr: "رمز API",
    },
];

const WEBHOOK_CHECKS = [
    "Reject any webhook without a valid X-PG-Signature header.",
    "Recompute the signature over the raw request body and compare it in constant time.",
    "Compare amount and currency with the payment you created before fulfilling the order.",
    "Deduplicate by event id so a retried delivery cannot post twice.",
    "Return a 2xx response quickly and move slow work to a queue.",
];

const readChecklist = (): Record<string, boolean> => {
    if (typeof localStorage === "undefined") return {};
    try {
        const raw = localStorage.getItem(CHECKLIST_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const result: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (value === true) result[key] = true;
        }
        return result;
    } catch {
        return {};
    }
};

const apiBase = (): string => {
    const base = getBaseUrl();
    if (/^https?:\/\//i.test(base)) return base.replace(/\/+$/, "");
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    return `${origin}${base}`.replace(/\/+$/, "");
};

const shellQuote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";

const MerchantGuidePage = dc(() => {
    const locale = useLocale();
    const { t } = locale;
    const router = useRouter();
    const isArabic = computed(() => locale.current.value === "ar");

    const search = ref("");
    const selectedRole = ref<MerchantChapterRole>("ALL");
    const selectedChapter = ref<GuideCard | null>(null);
    const chapterOpen = ref(false);
    const checklist = ref<Record<string, boolean>>(readChecklist());
    const snippetTab = ref<DeveloperCodeLanguage>("typescript");

    const calc = ref<MerchantFeeCalculatorForm>({
        amount: "250",
        rail: "edfali",
        commission: "3",
        gatewayFee: "0.8",
        feeBearer: "MERCHANT_ABSORBS",
        platformShare: "50",
    });

    const sandbox = ref({
        applicationId: "0192d4a0-7c10-7000-8000-000000000001",
        token: "pg_live_your_token",
        title: "Order #1001",
        reference: "PAY-REF-1001",
    });

    const allCards = computed<GuideCard[]>(() => [
        ...MERCHANT_OPERATIONS_CHAPTERS.map((chapter) => ({
            id: chapter.id,
            role: chapter.role,
            titleEn: chapter.titleEn,
            titleAr: chapter.titleAr,
            bodyEn: chapter.bodyEn,
            bodyAr: chapter.bodyAr,
            tags: chapter.tags,
        })),
        ...MERCHANT_DEVELOPER_CHAPTERS.map((chapter) => ({
            id: chapter.id,
            role: "DEVELOPER" as MerchantChapterRole,
            titleEn: chapter.titleEn,
            titleAr: chapter.titleAr,
            bodyEn: chapter.bodyEn,
            bodyAr: chapter.bodyAr,
            tags: chapter.tags,
            codeTemplates: chapter.codeTemplates,
        })),
    ]);

    const chapterTitle = (chapter: GuideCard): string => (isArabic.value && chapter.titleAr ? chapter.titleAr : chapter.titleEn);
    const chapterBody = (chapter: GuideCard): string => (isArabic.value && chapter.bodyAr ? chapter.bodyAr : chapter.bodyEn);

    const filteredChapters = computed(() => {
        const query = search.value.trim().toLowerCase();
        return allCards.value.filter((chapter) => {
            const roleMatches =
                selectedRole.value === "ALL" ||
                chapter.role === "ALL" ||
                chapter.role === selectedRole.value;
            if (!roleMatches) return false;
            if (!query) return true;
            return [chapter.id, chapter.titleEn, chapter.titleAr ?? "", chapter.bodyEn, chapter.bodyAr ?? "", ...chapter.tags]
                .join(" ")
                .toLowerCase()
                .includes(query);
        });
    });

    const openChapter = (chapter: GuideCard) => {
        selectedChapter.value = chapter;
        chapterOpen.value = true;
    };

    const toggleStep = (id: string, value: boolean | null | undefined) => {
        const next = { ...checklist.value };
        if (value) next[id] = true;
        else delete next[id];
        checklist.value = next;
        try {
            localStorage.setItem(CHECKLIST_KEY, JSON.stringify(next));
        } catch {
            showSnackBar({ type: "warning", message: t("Checklist could not be saved locally") });
        }
    };

    const readItems = (payload: any, keys: string[]): any[] => {
        const source = payload?.data ?? payload ?? {};
        for (const key of keys) {
            if (Array.isArray(source?.[key])) return source[key];
        }
        if (Array.isArray(source)) return source;
        return [];
    };

    onMounted(async () => {
        const detected = { ...checklist.value };
        const results = await Promise.allSettled([
            api.get(urlsMap.onboardingJoinRequest),
            api.get(urlsMap.walletsList),
            api.get(urlsMap.applicationsList),
            api.get(urlsMap.linksList),
            api.get(urlsMap.posTerminals),
            api.get(urlsMap.tokensList),
        ]);
        const onboarding = results[0];
        if (onboarding.status === "fulfilled") {
            const payload = onboarding.value.data?.data ?? onboarding.value.data ?? {};
            const status = String(payload.status ?? payload.joinRequest?.status ?? "").toUpperCase();
            if (["APPROVED", "ACTIVE", "COMPLETED"].includes(status)) {
                detected.kyb = true;
            }
        }
        if (results[1].status === "fulfilled" && readItems(results[1].value.data, ["wallets", "rows", "items"]).length > 0) {
            detected.wallet = true;
        }
        if (results[2].status === "fulfilled" && readItems(results[2].value.data, ["applications", "rows", "items"]).length > 0) {
            detected.application = true;
        }
        if (results[3].status === "fulfilled" && readItems(results[3].value.data, ["links", "rows", "items"]).length > 0) {
            detected.link = true;
        }
        const hasPos = results[4].status === "fulfilled" && readItems(results[4].value.data, ["terminals", "rows", "items"]).length > 0;
        const hasToken = results[5].status === "fulfilled" && readItems(results[5].value.data, ["tokens", "rows", "items"]).length > 0;
        if (hasPos || hasToken) {
            detected["pos-or-token"] = true;
        }
        checklist.value = detected;
        try {
            localStorage.setItem(CHECKLIST_KEY, JSON.stringify(detected));
        } catch {
            // The checklist still works in memory when storage is unavailable.
        }
    });

    const doneCount = computed(() => CHECKLIST_STEPS.filter((step) => checklist.value[step.id] === true).length);
    const completion = computed(() => Math.round((doneCount.value / CHECKLIST_STEPS.length) * 100));
    const stepLabel = (step: ChecklistStep): string => (isArabic.value ? step.labelAr : step.labelEn);
    const altStepLabel = (step: ChecklistStep): string => (isArabic.value ? step.altLabelAr : step.altLabelEn) ?? "";

    const goTo = (name: string | undefined) => {
        if (name) void router.push({ name });
    };

    const paymentEndpoint = computed(() => `${apiBase()}/${urlsMap.externalGetPayment(sandbox.value.reference || "PAY-REF-1001")}`);

    const snippets = computed<Record<DeveloperCodeLanguage, string>>(() => {
        const token = sandbox.value.token || "pg_live_your_token";
        const applicationId = sandbox.value.applicationId || "app_xxxxxxxx";
        const amount = calc.value.amount || "250";
        const feeBearer = calc.value.feeBearer;
        const redirectUrl = `https://shop.yourcompany.ly/orders/${encodeURIComponent(sandbox.value.reference || "order-1001")}/verify`;

        const typescript = `const PG_BASE_URL = ${JSON.stringify(apiBase())};
const PG_API_TOKEN = process.env.PG_LIVE_TOKEN ?? ${JSON.stringify(token)};

export async function createCheckoutLink() {
    const response = await fetch(\`\${PG_BASE_URL}/${urlsMap.externalCreateLink}\`, {
        method: "POST",
        headers: {
            "Authorization": \`Bearer \${PG_API_TOKEN}\`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            applicationId: ${JSON.stringify(applicationId)},
            amount: ${JSON.stringify(amount)},
            currency: "LYD",
            feeBearer: ${JSON.stringify(feeBearer)},
            infiniteUse: false,
            useCount: 1,
            redirectUrl: ${JSON.stringify(redirectUrl)},
        }),
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(\`Payment Gateway Error [\${error.code}]: \${error.message}\`);
    }
    return (await response.json()) as { key: string; checkoutUrl: string; state: string };
}

export async function isLinkPaidAndConfirmed(linkKey: string): Promise<boolean> {
    const response = await fetch(\`\${PG_BASE_URL}/${urlsMap.externalGetLink("${'${encodeURIComponent(linkKey)}'}")}\`, {
        headers: { "Authorization": \`Bearer \${PG_API_TOKEN}\` },
    });
    if (!response.ok) return false;
    const link = await response.json();
    return link.state === "COMPLETED" && Number(link.confirmedCount) >= 1;
}`;

        const php = `<?php

use Illuminate\\Support\\Facades\\Http;

class PaymentGatewayClient
{
    public function createSingleUseLink(string $orderId, string $amountLyd): array
    {
        $response = Http::withToken(${JSON.stringify(token)})
            ->acceptJson()
            ->post(${JSON.stringify(`${apiBase()}/${urlsMap.externalCreateLink}`)}, [
                'applicationId' => ${JSON.stringify(applicationId)},
                'amount'        => $amountLyd, // Always a decimal string, e.g. "150.000"
                'currency'      => 'LYD',
                'feeBearer'     => ${JSON.stringify(feeBearer)},
                'infiniteUse'   => false,
                'useCount'      => 1,
                'redirectUrl'   => route('checkout.verify', ['orderId' => $orderId]),
            ]);

        $response->throw();
        return $response->json();
    }
}`;

        const python = `import os
import httpx

PG_BASE_URL = ${JSON.stringify(apiBase())}
PG_TOKEN = os.environ.get("PG_LIVE_TOKEN", ${JSON.stringify(token)})

async def create_payment_link(order_id: str, amount_lyd: str) -> dict:
    async with httpx.AsyncClient(timeout=15.0) as client:
        res = await client.post(
            f"{PG_BASE_URL}/${urlsMap.externalCreateLink}",
            headers={"Authorization": f"Bearer {PG_TOKEN}"},
            json={
                "applicationId": ${JSON.stringify(applicationId)},
                "amount": amount_lyd,
                "currency": "LYD",
                "feeBearer": ${JSON.stringify(feeBearer)},
                "infiniteUse": False,
                "useCount": 1,
                "redirectUrl": f"https://shop.yourcompany.ly/orders/{order_id}/verify",
            },
        )
        res.raise_for_status()
        return res.json()`;

        const curl = `curl -X POST ${shellQuote(`${apiBase()}/${urlsMap.externalCreateLink}`)} \\
  -H ${shellQuote(`Authorization: Bearer ${token}`)} \\
  -H 'Content-Type: application/json' \\
  -d '{
    "applicationId": ${JSON.stringify(applicationId)},
    "amount": ${JSON.stringify(amount)},
    "currency": "LYD",
    "feeBearer": ${JSON.stringify(feeBearer)},
    "infiniteUse": false,
    "useCount": 1,
    "redirectUrl": ${JSON.stringify(redirectUrl)}
  }'

curl ${shellQuote(paymentEndpoint.value)} \\
  -H ${shellQuote(`Authorization: Bearer ${token}`)}`;

        return { typescript, php, python, curl };
    });

    const webhookPayload = computed(() =>
        JSON.stringify(
            {
                event: "payment.succeeded",
                id: "evt_01J9Z8K4M2",
                reference: sandbox.value.reference || "PAY-REF-1001",
                status: "SUCCEEDED",
                amount: calc.value.amount || "250",
                currency: "LYD",
                feeBearer: calc.value.feeBearer,
            },
            null,
            2,
        ),
    );

    const copyText = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            showSnackBar({ type: "success", message: t("Copied") });
        } catch {
            showSnackBar({ type: "error", message: t("Unable to copy") });
        }
    };

    const codeStyle = {
        direction: "ltr" as const,
        textAlign: "left" as const,
        background: "rgba(100,116,139,0.12)",
        borderRadius: "10px",
        padding: "12px",
        overflowX: "auto" as const,
        fontSize: "12px",
        lineHeight: 1.6,
        margin: 0,
        whiteSpace: "pre" as const,
    };

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={isArabic.value ? "دليل التاجر التفاعلي والمطوّر" : "Merchant Interactive User & Developer Guide"} />

                <ThemedText style={{ fontSize: "14px", opacity: 0.72, maxWidth: "980px" }}>
                    {isArabic.value
                        ? "كل ما يحتاجه صاحب المتجر والمدير والكاشير والمطوّر: خطوات البدء، الرسوم، الحالات، النزاعات، وواجهة API كاملة."
                        : "Everything a business owner, manager, cashier, and developer needs: first steps, fees, statuses, disputes, and the full API reference."}
                </ThemedText>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
                            <ThemedView style={{ gap: "4px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                                    {isArabic.value ? "أول 5 خطوات للتحصيل" : "First 5 steps to get paid"}
                                </ThemedText>
                                <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                                    {isArabic.value ? "يُحفظ تقدمك على هذا الجهاز." : "Your progress is saved on this device."}
                                </ThemedText>
                            </ThemedView>
                            <ThemedView style={{ minWidth: "220px", gap: "6px" }}>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                                    <ThemedText style={{ fontSize: "13px", opacity: 0.72 }}>{isArabic.value ? "الإنجاز" : "Completion"}</ThemedText>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "14px" }}>{completion.value}%</ThemedText>
                                </ThemedView>
                                <VProgressLinear modelValue={completion.value} color="primary" height={8} rounded />
                            </ThemedView>
                        </ThemedView>
                        <ThemedView style={{ gap: "8px" }}>
                            {CHECKLIST_STEPS.map((step, index) => (
                                <ThemedView
                                    key={step.id}
                                    style={{
                                        flexDirection: "row",
                                        alignItems: "center",
                                        flexWrap: "wrap",
                                        gap: "10px",
                                        padding: "10px 12px",
                                        borderRadius: "10px",
                                        background: checklist.value[step.id] === true ? "rgba(5,150,105,0.08)" : "rgba(100,116,139,0.07)",
                                    }}
                                >
                                    <VCheckbox
                                        modelValue={checklist.value[step.id] === true}
                                        onUpdate:modelValue={(value: boolean | null) => toggleStep(step.id, value)}
                                        hideDetails
                                        density="compact"
                                        color="success"
                                        style={{ flex: "0 0 auto" }}
                                    />
                                    <VIcon icon={step.icon} size="20px" color="primary" />
                                    <ThemedText style={{ flex: "1 1 220px", fontSize: "14px" }}>{`${index + 1}. ${stepLabel(step)}`}</ThemedText>
                                    <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                        <VBtn size="small" variant="tonal" onClick={() => goTo(step.routeName)}>{isArabic.value ? "اذهب" : "Go"}</VBtn>
                                        {step.altRouteName ? (
                                            <VBtn size="small" variant="text" onClick={() => goTo(step.altRouteName)}>{altStepLabel(step)}</VBtn>
                                        ) : null}
                                    </ThemedView>
                                </ThemedView>
                            ))}
                        </ThemedView>
                    </VCardText>
                </VCard>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedView style={{ gap: "4px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>{isArabic.value ? "الفصول" : "Chapters"}</ThemedText>
                            <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                                {isArabic.value ? "ابحث بالعنوان أو الوسم أو النص ثم صفِّ حسب دورك." : "Search by title, tag, or body, then filter by your role."}
                            </ThemedText>
                        </ThemedView>
                        <VTextField
                            label={isArabic.value ? "ابحث في الفصول" : "Search chapters"}
                            modelValue={search.value}
                            onUpdate:modelValue={(value: string | null) => (search.value = value ?? "")}
                            prependInnerIcon="mdi-magnify"
                            clearable
                            hideDetails
                        />
                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "8px" }}>
                            {ROLE_FILTERS.map((role) => (
                                <VChip
                                    key={role.value}
                                    onClick={() => (selectedRole.value = role.value)}
                                    color={selectedRole.value === role.value ? "primary" : undefined}
                                    variant={selectedRole.value === role.value ? "flat" : "tonal"}
                                    style={{ cursor: "pointer", fontWeight: "700" }}
                                >
                                    {isArabic.value ? role.labelAr : role.labelEn}
                                </VChip>
                            ))}
                        </ThemedView>
                        {filteredChapters.value.length === 0 ? (
                            <StateView empty emptyTitle={isArabic.value ? "لا فصول" : "No chapters found"} emptyDescription={isArabic.value ? "جرّب كلمة أو دوراً آخر." : "Try a different keyword or role."} minHeight="180px" />
                        ) : (
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "12px" }}>
                                {filteredChapters.value.map((chapter) => (
                                    <VCard key={chapter.id} variant="outlined" style={{ cursor: "pointer" }} onClick={() => openChapter(chapter)}>
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px", height: "100%" }}>
                                            <ThemedView style={{ flexDirection: "row", alignItems: "flex-start", gap: "8px" }}>
                                                <VIcon icon="mdi-book-open-page-variant-outline" color="primary" size="20px" style={{ marginTop: "2px" }} />
                                                <ThemedText type="defaultSemiBold" style={{ fontSize: "15px", lineHeight: 1.35 }}>{chapterTitle(chapter)}</ThemedText>
                                            </ThemedView>
                                            <ThemedText style={{ fontSize: "13px", opacity: 0.72, lineHeight: 1.55, flex: 1 }}>
                                                {chapterBody(chapter).replace(/[#>*`]/g, "").replace(/\s+/g, " ").slice(0, 180)}
                                            </ThemedText>
                                            <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
                                                <StatusChip label={t(ROLE_LABELS[chapter.role])} tone={chapter.role === "ALL" ? "info" : "primary"} size="x-small" />
                                                {chapter.tags.slice(0, 3).map((tag) => (
                                                    <VChip key={`${chapter.id}-${tag}`} size="x-small" variant="text">{tag}</VChip>
                                                ))}
                                            </ThemedView>
                                        </VCardText>
                                    </VCard>
                                ))}
                            </div>
                        )}
                    </VCardText>
                </VCard>

                <MerchantFeeCalculator modelValue={calc.value} onUpdate:modelValue={(value: MerchantFeeCalculatorForm) => (calc.value = value)} />

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        <ThemedView style={{ gap: "4px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                                {isArabic.value ? "مولّد كود واجهة API" : "Developer API code generator"}
                            </ThemedText>
                            <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                                {isArabic.value
                                    ? "أدخل applicationId ورمز pg_live_ ثم انسخ كوداً جاهزاً بأربع لغات."
                                    : "Enter an applicationId and a pg_live_ bearer token, then copy ready-to-run code in four languages."}
                            </ThemedText>
                        </ThemedView>
                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "12px" }}>
                            <VTextField label={isArabic.value ? "معرّف التطبيق" : "Application ID"} modelValue={sandbox.value.applicationId} onUpdate:modelValue={(value: string) => (sandbox.value.applicationId = value)} style={{ minWidth: "280px", flex: "1 1 280px" }} />
                            <VTextField label={isArabic.value ? "رمز Bearer" : "Bearer token"} modelValue={sandbox.value.token} onUpdate:modelValue={(value: string) => (sandbox.value.token = value)} type="password" style={{ minWidth: "240px", flex: "1 1 240px" }} />
                            <VTextField label={isArabic.value ? "المرجع" : "Payment reference"} modelValue={sandbox.value.reference} onUpdate:modelValue={(value: string) => (sandbox.value.reference = value)} style={{ minWidth: "220px", flex: "1 1 220px" }} />
                        </ThemedView>
                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "12px", alignItems: "center" }}>
                            <code style={{ fontSize: "12px", direction: "ltr" }}>POST /api/v1/external/links</code>
                            <code style={{ fontSize: "12px", direction: "ltr" }}>GET /api/v1/external/links/:key</code>
                            <code style={{ fontSize: "12px", direction: "ltr" }}>GET /api/v1/external/payments/:reference</code>
                            <StatusChip label="Bearer pg_live_" tone="warning" size="x-small" />
                        </ThemedView>
                        <VTabs modelValue={snippetTab.value} onUpdate:modelValue={(value: any) => (snippetTab.value = value)} density="compact">
                            <VTab value="typescript">TypeScript / Node / Bun</VTab>
                            <VTab value="php">PHP (Laravel)</VTab>
                            <VTab value="python">Python (httpx)</VTab>
                            <VTab value="curl">cURL</VTab>
                        </VTabs>
                        <VWindow modelValue={snippetTab.value} onUpdate:modelValue={(value: any) => (snippetTab.value = value)}>
                            {(["typescript", "php", "python", "curl"] as DeveloperCodeLanguage[]).map((language) => (
                                <VWindowItem key={language} value={language}>
                                    <ThemedView style={{ gap: "8px" }}>
                                        <VBtn size="small" variant="tonal" style={{ alignSelf: "flex-end" }} onClick={() => void copyText(snippets.value[language])}>
                                            {isArabic.value ? "نسخ" : "Copy"}
                                        </VBtn>
                                        <pre style={codeStyle}>{snippets.value[language]}</pre>
                                    </ThemedView>
                                </VWindowItem>
                            ))}
                        </VWindow>
                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "16px" }}>
                            <ThemedView style={{ flex: "1 1 360px", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold">{isArabic.value ? "الـ webhook الذي تستقبله" : "Webhook you receive"}</ThemedText>
                                <pre style={codeStyle}>{`POST https://merchant.example/webhooks/payments
X-PG-Signature: t=1730000000,v1=9f2c...
Content-Type: application/json

${webhookPayload.value}`}</pre>
                            </ThemedView>
                            <ThemedView style={{ flex: "1 1 320px", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold">{isArabic.value ? "تحقق من كل استدعاء" : "Verify every callback"}</ThemedText>
                                {WEBHOOK_CHECKS.map((check) => (
                                    <ThemedView key={check} style={{ flexDirection: "row", gap: "8px", alignItems: "flex-start" }}>
                                        <VIcon icon="mdi-check-circle-outline" color="success" size="18px" style={{ marginTop: "2px" }} />
                                        <ThemedText style={{ fontSize: "13px", lineHeight: 1.55, opacity: 0.78 }}>{check}</ThemedText>
                                    </ThemedView>
                                ))}
                            </ThemedView>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </ThemedView>

            <VDialog modelValue={chapterOpen.value} onUpdate:modelValue={(value: boolean) => (chapterOpen.value = value)} maxWidth="860px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedView style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "20px", lineHeight: 1.35 }}>
                                {selectedChapter.value ? chapterTitle(selectedChapter.value) : ""}
                            </ThemedText>
                            <VBtn icon variant="text" size="small" onClick={() => (chapterOpen.value = false)}>
                                <VIcon icon="mdi-close" />
                            </VBtn>
                        </ThemedView>
                        {selectedChapter.value ? (
                            <>
                                <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: "6px" }}>
                                    <StatusChip label={t(ROLE_LABELS[selectedChapter.value.role])} tone={selectedChapter.value.role === "ALL" ? "info" : "primary"} size="x-small" />
                                    {selectedChapter.value.tags.map((tag) => (
                                        <VChip key={`${selectedChapter.value?.id}-dialog-${tag}`} size="x-small" variant="tonal">{tag}</VChip>
                                    ))}
                                </ThemedView>
                                <GuideMarkdown source={chapterBody(selectedChapter.value)} />
                                {selectedChapter.value.codeTemplates ? (
                                    <ThemedView style={{ gap: "8px" }}>
                                        <ThemedText type="defaultSemiBold">{isArabic.value ? "قوالب الكود" : "Code templates"}</ThemedText>
                                        <VTabs modelValue={snippetTab.value} onUpdate:modelValue={(value: any) => (snippetTab.value = value)} density="compact">
                                            <VTab value="typescript">TypeScript</VTab>
                                            <VTab value="php">PHP</VTab>
                                            <VTab value="python">Python</VTab>
                                            <VTab value="curl">cURL</VTab>
                                        </VTabs>
                                        <VWindow modelValue={snippetTab.value} onUpdate:modelValue={(value: any) => (snippetTab.value = value)}>
                                            {(["typescript", "php", "python", "curl"] as DeveloperCodeLanguage[]).map((language) => (
                                                <VWindowItem key={`dialog-${language}`} value={language}>
                                                    <pre style={codeStyle}>{selectedChapter.value?.codeTemplates?.[language] ?? ""}</pre>
                                                </VWindowItem>
                                            ))}
                                        </VWindow>
                                    </ThemedView>
                                ) : null}
                            </>
                        ) : null}
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default MerchantGuidePage;
