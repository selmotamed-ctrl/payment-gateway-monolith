import { dc } from "kt-dc";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import {
    VAlert,
    VBtn,
    VCard,
    VCardText,
    VCheckbox,
    VChip,
    VDivider,
    VIcon,
    VSwitch,
    VTextField,
    VTextarea,
} from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type FaqItem = {
    q_ar: string;
    a_ar: string;
    q_en: string;
    a_en: string;
};

const CHECKOUT_EDIT_CHECKS = [
    { key: "SUPPORT_CHANNELS_VERIFIED", en: "Support channels verified", ar: "تم التحقق من قنوات الدعم" },
    { key: "FAQ_CONTENT_REVIEWED", en: "FAQ content reviewed", ar: "تمت مراجعة محتوى الأسئلة الشائعة" },
    { key: "WORKING_HOURS_VERIFIED", en: "Working hours verified", ar: "تم التحقق من ساعات العمل" },
    { key: "PAYER_VISIBILITY_REVIEWED", en: "Payer visibility reviewed", ar: "تمت مراجعة ظهور الدافعين" },
] as const;

type CheckoutSupportConfig = {
    enabled: boolean;
    show_platform_contact: boolean;
    show_merchant_contact: boolean;
    support_phone: string | null;
    support_whatsapp: string | null;
    support_email: string | null;
    working_hours_ar: string | null;
    working_hours_en: string | null;
    faq_items: Array<{
        q_ar: string | null;
        a_ar: string | null;
        q_en: string | null;
        a_en: string | null;
    }> | null;
};

type CheckoutSupportResponse = {
    key: string;
    value: CheckoutSupportConfig | null;
    version: number | null;
    updatedAt?: string | null;
};

type CheckoutSupportForm = {
    enabled: boolean;
    show_platform_contact: boolean;
    show_merchant_contact: boolean;
    support_phone: string;
    support_whatsapp: string;
    support_email: string;
    working_hours_ar: string;
    working_hours_en: string;
    faq_items: FaqItem[];
};

const emptyForm = (): CheckoutSupportForm => ({
    enabled: false,
    show_platform_contact: true,
    show_merchant_contact: true,
    support_phone: "",
    support_whatsapp: "",
    support_email: "",
    working_hours_ar: "",
    working_hours_en: "",
    faq_items: [],
});

const trimmed = (value: string | null | undefined): string =>
    typeof value === "string" ? value.trim() : "";

const digitsOnly = (value: string): string => value.replace(/[^\d]/g, "");

type DiffRow = { path: string; before: string; after: string; kind: "ADDED" | "REMOVED" | "CHANGED" };

type CheckoutSupportSummary = {
    enabled: boolean;
    showPlatformContact: boolean;
    showMerchantContact: boolean;
    faqItems: number;
    channels: string[];
    channelCount: number;
    versions: number;
    currentVersion: number;
    updatedAt: string | null;
    effectiveFrom: string | null;
    futureEffective: boolean;
};

const flattenJson = (value: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        out[prefix || "(root)"] = typeof value === "string" ? value : JSON.stringify(value);
        return out;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
            flattenJson(entry, path, out);
        } else {
            out[path] = typeof entry === "string" ? entry : JSON.stringify(entry);
        }
    }
    return out;
};

const AdminCheckoutHelpPage = dc(() => {
    const { t, current } = useLocale();
    const showChecklists = areChecklistsVisible();

    const form = ref<CheckoutSupportForm>(emptyForm());
    const version = ref<number | null>(null);
    const updatedAt = ref<string | null>(null);
    const loading = ref(true);
    const saving = ref(false);
    const error = ref<string | null>(null);
    const savedSnapshot = ref("");
    const editChecklist = ref<Record<string, boolean>>({});
    const history = ref<Array<{ id: string; version: number; valueJson: CheckoutSupportConfig; effectiveFrom: string; createdAt: string; updatedAt: string }>>([]);
    const historyLoading = ref(false);
    const summary = ref<CheckoutSupportSummary | null>(null);
    const summaryExportLoading = ref(false);
    const compareVersion = ref<(typeof history.value)[number] | null>(null);

    const formSnapshot = () => JSON.stringify(form.value);
    const isDirty = computed(() => savedSnapshot.value !== "" && formSnapshot() !== savedSnapshot.value);

    const phoneDigits = (value: string) => value.replace(/[^\d]/g, "");
    const emailInvalid = computed(
        () => !!trimmed(form.value.support_email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed(form.value.support_email)),
    );
    const phoneInvalid = computed(() => {
        const digits = phoneDigits(form.value.support_phone);
        return !!digits && (digits.length < 6 || digits.length > 15);
    });
    const whatsappInvalid = computed(() => {
        const digits = phoneDigits(form.value.support_whatsapp);
        return !!digits && (digits.length < 6 || digits.length > 15);
    });
    const hasValidationError = computed(() => emailInvalid.value || phoneInvalid.value || whatsappInvalid.value);

    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
        if (!isDirty.value) return;
        event.preventDefault();
        event.returnValue = "";
    };
    onMounted(() => window.addEventListener("beforeunload", warnBeforeUnload));
    onUnmounted(() => window.removeEventListener("beforeunload", warnBeforeUnload));

    const isArabic = computed(() => current.value === "ar");
    const tr = (ar: string, en: string): string => (isArabic.value ? ar : en);

    const applyValue = (value: CheckoutSupportConfig | null) => {
        const data: Partial<CheckoutSupportConfig> = value ?? {};
        form.value = {
            enabled: data.enabled === true,
            show_platform_contact: data.show_platform_contact === true,
            show_merchant_contact: data.show_merchant_contact === true,
            support_phone: data.support_phone ?? "",
            support_whatsapp: data.support_whatsapp ?? "",
            support_email: data.support_email ?? "",
            working_hours_ar: data.working_hours_ar ?? "",
            working_hours_en: data.working_hours_en ?? "",
            faq_items: (data.faq_items ?? []).map((item) => ({
                q_ar: item.q_ar ?? "",
                a_ar: item.a_ar ?? "",
                q_en: item.q_en ?? "",
                a_en: item.a_en ?? "",
            })),
        };
    };

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.checkoutSupport);
            const payload = (response.data?.data ?? response.data ?? {}) as CheckoutSupportResponse;
            applyValue(payload.value ?? null);
            savedSnapshot.value = formSnapshot();
            editChecklist.value = {};
            version.value = typeof payload.version === "number" ? payload.version : null;
            updatedAt.value = payload.updatedAt ?? null;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.checkoutSupportSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as CheckoutSupportSummary;
        } catch {
            summary.value = null;
        }
    };

    const exportSummary = async () => {
        if (summaryExportLoading.value) return;
        summaryExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.checkoutSupportSummaryExport);
            const payload = response.data?.data ?? response.data ?? {};
            const snapshot = (payload.summary ?? payload) as CheckoutSupportSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["enabled", snapshot.enabled],
                ["show_platform_contact", snapshot.showPlatformContact],
                ["show_merchant_contact", snapshot.showMerchantContact],
                ["faq_items", snapshot.faqItems],
                ["channel_count", snapshot.channelCount],
                ["channels", (snapshot.channels ?? []).join(";")],
                ["versions", snapshot.versions],
                ["current_version", snapshot.currentVersion],
                ["updated_at", snapshot.updatedAt ?? ""],
                ["effective_from", snapshot.effectiveFrom ?? ""],
                ["future_effective", snapshot.futureEffective],
            ];
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `checkout-help-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: tr("تم تصدير الملخص", "Summary exported") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            summaryExportLoading.value = false;
        }
    };

    const loadHistory = async () => {
        historyLoading.value = true;
        try {
            const response = await api.get(urlsMap.checkoutSupportHistory);
            const payload = response.data?.data ?? response.data ?? {};
            history.value = (payload.versions ?? []) as typeof history.value;
        } catch {
            history.value = [];
        } finally {
            historyLoading.value = false;
        }
    };

    void load();
    void loadHistory();
    void loadSummary();

    const diffRows = computed<DiffRow[]>(() => {
        const oldRow = compareVersion.value;
        const current = history.value[0];
        if (!oldRow || !current) return [];
        const before = flattenJson(oldRow.valueJson ?? {});
        const after = flattenJson(current.valueJson ?? {});
        const paths = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
        const rows: DiffRow[] = [];
        for (const path of paths) {
            const oldValue = before[path];
            const newValue = after[path];
            if (oldValue === newValue) continue;
            rows.push({
                path,
                before: oldValue ?? "—",
                after: newValue ?? "—",
                kind: oldValue === undefined ? "ADDED" : newValue === undefined ? "REMOVED" : "CHANGED",
            });
        }
        return rows;
    });

    const addFaq = () => {
        form.value.faq_items.push({ q_ar: "", a_ar: "", q_en: "", a_en: "" });
    };

    const removeFaq = (index: number) => {
        form.value.faq_items.splice(index, 1);
    };

    const editChecklistComplete = computed(() => !showChecklists || CHECKOUT_EDIT_CHECKS.every((check) => editChecklist.value[check.key] === true));

    const save = async () => {
        if (saving.value) {
            return;
        }
        if (hasValidationError.value) {
            showSnackBar({
                type: "error",
                message: tr("تحقق من بيانات التواصل قبل الحفظ", "Fix the contact details before saving"),
            });
            return;
        }
        if (!editChecklistComplete.value) {
            showSnackBar({
                type: "error",
                message: tr("أكمل قائمة التحقق قبل الحفظ", "Complete the edit checklist before saving"),
            });
            return;
        }
        saving.value = true;
        error.value = null;
        try {
            await api.put(urlsMap.checkoutSupport, {
                enabled: form.value.enabled,
                show_platform_contact: form.value.show_platform_contact,
                show_merchant_contact: form.value.show_merchant_contact,
                support_phone: form.value.support_phone.trim(),
                support_whatsapp: form.value.support_whatsapp.trim(),
                support_email: form.value.support_email.trim(),
                working_hours_ar: form.value.working_hours_ar.trim(),
                working_hours_en: form.value.working_hours_en.trim(),
                faq_items: form.value.faq_items
                    .map((item) => ({
                        q_ar: item.q_ar.trim(),
                        a_ar: item.a_ar.trim(),
                        q_en: item.q_en.trim(),
                        a_en: item.a_en.trim(),
                    }))
                    .filter((item) => item.q_ar || item.a_ar || item.q_en || item.a_en),
                checklist: CHECKOUT_EDIT_CHECKS.filter((check) => editChecklist.value[check.key]).map((check) => check.key),
            });
            showSnackBar({
                type: "success",
                message: tr("تم حفظ إعدادات المساعدة", "Checkout help settings saved"),
            });
            await load();
        } catch (e) {
            const message = extractApiErrorMessage(e);
            error.value = message;
            showSnackBar({ type: "error", message });
        } finally {
            saving.value = false;
        }
    };

    const previewWorkingHours = computed(() =>
        isArabic.value
            ? trimmed(form.value.working_hours_ar) || trimmed(form.value.working_hours_en)
            : trimmed(form.value.working_hours_en) || trimmed(form.value.working_hours_ar),
    );

    const previewFaqs = computed(() =>
        form.value.faq_items
            .map((item) =>
                isArabic.value
                    ? { question: trimmed(item.q_ar), answer: trimmed(item.a_ar) }
                    : { question: trimmed(item.q_en), answer: trimmed(item.a_en) },
            )
            .filter((item) => item.question && item.answer),
    );

    const previewPhone = computed(() => trimmed(form.value.support_phone));
    const previewWhatsapp = computed(() => trimmed(form.value.support_whatsapp));
    const previewEmail = computed(() => trimmed(form.value.support_email));
    const previewWhatsappHref = computed(() => {
        const digits = digitsOnly(previewWhatsapp.value);
        if (!digits) {
            return "";
        }
        return `https://wa.me/${digits}?text=${encodeURIComponent(
            "Hello, I need help with payment link DEMO-LINK / reference DEMO-REF",
        )}`;
    });

    const hasPreviewPlatformContact = computed(
        () =>
            form.value.show_platform_contact &&
            (!!previewPhone.value || !!previewWhatsapp.value || !!previewEmail.value),
    );

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Checkout Help")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                            <VChip size="small" variant="tonal" color={isDirty.value ? "warning" : "success"}>
                                {isDirty.value ? tr("تغييرات غير محفوظة", "Unsaved changes") : tr("محفوظ", "Saved")}
                            </VChip>
                            <VBtn size="small" variant="tonal" prependIcon="mdi-download" loading={summaryExportLoading.value} onClick={() => void exportSummary()}>{tr("تصدير الملخص", "Export summary")}</VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="warning" variant="tonal" density="comfortable">
                    <ThemedView style={{ gap: "4px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>
                            {tr("تنبيه مهم", "Important warning")}
                        </ThemedText>
                        <ThemedText style={{ fontSize: "13px", lineHeight: "1.7" }}>
                            {tr(
                                "إيقاف التفعيل يخفي قسم «تواصل مع الدعم» من كل صفحات الدفع فوراً. لن يتمكن الدافعون من رؤية أرقام التواصل أو واتساب أو البريد.",
                                "Disabling this hides the Contact Us block on every checkout page immediately. Payers will not see the phone, WhatsApp, or email contact options.",
                            )}
                        </ThemedText>
                    </ThemedView>
                </VAlert>

                {summary.value && (
                    <VCard variant="flat" style={{ borderRadius: "16px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{tr("صحة إعدادات المساعدة", "Checkout help health")}</ThemedText>
                            <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px" }}>
                                {[
                                    [tr("الحالة", "State"), summary.value.enabled ? tr("مفعّل", "Enabled") : tr("متوقف", "Disabled")],
                                    [tr("الأسئلة", "FAQ items"), String(summary.value.faqItems)],
                                    [tr("القنوات", "Channels"), String(summary.value.channelCount)],
                                    [tr("الإصدار", "Version"), String(summary.value.currentVersion)],
                                    [tr("التحديثات", "Versions"), String(summary.value.versions)],
                                ].map(([label, value]) => (
                                    <VCard key={label} variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "12px" }}>
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.62 }}>{label}</ThemedText>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{value}</ThemedText>
                                        </VCardText>
                                    </VCard>
                                ))}
                            </ThemedView>
                        </VCardText>
                    </VCard>
                )}

                <ThemedView
                    style={{
                        flexDirection: "row",
                        flexWrap: "wrap",
                        alignItems: "flex-start",
                        gap: "18px",
                    }}
                >
                    <VCard style={{ flex: "2 1 640px", minWidth: "320px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                            <ThemedView
                                style={{
                                    flexDirection: "row",
                                    flexWrap: "wrap",
                                    alignItems: "center",
                                    gap: "10px",
                                }}
                            >
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "17px", flex: 1 }}>
                                    {tr("إعدادات المساعدة في الدفع", "Checkout support settings")}
                                </ThemedText>
                                <VChip size="small" variant="tonal" color="primary">
                                    {tr("الإصدار", "Version")}: {version.value ?? "-"}
                                </VChip>
                            </ThemedView>

                            <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>
                                {tr("آخر تحديث", "Last updated")}: {updatedAt.value ?? "-"}
                            </ThemedText>

                            {error.value && (
                                <VAlert type="error" variant="tonal" density="compact">
                                    {error.value}
                                </VAlert>
                            )}

                            <VDivider />

                            <ThemedView style={{ gap: "4px" }}>
                                <VSwitch
                                    modelValue={form.value.enabled}
                                    onUpdate:modelValue={(value: boolean | null) => (form.value.enabled = !!value)}
                                    label={tr("تفعيل قسم التواصل مع الدعم", "Enable contact support")}
                                    color="primary"
                                    hideDetails
                                />
                                <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>
                                    {tr(
                                        "عند الإيقاف يختفي قسم التواصل بالكامل من صفحات الدفع.",
                                        "When off, the whole Contact Support block is removed from checkout pages.",
                                    )}
                                </ThemedText>
                            </ThemedView>

                            <VSwitch
                                modelValue={form.value.show_platform_contact}
                                onUpdate:modelValue={(value: boolean | null) =>
                                    (form.value.show_platform_contact = !!value)
                                }
                                label={tr("إظهار بيانات تواصل المنصة", "Show platform contact details")}
                                color="primary"
                                hideDetails
                            />

                            <VSwitch
                                modelValue={form.value.show_merchant_contact}
                                onUpdate:modelValue={(value: boolean | null) =>
                                    (form.value.show_merchant_contact = !!value)
                                }
                                label={tr("إظهار بيانات تواصل المتجر", "Show merchant contact details")}
                                color="primary"
                                hideDetails
                            />

                            <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "12px" }}>
                                <VTextField
                                    label={tr("هاتف الدعم", "Support phone")}
                                    modelValue={form.value.support_phone}
                                    onUpdate:modelValue={(value: string) => (form.value.support_phone = value)}
                                    placeholder="+218..."
                                    error={phoneInvalid.value}
                                    errorMessages={phoneInvalid.value ? tr("أدخل رقماً بين 6 و15 رقماً", "Enter a phone number with 6-15 digits") : []}
                                    style={{ flex: "1 1 260px", minWidth: "220px" }}
                                />
                                <VTextField
                                    label={tr("واتساب الدعم", "Support WhatsApp")}
                                    modelValue={form.value.support_whatsapp}
                                    onUpdate:modelValue={(value: string) => (form.value.support_whatsapp = value)}
                                    placeholder="+218..."
                                    error={whatsappInvalid.value}
                                    errorMessages={whatsappInvalid.value ? tr("أدخل رقماً بين 6 و15 رقماً", "Enter a phone number with 6-15 digits") : []}
                                    style={{ flex: "1 1 260px", minWidth: "220px" }}
                                />
                            </ThemedView>

                            <VTextField
                                label={tr("بريد الدعم الإلكتروني", "Support email")}
                                modelValue={form.value.support_email}
                                onUpdate:modelValue={(value: string) => (form.value.support_email = value)}
                                placeholder="support@example.com"
                                type="email"
                                error={emailInvalid.value}
                                errorMessages={emailInvalid.value ? tr("أدخل بريداً إلكترونياً صحيحاً", "Enter a valid email address") : []}
                            />

                            <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "12px" }}>
                                <VTextField
                                    label={tr("ساعات العمل (عربي)", "Working hours (Arabic)")}
                                    modelValue={form.value.working_hours_ar}
                                    onUpdate:modelValue={(value: string) => (form.value.working_hours_ar = value)}
                                    placeholder="الأحد - الخميس 9:00 - 17:00"
                                    style={{ flex: "1 1 260px", minWidth: "220px" }}
                                />
                                <VTextField
                                    label={tr("ساعات العمل (إنجليزي)", "Working hours (English)")}
                                    modelValue={form.value.working_hours_en}
                                    onUpdate:modelValue={(value: string) => (form.value.working_hours_en = value)}
                                    placeholder="Sun - Thu 9:00 - 17:00"
                                    style={{ flex: "1 1 260px", minWidth: "220px" }}
                                />
                            </ThemedView>

                            <VDivider />

                            <ThemedView
                                style={{
                                    flexDirection: "row",
                                    alignItems: "center",
                                    gap: "10px",
                                }}
                            >
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "15px", flex: 1 }}>
                                    {tr("الأسئلة الشائعة", "FAQ")}
                                </ThemedText>
                                <VBtn
                                    size="small"
                                    variant="tonal"
                                    prependIcon="mdi-plus"
                                    onClick={() => addFaq()}
                                >
                                    {tr("إضافة سؤال", "Add FAQ")}
                                </VBtn>
                            </ThemedView>

                            {form.value.faq_items.length === 0 && (
                                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                    {tr("لا توجد أسئلة شائعة بعد.", "No FAQ entries yet.")}
                                </ThemedText>
                            )}

                            <ThemedView style={{ gap: "12px" }}>
                                {form.value.faq_items.map((item, index) => (
                                    <ThemedView
                                        key={index}
                                        style={{
                                            gap: "10px",
                                            padding: "12px",
                                            border: "1px solid rgba(100,116,139,0.2)",
                                            borderRadius: "12px",
                                        }}
                                    >
                                        <ThemedView
                                            style={{
                                                flexDirection: "row",
                                                alignItems: "center",
                                                gap: "10px",
                                            }}
                                        >
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px", flex: 1 }}>
                                                {tr("سؤال", "FAQ item")} #{index + 1}
                                            </ThemedText>
                                            <VBtn
                                                size="small"
                                                variant="text"
                                                color="error"
                                                prependIcon="mdi-delete-outline"
                                                onClick={() => removeFaq(index)}
                                            >
                                                {tr("حذف", "Remove")}
                                            </VBtn>
                                        </ThemedView>

                                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "10px" }}>
                                            <VTextField
                                                label={tr("السؤال (عربي)", "Question (Arabic)")}
                                                modelValue={item.q_ar}
                                                onUpdate:modelValue={(value: string) => (item.q_ar = value)}
                                                style={{ flex: "1 1 260px", minWidth: "220px" }}
                                            />
                                            <VTextField
                                                label={tr("السؤال (إنجليزي)", "Question (English)")}
                                                modelValue={item.q_en}
                                                onUpdate:modelValue={(value: string) => (item.q_en = value)}
                                                style={{ flex: "1 1 260px", minWidth: "220px" }}
                                            />
                                        </ThemedView>

                                        <VTextarea
                                            label={tr("الإجابة (عربي)", "Answer (Arabic)")}
                                            modelValue={item.a_ar}
                                            onUpdate:modelValue={(value: string) => (item.a_ar = value)}
                                            rows={2}
                                            autoGrow
                                        />
                                        <VTextarea
                                            label={tr("الإجابة (إنجليزي)", "Answer (English)")}
                                            modelValue={item.a_en}
                                            onUpdate:modelValue={(value: string) => (item.a_en = value)}
                                            rows={2}
                                            autoGrow
                                        />
                                    </ThemedView>
                                ))}
                            </ThemedView>

                            {showChecklists && (
                                <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                    <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{tr("قائمة التحقق من التعديل", "Edit checklist")}</ThemedText>
                                    {CHECKOUT_EDIT_CHECKS.map((check) => (
                                        <VCheckbox
                                            key={check.key}
                                            modelValue={editChecklist.value[check.key] === true}
                                            onUpdate:modelValue={(value: unknown) => (editChecklist.value = { ...editChecklist.value, [check.key]: Boolean(value) })}
                                            label={tr(check.ar, check.en)}
                                            density="compact"
                                            hideDetails
                                        />
                                    ))}
                                    {!editChecklistComplete.value && (
                                        <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{tr("أكمل قائمة التحقق قبل الحفظ", "Complete the edit checklist before saving")}</ThemedText>
                                    )}
                                </ThemedView>
                            )}
                            <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end", gap: "10px" }}>
                                <VBtn
                                    variant="tonal"
                                    loading={loading.value}
                                    onClick={() => void load()}
                                >
                                    {tr("إعادة تحميل", "Reload")}
                                </VBtn>
                                <VBtn color="primary" loading={saving.value} disabled={saving.value || !isDirty.value || hasValidationError.value || !editChecklistComplete.value} onClick={() => void save()}>
                                    {tr("حفظ", "Save")}
                                </VBtn>
                            </ThemedView>
                        </VCardText>
                    </VCard>

                    <VCard style={{ flex: "1 1 340px", minWidth: "300px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px" }}>
                                <VIcon icon="mdi-eye-outline" color="primary" />
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                    {tr("معاينة مباشرة", "Live preview")}
                                </ThemedText>
                            </ThemedView>
                            <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                {tr(
                                    "هكذا سيرى الدافع قسم المساعدة على صفحة الدفع.",
                                    "This is what the payer will see in the checkout help section.",
                                )}
                            </ThemedText>

                            <VDivider />

                            <ThemedView style={{ gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "14px" }}>
                                    {tr("تواصل مع الدعم", "Contact Support")}
                                </ThemedText>

                                {!form.value.enabled ? (
                                    <VAlert type="info" variant="tonal" density="compact">
                                        {tr(
                                            "قسم التواصل مخفي حالياً من جميع صفحات الدفع.",
                                            "The Contact Support block is currently hidden from all checkout pages.",
                                        )}
                                    </VAlert>
                                ) : (
                                    <>
                                        {!!previewWorkingHours.value && (
                                            <VChip
                                                size="small"
                                                variant="tonal"
                                                color="primary"
                                                prependIcon="mdi-clock-outline"
                                                style={{ alignSelf: "flex-start" }}
                                            >
                                                {previewWorkingHours.value}
                                            </VChip>
                                        )}

                                        {form.value.show_platform_contact && (
                                            <ThemedView style={{ gap: "8px" }}>
                                                <ThemedText
                                                    type="defaultSemiBold"
                                                    style={{ fontSize: "12px", opacity: 0.7 }}
                                                >
                                                    {tr("فريق المنصة", "Platform team")}
                                                </ThemedText>
                                                {hasPreviewPlatformContact.value ? (
                                                    <ThemedView
                                                        style={{ flexDirection: "row", flexWrap: "wrap", gap: "8px" }}
                                                    >
                                                        {!!previewWhatsappHref.value && (
                                                            <VBtn
                                                                size="small"
                                                                variant="tonal"
                                                                color="success"
                                                                prependIcon="mdi-whatsapp"
                                                                href={previewWhatsappHref.value}
                                                            >
                                                                WhatsApp
                                                            </VBtn>
                                                        )}
                                                        {!!previewPhone.value && (
                                                            <VBtn
                                                                size="small"
                                                                variant="tonal"
                                                                prependIcon="mdi-phone"
                                                            >
                                                                {previewPhone.value}
                                                            </VBtn>
                                                        )}
                                                        {!!previewEmail.value && (
                                                            <VBtn
                                                                size="small"
                                                                variant="tonal"
                                                                prependIcon="mdi-email-outline"
                                                            >
                                                                {previewEmail.value}
                                                            </VBtn>
                                                        )}
                                                    </ThemedView>
                                                ) : (
                                                    <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                                        {tr(
                                                            "لم يتم إدخال بيانات تواصل للمنصة.",
                                                            "No platform contact details entered.",
                                                        )}
                                                    </ThemedText>
                                                )}
                                            </ThemedView>
                                        )}

                                        {form.value.show_merchant_contact && (
                                            <ThemedView style={{ gap: "4px" }}>
                                                <ThemedText
                                                    type="defaultSemiBold"
                                                    style={{ fontSize: "12px", opacity: 0.7 }}
                                                >
                                                    {tr("المتجر", "Merchant")}
                                                </ThemedText>
                                                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                                    {tr(
                                                        "تظهر بيانات تواصل المتجر تلقائياً من رابط الدفع عند توفرها.",
                                                        "The merchant's store contact appears automatically from the payment link when available.",
                                                    )}
                                                </ThemedText>
                                            </ThemedView>
                                        )}
                                    </>
                                )}
                            </ThemedView>

                            <VDivider />

                            <ThemedView style={{ gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "14px" }}>
                                    {tr("الأسئلة الشائعة", "Frequently asked questions")}
                                </ThemedText>
                                {!form.value.enabled ? (
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                        {tr(
                                            "فعّل قسم المساعدة لعرض الأسئلة الشائعة على صفحة الدفع.",
                                            "Enable contact support to show the FAQ on checkout.",
                                        )}
                                    </ThemedText>
                                ) : previewFaqs.value.length === 0 ? (
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                        {tr(
                                            "لا توجد أسئلة شائعة مكتملة باللغة الحالية.",
                                            "No complete FAQ entries in the current language.",
                                        )}
                                    </ThemedText>
                                ) : (
                                    previewFaqs.value.map((item, index) => (
                                        <ThemedView
                                            key={`${item.question}-${index}`}
                                            style={{
                                                gap: "3px",
                                                padding: "10px 12px",
                                                borderRadius: "10px",
                                                background: "rgba(100,116,139,0.08)",
                                            }}
                                        >
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>
                                                {item.question}
                                            </ThemedText>
                                            <ThemedText
                                                style={{ fontSize: "13px", opacity: 0.8, lineHeight: "1.6" }}
                                            >
                                                {item.answer}
                                            </ThemedText>
                                        </ThemedView>
                                    ))
                                )}
                            </ThemedView>
                        </VCardText>
                    </VCard>
                </ThemedView>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "16px", flex: 1 }}>
                                {tr("سجل إصدارات الإعدادات", "Configuration version history")}
                            </ThemedText>
                            <VChip size="x-small" variant="tonal">{history.value.length}</VChip>
                            <VBtn size="small" variant="text" loading={historyLoading.value} onClick={() => void loadHistory()}>
                                {tr("تحديث", "Refresh")}
                            </VBtn>
                        </ThemedView>
                        {history.value.length === 0 && (
                            <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>
                                {tr("لا يوجد سجل بعد.", "No history yet.")}
                            </ThemedText>
                        )}
                        {history.value.map((version, index) => (
                            <ThemedView
                                key={version.id}
                                style={{ flexDirection: "row", alignItems: "center", gap: "10px", flexWrap: "wrap", padding: "8px 10px", borderRadius: "8px", border: "1px solid rgba(100,116,139,0.2)" }}
                            >
                                <VChip size="x-small" variant="tonal" color="primary">v{version.version}</VChip>
                                {index === 0 && <VChip size="x-small" variant="tonal" color="success">{tr("الحالي", "Current")}</VChip>}
                                <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>
                                    {tr("ساري من", "Effective")}: {new Date(version.effectiveFrom).toLocaleString()}
                                </ThemedText>
                                <ThemedText style={{ fontSize: "11px", opacity: 0.45 }}>
                                    {tr("أُنشئ", "Created")}: {new Date(version.createdAt).toLocaleString()}
                                </ThemedText>
                                <div style={{ flex: 1 }} />
                                {index !== 0 && (
                                    <VBtn
                                        size="x-small"
                                        variant="text"
                                        onClick={() => (compareVersion.value = version)}
                                    >
                                        {tr("مقارنة مع الحالي", "Compare with current")}
                                    </VBtn>
                                )}
                                <VBtn
                                    size="x-small"
                                    variant="text"
                                    disabled={index === 0}
                                    onClick={() => {
                                        applyValue(version.valueJson);
                                        showSnackBar({ type: "success", message: tr("تم تحميل الإصدار في المحرر", "Version loaded into the editor") });
                                    }}
                                >
                                    {tr("تحميل في المحرر", "Load into editor")}
                                </VBtn>
                            </ThemedView>
                        ))}
                        {compareVersion.value && (
                            <VCard variant="tonal">
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "13px", flex: 1 }}>
                                            {tr("مقارنة", "Comparing")} v{compareVersion.value.version} → v{history.value[0]?.version}
                                        </ThemedText>
                                        <VBtn size="x-small" variant="text" onClick={() => (compareVersion.value = null)}>
                                            {tr("مسح المقارنة", "Clear comparison")}
                                        </VBtn>
                                    </ThemedView>
                                    {diffRows.value.length === 0 && (
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                            {tr("لا توجد فروقات بين الإصدارين.", "No differences in this version pair.")}
                                        </ThemedText>
                                    )}
                                    {diffRows.value.map((row) => (
                                        <ThemedView key={row.path} style={{ gap: "3px", padding: "6px 8px", borderRadius: "8px", background: "rgba(100,116,139,0.08)" }}>
                                            <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center" }}>
                                                <ThemedText style={{ fontSize: "11px", fontWeight: 700, direction: "ltr" }}>{row.path}</ThemedText>
                                                <VChip size="x-small" variant="tonal" color={row.kind === "ADDED" ? "success" : row.kind === "REMOVED" ? "error" : "warning"}>{row.kind}</VChip>
                                            </ThemedView>
                                            <ThemedText style={{ fontSize: "11px", direction: "ltr", opacity: 0.75 }}>{row.before} → {row.after}</ThemedText>
                                        </ThemedView>
                                    ))}
                                </VCardText>
                            </VCard>
                        )}
                    </VCardText>
                </VCard>
            </ThemedView>
        </ScreenContainer>
    );
});

export default AdminCheckoutHelpPage;
