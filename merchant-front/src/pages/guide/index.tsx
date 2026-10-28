import { dc } from "kt-dc";
import { computed, ref } from "vue";
import type Decimal from "decimal.js";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import {
    VBtn,
    VBtnToggle,
    VCard,
    VCardText,
    VCheckbox,
    VChip,
    VDialog,
    VIcon,
    VProgressLinear,
    VSelect,
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
import { MoneyText } from "@/components/MoneyText";
import { GUIDE_CHAPTERS, type ChapterRole, type GuideChapter } from "@/components/guide/chapters";
import { urlsMap } from "@/constants/urlsMap";
import { getBaseUrl } from "@/constants/baseUrl";
import { showSnackBar } from "@/utils/snackBar";
import { toDecimal } from "@/utils/money";

type FeeBearer = "MERCHANT_ABSORBS" | "PAYER_SURCHARGE" | "SPLIT";

type CalculatorForm = {
    amount: string;
    rail: string;
    commission: string;
    gatewayFee: string;
    feeBearer: FeeBearer;
    platformShare: string;
};

type FeeResult = {
    customerTotal: Decimal;
    commission: Decimal;
    gatewayFee: Decimal;
    netToWallet: Decimal;
    payerShare: Decimal;
};

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

type SnippetTab = "curl" | "javascript" | "php" | "python";

const CHECKLIST_KEY = "merchant-guide-checklist";

const ROLE_FILTERS: { value: ChapterRole; labelEn: string }[] = [
    { value: "ALL", labelEn: "All" },
    { value: "MERCHANT_ADMIN", labelEn: "Business Owner" },
    { value: "MERCHANT_STAFF", labelEn: "Store Staff" },
    { value: "MERCHANT_CASHIER", labelEn: "POS Cashier" },
    { value: "DEVELOPER", labelEn: "Developer" },
];

const ROLE_LABELS: Record<ChapterRole, string> = {
    ALL: "All",
    MERCHANT_ADMIN: "Business Owner",
    MERCHANT_STAFF: "Store Staff",
    MERCHANT_CASHIER: "POS Cashier",
    DEVELOPER: "Developer",
};

const RAIL_CODES = [
    "edfali",
    "sadad",
    "moamalat_card",
    "cbl_lypay",
    "lypay",
    "mypay",
    "tlync",
    "mobicash",
    "onepay",
    "yussor",
    "sahara",
    "mpgs",
    "evo_pay",
    "neompay_wallet",
];

const CHECKLIST_STEPS: ChecklistStep[] = [
    {
        id: "wallet",
        labelEn: "Create a wallet",
        labelAr: "أنشئ محفظة",
        routeName: "Wallets",
        icon: "mdi-wallet-outline",
    },
    {
        id: "application",
        labelEn: "Create an application and link the wallet",
        labelAr: "أنشئ تطبيقاً واربط المحفظة",
        routeName: "Applications",
        icon: "mdi-apps",
    },
    {
        id: "preview",
        labelEn: "Review the commission / fee-bearer preview",
        labelAr: "راجع معاينة العمولة وطرف التحمل",
        routeName: "Applications",
        icon: "mdi-calculator-variant-outline",
    },
    {
        id: "link",
        labelEn: "Create your first payment link",
        labelAr: "أنشئ أول رابط دفع",
        routeName: "Links",
        icon: "mdi-link-variant",
    },
    {
        id: "pos-or-token",
        labelEn: "Pair a POS screen or generate an API token",
        labelAr: "اربط شاشة نقطة بيع أو أنشئ رمز API",
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
    if (typeof localStorage === "undefined") {
        return {};
    }
    try {
        const raw = localStorage.getItem(CHECKLIST_KEY);
        if (!raw) {
            return {};
        }
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {};
        }
        const result: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (value === true) {
                result[key] = true;
            }
        }
        return result;
    } catch {
        return {};
    }
};

const apiBase = (): string => {
    const base = getBaseUrl();
    if (/^https?:\/\//i.test(base)) {
        return base.replace(/\/+$/, "");
    }
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    return `${origin}${base}`.replace(/\/+$/, "");
};

const shellQuote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";

const phpQuote = (value: string): string =>
    "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

const indentBlock = (text: string, spaces: number): string =>
    text
        .split("\n")
        .map((line, index) => (index === 0 ? line : " ".repeat(spaces) + line))
        .join("\n");

const MerchantGuidePage = dc(() => {
    const locale = useLocale();
    const { t } = locale;
    const router = useRouter();

    const isArabic = computed(() => locale.current.value === "ar");

    const search = ref("");
    const selectedRole = ref<ChapterRole>("ALL");
    const selectedChapter = ref<GuideChapter | null>(null);
    const chapterOpen = ref(false);

    const checklist = ref<Record<string, boolean>>(readChecklist());

    const calc = ref<CalculatorForm>({
        amount: "250",
        rail: "edfali",
        commission: "3",
        gatewayFee: "0.8",
        feeBearer: "MERCHANT_ABSORBS",
        platformShare: "50",
    });

    const sandbox = ref({
        applicationId: "",
        token: "pg_live_your_token",
        title: "Order #1001",
        reference: "PAY-REF-1001",
    });

    const snippetTab = ref<SnippetTab>("curl");

    const chapterTitle = (chapter: GuideChapter): string =>
        isArabic.value ? chapter.titleAr : chapter.titleEn;

    const chapterBody = (chapter: GuideChapter): string =>
        isArabic.value ? chapter.bodyAr : chapter.bodyEn;

    const chapterPreview = (chapter: GuideChapter): string => {
        const firstLine = chapterBody(chapter).split("\n")[0] ?? "";
        return firstLine.length > 150 ? `${firstLine.slice(0, 147)}...` : firstLine;
    };

    const filteredChapters = computed(() => {
        const query = search.value.trim().toLowerCase();
        return GUIDE_CHAPTERS.filter((chapter) => {
            const roleMatches =
                selectedRole.value === "ALL" ||
                chapter.role === "ALL" ||
                chapter.role === selectedRole.value;
            if (!roleMatches) {
                return false;
            }
            if (!query) {
                return true;
            }
            const haystack = [
                chapter.titleEn,
                chapter.titleAr,
                chapter.bodyEn,
                chapter.bodyAr,
                ...chapter.tags,
            ]
                .join(" ")
                .toLowerCase();
            return haystack.includes(query);
        });
    });

    const openChapter = (chapter: GuideChapter) => {
        selectedChapter.value = chapter;
        chapterOpen.value = true;
    };

    const toggleStep = (id: string, value: boolean | null | undefined) => {
        const next = { ...checklist.value };
        if (value) {
            next[id] = true;
        } else {
            delete next[id];
        }
        checklist.value = next;
        try {
            localStorage.setItem(CHECKLIST_KEY, JSON.stringify(next));
        } catch {
            showSnackBar({ type: "warning", message: t("Checklist could not be saved locally") });
        }
    };

    const doneCount = computed(
        () => CHECKLIST_STEPS.filter((step) => checklist.value[step.id] === true).length,
    );
    const completion = computed(() =>
        Math.round((doneCount.value / CHECKLIST_STEPS.length) * 100),
    );

    const stepLabel = (step: ChecklistStep): string =>
        isArabic.value ? step.labelAr : step.labelEn;
    const altStepLabel = (step: ChecklistStep): string =>
        (isArabic.value ? step.altLabelAr : step.altLabelEn) ?? "";

    const goTo = (name: string | undefined) => {
        if (!name) {
            return;
        }
        void router.push({ name });
    };

    const feeResult = computed<FeeResult>(() => {
        const amount = toDecimal(calc.value.amount);
        const commission = amount.times(toDecimal(calc.value.commission)).dividedBy(100);
        let customerTotal = amount;
        let netToWallet = amount;
        let payerShare = toDecimal(0);

        if (calc.value.feeBearer === "MERCHANT_ABSORBS") {
            customerTotal = amount;
            netToWallet = amount.minus(commission);
        } else if (calc.value.feeBearer === "PAYER_SURCHARGE") {
            payerShare = commission;
            customerTotal = amount.plus(commission);
            netToWallet = amount;
        } else {
            payerShare = commission.times(toDecimal(calc.value.platformShare)).dividedBy(100);
            customerTotal = amount.plus(payerShare);
            netToWallet = amount.minus(commission.minus(payerShare));
        }

        const gatewayFee = customerTotal.times(toDecimal(calc.value.gatewayFee)).dividedBy(100);

        return {
            customerTotal,
            commission,
            gatewayFee,
            netToWallet,
            payerShare,
        };
    });

    const feeRows = computed<{ label: string; value: Decimal }[]>(() => {
        const result = feeResult.value;
        const rows: { label: string; value: Decimal }[] = [
            { label: "Customer pays", value: result.customerTotal },
            { label: "Platform commission", value: result.commission },
            { label: "Gateway fee (estimated)", value: result.gatewayFee },
            { label: "Net to wallet", value: result.netToWallet },
        ];
        if (calc.value.feeBearer === "SPLIT") {
            rows.splice(1, 0, { label: "Payer share (surcharge)", value: result.payerShare });
        }
        return rows;
    });

    const createEndpoint = computed(() => `${apiBase()}/${urlsMap.externalCreateLink}`);
    const paymentEndpoint = computed(
        () =>
            `${apiBase()}/${urlsMap.externalGetPayment(
                sandbox.value.reference || "PAY-REF-1001",
            )}`,
    );

    const sandboxBody = computed<Record<string, unknown>>(() => ({
        title: sandbox.value.title || "Order #1001",
        amount: calc.value.amount || "250",
        currency: "LYD",
        feeBearer: calc.value.feeBearer,
        applicationId: sandbox.value.applicationId || "app_xxxxxxxx",
        allowedRails: [calc.value.rail],
        metadata: {
            orderId: sandbox.value.reference || "order-1001",
        },
    }));

    const snippets = computed<Record<SnippetTab, string>>(() => {
        const token = sandbox.value.token || "pg_live_your_token";
        const createUrl = createEndpoint.value;
        const paymentUrl = paymentEndpoint.value;
        const body = sandboxBody.value;
        const bodyJson = JSON.stringify(body, null, 2);

        const curl = `curl -X POST ${shellQuote(createUrl)} \\
  -H ${shellQuote(`Authorization: Bearer ${token}`)} \\
  -H 'Content-Type: application/json' \\
  -d ${shellQuote(bodyJson)}

curl ${shellQuote(paymentUrl)} \\
  -H ${shellQuote(`Authorization: Bearer ${token}`)}`;

        const javascript = `const token = ${JSON.stringify(token)};

const createResponse = await fetch(${JSON.stringify(createUrl)}, {
    method: "POST",
    headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
    },
    body: JSON.stringify(${indentBlock(JSON.stringify(body, null, 4), 4)}),
});
const created = await createResponse.json();

const paymentResponse = await fetch(${JSON.stringify(paymentUrl)}, {
    headers: { Authorization: "Bearer " + token },
});
const payment = await paymentResponse.json();

console.log({ created, payment });`;

        const phpBody = [
            "[",
            "        'title' => " + phpQuote(String(body.title ?? "")),
            "        'amount' => " + phpQuote(String(body.amount ?? "")),
            "        'currency' => " + phpQuote(String(body.currency ?? "")),
            "        'feeBearer' => " + phpQuote(String(body.feeBearer ?? "")),
            "        'applicationId' => " + phpQuote(String(body.applicationId ?? "")),
            "        'allowedRails' => [" + phpQuote(calc.value.rail) + "],",
            "        'metadata' => ['orderId' => " +
                phpQuote(String(sandbox.value.reference || "order-1001")) +
                "],",
            "    ]",
        ].join("\n");

        const php = `<?php

use Illuminate\\Support\\Facades\\Http;

$create = Http::withToken(${phpQuote(token)})
    ->acceptJson()
    ->post(${phpQuote(createUrl)}, ${phpBody});

$payment = Http::withToken(${phpQuote(token)})
    ->acceptJson()
    ->get(${phpQuote(paymentUrl)});

return [$create->json(), $payment->json()];`;

        const python = `import requests

token = ${JSON.stringify(token)}
headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}

created = requests.post(
    ${JSON.stringify(createUrl)},
    headers=headers,
    json=${indentBlock(JSON.stringify(body, null, 4), 4)},
    timeout=30,
)
print(created.status_code, created.json())

payment = requests.get(
    ${JSON.stringify(paymentUrl)},
    headers=headers,
    timeout=30,
)
print(payment.status_code, payment.json())`;

        return { curl, javascript, php, python };
    });

    const webhookPayload = computed(() =>
        JSON.stringify(
            {
                event: "payment.succeeded",
                id: "evt_01J9Z8K4M2",
                reference: sandbox.value.reference || "PAY-REF-1001",
                status: "CONFIRMED",
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
                <PageHeader title={t("Merchant Interactive User & Developer Guide")} />

                <ThemedText style={{ fontSize: "14px", opacity: 0.72, maxWidth: "900px" }}>
                    {t(
                        "Search the chapters, follow the first-five-steps checklist, preview fees and build an API request without leaving the portal.",
                    )}
                </ThemedText>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedView
                            style={{
                                flexDirection: "row",
                                flexWrap: "wrap",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: "12px",
                            }}
                        >
                            <ThemedView style={{ gap: "4px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                                    {t("First 5 steps")}
                                </ThemedText>
                                <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                                    {t("Your progress is saved on this device.")}
                                </ThemedText>
                            </ThemedView>
                            <ThemedView style={{ minWidth: "220px", gap: "6px" }}>
                                <ThemedView
                                    style={{
                                        flexDirection: "row",
                                        justifyContent: "space-between",
                                        alignItems: "center",
                                    }}
                                >
                                    <ThemedText style={{ fontSize: "13px", opacity: 0.72 }}>
                                        {t("Completion")}
                                    </ThemedText>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "14px" }}>
                                        {completion.value}%
                                    </ThemedText>
                                </ThemedView>
                                <VProgressLinear
                                    modelValue={completion.value}
                                    color="primary"
                                    height={8}
                                    rounded
                                />
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
                                        background:
                                            checklist.value[step.id] === true
                                                ? "rgba(5,150,105,0.08)"
                                                : "rgba(100,116,139,0.07)",
                                    }}
                                >
                                    <VCheckbox
                                        modelValue={checklist.value[step.id] === true}
                                        onUpdate:modelValue={(value: boolean | null) =>
                                            toggleStep(step.id, value)
                                        }
                                        hideDetails
                                        density="compact"
                                        color="success"
                                        style={{ flex: "0 0 auto" }}
                                    />
                                    <VIcon icon={step.icon} size={"20px"} color="primary" />
                                    <ThemedText style={{ flex: "1 1 220px", fontSize: "14px" }}>
                                        {index + 1}. {stepLabel(step)}
                                    </ThemedText>
                                    <ThemedView
                                        style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}
                                    >
                                        <VBtn
                                            size="small"
                                            variant="tonal"
                                            onClick={() => goTo(step.routeName)}
                                        >
                                            {t("Go")}
                                        </VBtn>
                                        {step.altRouteName ? (
                                            <VBtn
                                                size="small"
                                                variant="text"
                                                onClick={() => goTo(step.altRouteName)}
                                            >
                                                {altStepLabel(step)}
                                            </VBtn>
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
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                                {t("Chapters")}
                            </ThemedText>
                            <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                                {t("Search by title, tag or body, then filter by your role.")}
                            </ThemedText>
                        </ThemedView>

                        <VTextField
                            label={t("Search chapters")}
                            modelValue={search.value}
                            onUpdate:modelValue={(value: string | null) =>
                                (search.value = value ?? "")
                            }
                            prependInnerIcon="mdi-magnify"
                            clearable
                            hideDetails
                        />

                        <ThemedView
                            style={{ flexDirection: "row", flexWrap: "wrap", gap: "8px" }}
                        >
                            {ROLE_FILTERS.map((role) => (
                                <VChip
                                    key={role.value}
                                    onClick={() => (selectedRole.value = role.value)}
                                    color={selectedRole.value === role.value ? "primary" : undefined}
                                    variant={selectedRole.value === role.value ? "flat" : "tonal"}
                                    style={{ cursor: "pointer", fontWeight: "700" }}
                                >
                                    {t(role.labelEn)}
                                </VChip>
                            ))}
                        </ThemedView>

                        {filteredChapters.value.length === 0 ? (
                            <StateView
                                empty
                                emptyTitle="No chapters found"
                                emptyDescription="Try a different keyword or role."
                                minHeight="180px"
                            />
                        ) : (
                            <div
                                style={{
                                    display: "grid",
                                    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                                    gap: "12px",
                                }}
                            >
                                {filteredChapters.value.map((chapter) => (
                                    <VCard
                                        key={chapter.id}
                                        variant="outlined"
                                        style={{ cursor: "pointer" }}
                                        onClick={() => openChapter(chapter)}
                                    >
                                        <VCardText
                                            style={{
                                                display: "flex",
                                                flexDirection: "column",
                                                gap: "10px",
                                                height: "100%",
                                            }}
                                        >
                                            <ThemedView
                                                style={{
                                                    flexDirection: "row",
                                                    alignItems: "flex-start",
                                                    gap: "8px",
                                                }}
                                            >
                                                <VIcon
                                                    icon="mdi-book-open-page-variant-outline"
                                                    color="primary"
                                                    size={"20px"}
                                                    style={{ marginTop: "2px" }}
                                                />
                                                <ThemedText
                                                    type="defaultSemiBold"
                                                    style={{ fontSize: "15px", lineHeight: 1.35 }}
                                                >
                                                    {chapterTitle(chapter)}
                                                </ThemedText>
                                            </ThemedView>
                                            <ThemedText
                                                style={{
                                                    fontSize: "13px",
                                                    opacity: 0.72,
                                                    lineHeight: 1.55,
                                                    flex: 1,
                                                }}
                                            >
                                                {chapterPreview(chapter)}
                                            </ThemedText>
                                            <ThemedView
                                                style={{
                                                    flexDirection: "row",
                                                    flexWrap: "wrap",
                                                    gap: "6px",
                                                    alignItems: "center",
                                                }}
                                            >
                                                <StatusChip
                                                    label={t(ROLE_LABELS[chapter.role])}
                                                    tone={chapter.role === "ALL" ? "info" : "primary"}
                                                    size="x-small"
                                                />
                                                {chapter.tags.slice(0, 3).map((tag) => (
                                                    <VChip
                                                        key={`${chapter.id}-${tag}`}
                                                        size="x-small"
                                                        variant="text"
                                                    >
                                                        {tag}
                                                    </VChip>
                                                ))}
                                            </ThemedView>
                                        </VCardText>
                                    </VCard>
                                ))}
                            </div>
                        )}
                    </VCardText>
                </VCard>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        <ThemedView style={{ gap: "4px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                                {t("Fee & net settlement calculator")}
                            </ThemedText>
                            <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                                {t(
                                    "The same fee-bearer model used by checkout, calculated with decimal.js.",
                                )}
                            </ThemedText>
                        </ThemedView>

                        <ThemedView
                            style={{ flexDirection: "row", flexWrap: "wrap", gap: "12px" }}
                        >
                            <VTextField
                                label={t("Amount")}
                                type="number"
                                modelValue={calc.value.amount}
                                onUpdate:modelValue={(value: string) => (calc.value.amount = value)}
                                suffix="LYD"
                                style={{ minWidth: "170px", flex: "1 1 170px" }}
                            />
                            <VSelect
                                label={t("Rail")}
                                items={RAIL_CODES.map((code) => ({ title: code, value: code }))}
                                modelValue={calc.value.rail}
                                onUpdate:modelValue={(value: string) => (calc.value.rail = value)}
                                style={{ minWidth: "190px", flex: "1 1 190px" }}
                            />
                            <VTextField
                                label={t("Commission")}
                                type="number"
                                modelValue={calc.value.commission}
                                onUpdate:modelValue={(value: string) =>
                                    (calc.value.commission = value)
                                }
                                suffix="%"
                                style={{ minWidth: "150px", flex: "1 1 150px" }}
                            />
                            <VTextField
                                label={t("Gateway fee")}
                                type="number"
                                modelValue={calc.value.gatewayFee}
                                onUpdate:modelValue={(value: string) =>
                                    (calc.value.gatewayFee = value)
                                }
                                suffix="%"
                                style={{ minWidth: "150px", flex: "1 1 150px" }}
                            />
                            {calc.value.feeBearer === "SPLIT" && (
                                <VTextField
                                    label={t("Platform share")}
                                    type="number"
                                    modelValue={calc.value.platformShare}
                                    onUpdate:modelValue={(value: string) =>
                                        (calc.value.platformShare = value)
                                    }
                                    suffix="%"
                                    style={{ minWidth: "150px", flex: "1 1 150px" }}
                                />
                            )}
                        </ThemedView>

                        <ThemedView style={{ gap: "8px" }}>
                            <ThemedText style={{ fontSize: "13px", opacity: 0.72 }}>
                                {t("Fee bearer")}
                            </ThemedText>
                            <VBtnToggle
                                mandatory
                                divided
                                modelValue={calc.value.feeBearer}
                                onUpdate:modelValue={(value: FeeBearer | null) => {
                                    if (value) {
                                        calc.value.feeBearer = value;
                                    }
                                }}
                                style={{ maxWidth: "700px" }}
                            >
                                <VBtn value="MERCHANT_ABSORBS" size="small">
                                    {t("Merchant absorbs")}
                                </VBtn>
                                <VBtn value="PAYER_SURCHARGE" size="small">
                                    {t("Payer surcharge")}
                                </VBtn>
                                <VBtn value="SPLIT" size="small">
                                    {t("Split")}
                                </VBtn>
                            </VBtnToggle>
                        </ThemedView>

                        <div style={{ overflowX: "auto", maxWidth: "760px" }}>
                            <table
                                style={{
                                    width: "100%",
                                    borderCollapse: "collapse",
                                    fontSize: "14px",
                                }}
                            >
                                <tbody>
                                    {feeRows.value.map((row) => (
                                        <tr
                                            key={row.label}
                                            style={{
                                                borderBottom: "1px solid rgba(100,116,139,0.18)",
                                            }}
                                        >
                                            <td style={{ padding: "9px 6px", opacity: 0.74 }}>
                                                {t(row.label)}
                                            </td>
                                            <td
                                                style={{
                                                    padding: "9px 6px",
                                                    textAlign: "end",
                                                    direction: "ltr",
                                                }}
                                            >
                                                <MoneyText value={row.value} currency="LYD" bold />
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <ThemedText style={{ fontSize: "12px", opacity: 0.6, maxWidth: "760px" }}>
                            {t(
                                "Gateway fee is estimated on the customer total for this rail and is shown for transparency; the wallet credit follows the selected fee-bearer formula.",
                            )}
                        </ThemedText>
                    </VCardText>
                </VCard>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        <ThemedView style={{ gap: "4px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                                {t("Developer API & webhook sandbox")}
                            </ThemedText>
                            <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                                {t(
                                    "Use a pg_live_ bearer token and an application id to create a link or read a payment.",
                                )}
                            </ThemedText>
                        </ThemedView>

                        <ThemedView
                            style={{
                                flexDirection: "row",
                                flexWrap: "wrap",
                                gap: "12px",
                                alignItems: "center",
                            }}
                        >
                            <code style={{ fontSize: "12px", direction: "ltr" }}>
                                POST /api/v1/external/links
                            </code>
                            <code style={{ fontSize: "12px", direction: "ltr" }}>
                                GET /api/v1/external/payments/:reference
                            </code>
                            <StatusChip label="Bearer pg_live_" tone="warning" size="x-small" />
                        </ThemedView>

                        <ThemedView
                            style={{ flexDirection: "row", flexWrap: "wrap", gap: "12px" }}
                        >
                            <VTextField
                                label={t("Application ID")}
                                modelValue={sandbox.value.applicationId}
                                onUpdate:modelValue={(value: string) =>
                                    (sandbox.value.applicationId = value)
                                }
                                placeholder="app_xxxxxxxx"
                                style={{ minWidth: "240px", flex: "1 1 240px" }}
                            />
                            <VTextField
                                label={t("Bearer token")}
                                modelValue={sandbox.value.token}
                                onUpdate:modelValue={(value: string) =>
                                    (sandbox.value.token = value)
                                }
                                placeholder="pg_live_..."
                                style={{ minWidth: "240px", flex: "1 1 240px" }}
                            />
                            <VTextField
                                label={t("Link title")}
                                modelValue={sandbox.value.title}
                                onUpdate:modelValue={(value: string) =>
                                    (sandbox.value.title = value)
                                }
                                style={{ minWidth: "200px", flex: "1 1 200px" }}
                            />
                            <VTextField
                                label={t("Payment reference")}
                                modelValue={sandbox.value.reference}
                                onUpdate:modelValue={(value: string) =>
                                    (sandbox.value.reference = value)
                                }
                                style={{ minWidth: "220px", flex: "1 1 220px" }}
                            />
                        </ThemedView>

                        <ThemedText style={{ fontSize: "12px", opacity: 0.64, direction: "ltr" }}>
                            POST {createEndpoint.value}
                        </ThemedText>
                        <ThemedText style={{ fontSize: "12px", opacity: 0.64, direction: "ltr" }}>
                            GET {paymentEndpoint.value}
                        </ThemedText>

                        <VTabs v-model={snippetTab.value} density="compact">
                            <VTab value="curl">cURL</VTab>
                            <VTab value="javascript">JavaScript / TypeScript</VTab>
                            <VTab value="php">PHP (Laravel Http)</VTab>
                            <VTab value="python">Python (requests)</VTab>
                        </VTabs>

                        <VWindow v-model={snippetTab.value}>
                            <VWindowItem value="curl">
                                <ThemedView style={{ gap: "8px" }}>
                                    <VBtn
                                        size="small"
                                        variant="tonal"
                                        style={{ alignSelf: "flex-end" }}
                                        onClick={() => void copyText(snippets.value.curl)}
                                    >
                                        {t("Copy")}
                                    </VBtn>
                                    <pre style={codeStyle}>{snippets.value.curl}</pre>
                                </ThemedView>
                            </VWindowItem>
                            <VWindowItem value="javascript">
                                <ThemedView style={{ gap: "8px" }}>
                                    <VBtn
                                        size="small"
                                        variant="tonal"
                                        style={{ alignSelf: "flex-end" }}
                                        onClick={() => void copyText(snippets.value.javascript)}
                                    >
                                        {t("Copy")}
                                    </VBtn>
                                    <pre style={codeStyle}>{snippets.value.javascript}</pre>
                                </ThemedView>
                            </VWindowItem>
                            <VWindowItem value="php">
                                <ThemedView style={{ gap: "8px" }}>
                                    <VBtn
                                        size="small"
                                        variant="tonal"
                                        style={{ alignSelf: "flex-end" }}
                                        onClick={() => void copyText(snippets.value.php)}
                                    >
                                        {t("Copy")}
                                    </VBtn>
                                    <pre style={codeStyle}>{snippets.value.php}</pre>
                                </ThemedView>
                            </VWindowItem>
                            <VWindowItem value="python">
                                <ThemedView style={{ gap: "8px" }}>
                                    <VBtn
                                        size="small"
                                        variant="tonal"
                                        style={{ alignSelf: "flex-end" }}
                                        onClick={() => void copyText(snippets.value.python)}
                                    >
                                        {t("Copy")}
                                    </VBtn>
                                    <pre style={codeStyle}>{snippets.value.python}</pre>
                                </ThemedView>
                            </VWindowItem>
                        </VWindow>

                        <ThemedView
                            style={{ flexDirection: "row", flexWrap: "wrap", gap: "16px" }}
                        >
                            <ThemedView style={{ flex: "1 1 360px", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold">
                                    {t("Webhook you receive")}
                                </ThemedText>
                                <pre style={codeStyle}>
                                    {`POST https://merchant.example/webhooks/payments
X-PG-Signature: t=1730000000,v1=9f2c...
Content-Type: application/json

${webhookPayload.value}`}
                                </pre>
                            </ThemedView>
                            <ThemedView style={{ flex: "1 1 320px", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold">
                                    {t("Verify every callback")}
                                </ThemedText>
                                {WEBHOOK_CHECKS.map((check) => (
                                    <ThemedView
                                        key={check}
                                        style={{
                                            flexDirection: "row",
                                            gap: "8px",
                                            alignItems: "flex-start",
                                        }}
                                    >
                                        <VIcon
                                            icon="mdi-check-circle-outline"
                                            color="success"
                                            size={"18px"}
                                            style={{ marginTop: "2px" }}
                                        />
                                        <ThemedText
                                            style={{
                                                fontSize: "13px",
                                                lineHeight: 1.55,
                                                opacity: 0.78,
                                            }}
                                        >
                                            {t(check)}
                                        </ThemedText>
                                    </ThemedView>
                                ))}
                            </ThemedView>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </ThemedView>

            <VDialog v-model={chapterOpen.value} maxWidth="760px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedView
                            style={{
                                flexDirection: "row",
                                alignItems: "flex-start",
                                justifyContent: "space-between",
                                gap: "12px",
                            }}
                        >
                            <ThemedText
                                type="defaultSemiBold"
                                style={{ fontSize: "20px", lineHeight: 1.35 }}
                            >
                                {selectedChapter.value ? chapterTitle(selectedChapter.value) : ""}
                            </ThemedText>
                            <VBtn
                                icon
                                variant="text"
                                size="small"
                                onClick={() => (chapterOpen.value = false)}
                            >
                                <VIcon icon="mdi-close" />
                            </VBtn>
                        </ThemedView>

                        {selectedChapter.value ? (
                            <>
                                <ThemedView
                                    style={{
                                        flexDirection: "row",
                                        flexWrap: "wrap",
                                        alignItems: "center",
                                        gap: "6px",
                                    }}
                                >
                                    <StatusChip
                                        label={t(ROLE_LABELS[selectedChapter.value.role])}
                                        tone={
                                            selectedChapter.value.role === "ALL"
                                                ? "info"
                                                : "primary"
                                        }
                                        size="x-small"
                                    />
                                    {selectedChapter.value.tags.map((tag) => (
                                        <VChip
                                            key={`${selectedChapter.value?.id}-dialog-${tag}`}
                                            size="x-small"
                                            variant="tonal"
                                        >
                                            {tag}
                                        </VChip>
                                    ))}
                                </ThemedView>
                                <ThemedText
                                    style={{
                                        whiteSpace: "pre-line",
                                        lineHeight: 1.8,
                                        fontSize: "14px",
                                    }}
                                >
                                    {chapterBody(selectedChapter.value)}
                                </ThemedText>
                            </>
                        ) : null}
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default MerchantGuidePage;
