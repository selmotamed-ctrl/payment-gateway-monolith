import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import {
    VAlert,
    VBtn,
    VCard,
    VCardText,
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
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type FaqItem = {
    q_ar: string;
    a_ar: string;
    q_en: string;
    a_en: string;
};

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

const AdminCheckoutHelpPage = dc(() => {
    const { t, current } = useLocale();

    const form = ref<CheckoutSupportForm>(emptyForm());
    const version = ref<number | null>(null);
    const updatedAt = ref<string | null>(null);
    const loading = ref(true);
    const saving = ref(false);
    const error = ref<string | null>(null);

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
            version.value = typeof payload.version === "number" ? payload.version : null;
            updatedAt.value = payload.updatedAt ?? null;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    void load();

    const addFaq = () => {
        form.value.faq_items.push({ q_ar: "", a_ar: "", q_en: "", a_en: "" });
    };

    const removeFaq = (index: number) => {
        form.value.faq_items.splice(index, 1);
    };

    const save = async () => {
        if (saving.value) {
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
                <PageHeader title={t("Checkout Help")} />

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
                                    style={{ flex: "1 1 260px", minWidth: "220px" }}
                                />
                                <VTextField
                                    label={tr("واتساب الدعم", "Support WhatsApp")}
                                    modelValue={form.value.support_whatsapp}
                                    onUpdate:modelValue={(value: string) => (form.value.support_whatsapp = value)}
                                    placeholder="+218..."
                                    style={{ flex: "1 1 260px", minWidth: "220px" }}
                                />
                            </ThemedView>

                            <VTextField
                                label={tr("بريد الدعم الإلكتروني", "Support email")}
                                modelValue={form.value.support_email}
                                onUpdate:modelValue={(value: string) => (form.value.support_email = value)}
                                placeholder="support@example.com"
                                type="email"
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

                            <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end", gap: "10px" }}>
                                <VBtn
                                    variant="tonal"
                                    loading={loading.value}
                                    onClick={() => void load()}
                                >
                                    {tr("إعادة تحميل", "Reload")}
                                </VBtn>
                                <VBtn color="primary" loading={saving.value} onClick={() => void save()}>
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
            </ThemedView>
        </ScreenContainer>
    );
});

export default AdminCheckoutHelpPage;
