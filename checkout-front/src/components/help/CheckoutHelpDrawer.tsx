import { dc } from "kt-dc";
import { computed } from "vue";
import { VBtn, VIcon } from "vuetify/components";
import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import { DescriptionList, MetaPill, MonoRef, SlideOverDrawer } from "@/components/ui";
import { showSnackBar } from "@/utils/snackBar";
import type { AttemptStatus, PayLinkSummary, RailDescriptor } from "@/components/renderers/types";

export type CheckoutHelpDrawerProps = {
    open: boolean;
    onClose: () => void;
    summary: PayLinkSummary | null;
    selectedRail: RailDescriptor | null;
    attemptStatus: AttemptStatus | string | null;
    reference: string | null;
    locale: "ar" | "en";
};

type StateHelp = {
    title: string;
    body: string;
    tone: "info" | "warning" | "error";
};

type FaqEntry = {
    question: string;
    answer: string;
};

const nonEmpty = (values: string[] | null | undefined): string[] =>
    (values ?? []).map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean);

const trimmed = (value: string | null | undefined): string =>
    typeof value === "string" ? value.trim() : "";

const digitsOnly = (value: string): string => value.replace(/[^\d]/g, "");

const sectionTitleStyle = { fontSize: "14px", fontWeight: 600, color: "var(--pg-ink-primary)" } as const;

const STATE_TONE_STYLES = {
    info: {
        background: "var(--pg-status-info-bg)",
        border: "var(--pg-status-info-border)",
    },
    warning: {
        background: "var(--pg-status-warning-bg)",
        border: "var(--pg-status-warning-border)",
    },
    error: {
        background: "var(--pg-status-danger-bg)",
        border: "var(--pg-status-danger-border)",
    },
} as const;

export const CheckoutHelpDrawer = dc(
    (props: CheckoutHelpDrawerProps) => {
        const isArabic = computed(() => props.locale === "ar");
        const support = computed(() => props.summary?.supportConfig ?? null);
        const isSupportEnabled = computed(() => support.value?.enabled === true);
        const platform = computed(() => support.value?.platform ?? null);
        const merchant = computed(() => support.value?.merchant ?? null);

        const guide = computed(() => props.selectedRail?.helpGuide ?? null);

        const railName = computed(() => {
            const rail = props.selectedRail;
            if (!rail) {
                return "";
            }
            return isArabic.value
                ? rail.displayNameAr || rail.displayNameEn
                : rail.displayNameEn || rail.displayNameAr;
        });

        const lastResort = (ar: string[], en: string[]): string[] => {
            if (isArabic.value) {
                return ar.length ? ar : en;
            }
            return en.length ? en : ar;
        };

        const steps = computed(() => {
            const value = guide.value;
            if (!value) {
                return [];
            }
            return lastResort(nonEmpty(value.steps_ar), nonEmpty(value.steps_en));
        });

        const prerequisites = computed(() => {
            const value = guide.value;
            if (!value) {
                return [];
            }
            return lastResort(nonEmpty(value.prerequisites_ar), nonEmpty(value.prerequisites_en));
        });

        const troubleshooting = computed<FaqEntry[]>(() => {
            const value = guide.value;
            if (!value) {
                return [];
            }

            if (isArabic.value) {
                const localized = (value.troubleshooting_ar ?? [])
                    .map((item) => ({ question: trimmed(item.q_ar), answer: trimmed(item.a_ar) }))
                    .filter((item) => item.question && item.answer);
                if (localized.length) {
                    return localized;
                }
                return (value.troubleshooting_en ?? [])
                    .map((item) => ({ question: trimmed(item.q_en), answer: trimmed(item.a_en) }))
                    .filter((item) => item.question && item.answer);
            }

            const localized = (value.troubleshooting_en ?? [])
                .map((item) => ({ question: trimmed(item.q_en), answer: trimmed(item.a_en) }))
                .filter((item) => item.question && item.answer);
            if (localized.length) {
                return localized;
            }
            return (value.troubleshooting_ar ?? [])
                .map((item) => ({ question: trimmed(item.q_ar), answer: trimmed(item.a_ar) }))
                .filter((item) => item.question && item.answer);
        });

        const faqItems = computed<FaqEntry[]>(() => {
            const items = support.value?.faq_items ?? [];
            return items
                .map((item) =>
                    isArabic.value
                        ? { question: trimmed(item.q_ar), answer: trimmed(item.a_ar) }
                        : { question: trimmed(item.q_en), answer: trimmed(item.a_en) },
                )
                .filter((item) => item.question && item.answer);
        });

        const workingHours = computed(() => {
            const value = support.value;
            if (!value) {
                return "";
            }
            return isArabic.value
                ? trimmed(value.working_hours_ar) || trimmed(value.working_hours_en)
                : trimmed(value.working_hours_en) || trimmed(value.working_hours_ar);
        });

        const linkKey = computed(() => trimmed(props.summary?.linkKey));
        const referenceValue = computed(() => trimmed(props.reference));

        const helpMessage = computed(() => {
            const ref = referenceValue.value || "N/A";
            return `Hello, I need help with payment link ${linkKey.value || "N/A"} / reference ${ref}`;
        });

        const whatsappNumber = computed(() => trimmed(platform.value?.whatsapp));
        const whatsappHref = computed(() => {
            const digits = digitsOnly(whatsappNumber.value);
            if (!digits) {
                return "";
            }
            return `https://wa.me/${digits}?text=${encodeURIComponent(helpMessage.value)}`;
        });

        const platformPhone = computed(() => trimmed(platform.value?.phone));
        const platformEmail = computed(() => trimmed(platform.value?.email));

        const merchantPhone = computed(() => trimmed(merchant.value?.phone));
        const merchantEmail = computed(() => trimmed(merchant.value?.email));
        const merchantName = computed(() => trimmed(merchant.value?.tradeName));

        const stateHelp = computed<StateHelp | null>(() => {
            const status = String(props.attemptStatus ?? "");
            const ar = isArabic.value;

            switch (status) {
                case "VERIFYING":
                    return {
                        tone: "info",
                        title: ar ? "جارٍ التحقق من الدفع" : "Your payment is being verified",
                        body: ar
                            ? "المنصة تتحقق من عملية الدفع الآن. لا تقم بالدفع مرة أخرى. قد تستغرق العملية بضع دقائق، وسيتم تحديث الحالة تلقائياً."
                            : "The platform is verifying your payment now. Do not pay again. This usually takes a few minutes and the status will update automatically.",
                    };
                case "UNKNOWN":
                    return {
                        tone: "warning",
                        title: ar ? "لم نتمكن من تأكيد النتيجة بعد" : "We could not confirm the result yet",
                        body: ar
                            ? "لا تقم بالدفع مرة أخرى. انتظر بضع دقائق ثم حدّث الصفحة. إذا بقيت الحالة غير معروفة، تواصل مع الدعم مع رقم المرجع."
                            : "Do not pay again. Wait a few minutes, then refresh this page. If the status is still unknown, contact support with your payment reference.",
                    };
                case "FAILED":
                    return {
                        tone: "error",
                        title: ar ? "لم تكتمل عملية الدفع" : "This payment attempt did not complete",
                        body: ar
                            ? "يمكنك المحاولة باستخدام وسيلة دفع أخرى. إذا تم خصم المبلغ من حسابك، تواصل مع الدعم مع رقم المرجع قبل إعادة المحاولة."
                            : "You can try again with another payment method. If money was deducted from your account, contact support with the payment reference before trying again.",
                    };
                case "EXPIRED":
                    return {
                        tone: "warning",
                        title: ar ? "انتهت صلاحية عملية الدفع" : "This payment window has expired",
                        body: ar
                            ? "لا تستخدم رقم المرجع القديم للدفع. ارجع وابدأ عملية دفع جديدة من صفحة الدفع."
                            : "Do not pay using the old reference. Go back and start a new payment from the checkout page.",
                    };
                case "CANCELLED":
                    return {
                        tone: "warning",
                        title: ar ? "تم إلغاء عملية الدفع" : "This payment was cancelled",
                        body: ar
                            ? "إذا تم خصم أي مبلغ من حسابك، تواصل مع الدعم مع رقم المرجع. وإلا يمكنك بدء عملية دفع جديدة."
                            : "If you were charged, contact support with the payment reference. Otherwise you can start a new payment.",
                    };
                default:
                    return null;
            }
        });

        const notifyReferenceCopied = () => {
            showSnackBar({
                type: "success",
                message: isArabic.value ? "تم نسخ رقم المرجع" : "Payment reference copied",
            });
        };

        return () => {
            const ar = isArabic.value;
            const hasPlatformContact =
                !!whatsappHref.value || !!platformPhone.value || !!platformEmail.value;
            const hasMerchantContact = !!merchant.value;
            const hasFaq = faqItems.value.length > 0;
            const hasGuide = !!guide.value;
            const hasTroubleshooting = troubleshooting.value.length > 0;
            const hasWorkingHours = !!workingHours.value;
            const stateTone = stateHelp.value ? STATE_TONE_STYLES[stateHelp.value.tone] : null;

            return (
                <SlideOverDrawer
                    modelValue={props.open}
                    onUpdate:modelValue={(value: boolean) => {
                        if (!value) {
                            props.onClose();
                        }
                    }}
                    title={ar ? "المساعدة والدعم" : "Help & Support"}
                    width={440}
                >
                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "18px",
                        }}
                    >
                        {stateHelp.value && stateTone && (
                            <div
                                role="alert"
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: "4px",
                                    padding: "10px 12px",
                                    borderRadius: "var(--pg-radius-sm)",
                                    backgroundColor: stateTone.background,
                                    border: `1px solid ${stateTone.border}`,
                                }}
                            >
                                <ThemedText
                                    type="defaultSemiBold"
                                    style={{ fontSize: "14px", color: "var(--pg-ink-primary)" }}
                                >
                                    {stateHelp.value.title}
                                </ThemedText>
                                <ThemedText
                                    style={{ fontSize: "13px", lineHeight: 1.7, color: "var(--pg-ink-secondary)" }}
                                >
                                    {stateHelp.value.body}
                                </ThemedText>
                            </div>
                        )}

                        {!!referenceValue.value && (
                            <DescriptionList
                                items={[
                                    {
                                        label: ar ? "رقم المرجع" : "Payment Reference",
                                        value: (
                                            <MonoRef
                                                value={referenceValue.value}
                                                onCopied={notifyReferenceCopied}
                                            />
                                        ),
                                    },
                                ]}
                            />
                        )}

                        {hasGuide && (
                            <ThemedView style={{ gap: "12px" }}>
                                <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px" }}>
                                    <VIcon
                                        icon="mdi-credit-card-outline"
                                        style={{ color: "var(--pg-accent-interactive)" }}
                                    />
                                    <ThemedText type="defaultSemiBold" style={sectionTitleStyle}>
                                        {ar ? `دليل الدفع عبر ${railName.value}` : `Guide for ${railName.value}`}
                                    </ThemedText>
                                </ThemedView>

                                {prerequisites.value.length > 0 && (
                                    <ThemedView style={{ gap: "6px" }}>
                                        <ThemedText
                                            type="defaultSemiBold"
                                            style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}
                                        >
                                            {ar ? "ما تحتاجه قبل البدء" : "Before you start"}
                                        </ThemedText>
                                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "6px" }}>
                                            {prerequisites.value.map((item, index) => (
                                                <MetaPill
                                                    key={`${item}-${index}`}
                                                    size="small"
                                                    variant="tonal"
                                                    prependIcon="mdi-check-circle-outline"
                                                >
                                                    {item}
                                                </MetaPill>
                                            ))}
                                        </ThemedView>
                                    </ThemedView>
                                )}

                                {steps.value.length > 0 && (
                                    <ThemedView style={{ gap: "8px" }}>
                                        {steps.value.map((step, index) => (
                                            <ThemedView
                                                key={`${step}-${index}`}
                                                style={{
                                                    flexDirection: "row",
                                                    alignItems: "flex-start",
                                                    gap: "10px",
                                                }}
                                            >
                                                <span
                                                    style={{
                                                        width: "24px",
                                                        height: "24px",
                                                        minWidth: "24px",
                                                        borderRadius: "var(--pg-radius-sm)",
                                                        background: "var(--pg-accent-primary)",
                                                        color: "var(--pg-bg-surface)",
                                                        display: "flex",
                                                        alignItems: "center",
                                                        justifyContent: "center",
                                                        fontSize: "12px",
                                                        fontWeight: 600,
                                                    }}
                                                >
                                                    {index + 1}
                                                </span>
                                                <ThemedText
                                                    style={{
                                                        fontSize: "13px",
                                                        lineHeight: 1.7,
                                                        flex: 1,
                                                        color: "var(--pg-ink-secondary)",
                                                    }}
                                                >
                                                    {step}
                                                </ThemedText>
                                            </ThemedView>
                                        ))}
                                    </ThemedView>
                                )}

                                {hasTroubleshooting && (
                                    <ThemedView style={{ gap: "10px" }}>
                                        <div style={{ height: "1px", backgroundColor: "var(--pg-border-subtle)" }} />
                                        <ThemedText
                                            type="defaultSemiBold"
                                            style={{ fontSize: "13px", color: "var(--pg-ink-primary)" }}
                                        >
                                            {ar ? "حل المشكلات" : "Troubleshooting"}
                                        </ThemedText>
                                        {troubleshooting.value.map((item, index) => (
                                            <ThemedView key={`${item.question}-${index}`} style={{ gap: "3px" }}>
                                                <ThemedText
                                                    type="defaultSemiBold"
                                                    style={{ fontSize: "13px", color: "var(--pg-ink-primary)" }}
                                                >
                                                    {item.question}
                                                </ThemedText>
                                                <ThemedText
                                                    style={{
                                                        fontSize: "13px",
                                                        color: "var(--pg-ink-secondary)",
                                                        lineHeight: 1.7,
                                                    }}
                                                >
                                                    {item.answer}
                                                </ThemedText>
                                            </ThemedView>
                                        ))}
                                    </ThemedView>
                                )}
                            </ThemedView>
                        )}

                        {hasFaq && (
                            <ThemedView style={{ gap: "10px" }}>
                                <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px" }}>
                                    <VIcon
                                        icon="mdi-frequently-asked-questions"
                                        style={{ color: "var(--pg-accent-interactive)" }}
                                    />
                                    <ThemedText type="defaultSemiBold" style={sectionTitleStyle}>
                                        {ar ? "الأسئلة الشائعة" : "Frequently asked questions"}
                                    </ThemedText>
                                </ThemedView>
                                {faqItems.value.map((item, index) => (
                                    <ThemedView
                                        key={`${item.question}-${index}`}
                                        style={{
                                            gap: "3px",
                                            padding: "10px 12px",
                                            borderRadius: "var(--pg-radius-sm)",
                                            background: "var(--pg-bg-surface-subtle)",
                                            border: "1px solid var(--pg-border-subtle)",
                                        }}
                                    >
                                        <ThemedText
                                            type="defaultSemiBold"
                                            style={{ fontSize: "13px", color: "var(--pg-ink-primary)" }}
                                        >
                                            {item.question}
                                        </ThemedText>
                                        <ThemedText
                                            style={{
                                                fontSize: "13px",
                                                color: "var(--pg-ink-secondary)",
                                                lineHeight: 1.7,
                                            }}
                                        >
                                            {item.answer}
                                        </ThemedText>
                                    </ThemedView>
                                ))}
                            </ThemedView>
                        )}

                        {isSupportEnabled.value && (
                            <ThemedView style={{ gap: "12px" }}>
                                <div style={{ height: "1px", backgroundColor: "var(--pg-border-subtle)" }} />
                                <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px" }}>
                                    <VIcon icon="mdi-headset" style={{ color: "var(--pg-accent-interactive)" }} />
                                    <ThemedText type="defaultSemiBold" style={sectionTitleStyle}>
                                        {ar ? "تواصل مع الدعم" : "Contact Support"}
                                    </ThemedText>
                                </ThemedView>

                                {hasWorkingHours && (
                                    <MetaPill
                                        size="small"
                                        variant="tonal"
                                        prependIcon="mdi-clock-outline"
                                    >
                                        {workingHours.value}
                                    </MetaPill>
                                )}

                                {hasPlatformContact && (
                                    <ThemedView style={{ gap: "8px" }}>
                                        <ThemedText
                                            type="defaultSemiBold"
                                            style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}
                                        >
                                            {ar ? "فريق المنصة" : "Platform team"}
                                        </ThemedText>
                                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "8px" }}>
                                            {!!whatsappHref.value && (
                                                <VBtn
                                                    size="small"
                                                    color="success"
                                                    variant="tonal"
                                                    prependIcon="mdi-whatsapp"
                                                    href={whatsappHref.value}
                                                >
                                                    WhatsApp
                                                </VBtn>
                                            )}
                                            {!!platformPhone.value && (
                                                <VBtn
                                                    size="small"
                                                    variant="tonal"
                                                    prependIcon="mdi-phone"
                                                    href={`tel:${platformPhone.value.replace(/\s+/g, "")}`}
                                                >
                                                    {platformPhone.value}
                                                </VBtn>
                                            )}
                                            {!!platformEmail.value && (
                                                <VBtn
                                                    size="small"
                                                    variant="tonal"
                                                    prependIcon="mdi-email-outline"
                                                    href={`mailto:${platformEmail.value}?subject=${encodeURIComponent(
                                                        ar ? "طلب مساعدة في الدفع" : "Payment help request",
                                                    )}&body=${encodeURIComponent(helpMessage.value)}`}
                                                >
                                                    {platformEmail.value}
                                                </VBtn>
                                            )}
                                        </ThemedView>
                                    </ThemedView>
                                )}

                                {hasMerchantContact && (
                                    <ThemedView style={{ gap: "8px" }}>
                                        <ThemedText
                                            type="defaultSemiBold"
                                            style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}
                                        >
                                            {ar ? "المتجر" : "Merchant"}
                                        </ThemedText>
                                        {!!merchantName.value && (
                                            <ThemedText
                                                type="defaultSemiBold"
                                                style={{ fontSize: "13px", color: "var(--pg-ink-primary)" }}
                                            >
                                                {merchantName.value}
                                            </ThemedText>
                                        )}
                                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "8px" }}>
                                            {!!merchantPhone.value && (
                                                <VBtn
                                                    size="small"
                                                    variant="tonal"
                                                    prependIcon="mdi-phone"
                                                    href={`tel:${merchantPhone.value.replace(/\s+/g, "")}`}
                                                >
                                                    {merchantPhone.value}
                                                </VBtn>
                                            )}
                                            {!!merchantEmail.value && (
                                                <VBtn
                                                    size="small"
                                                    variant="tonal"
                                                    prependIcon="mdi-email-outline"
                                                    href={`mailto:${merchantEmail.value}?subject=${encodeURIComponent(
                                                        ar ? "طلب مساعدة في الدفع" : "Payment help request",
                                                    )}&body=${encodeURIComponent(helpMessage.value)}`}
                                                >
                                                    {merchantEmail.value}
                                                </VBtn>
                                            )}
                                        </ThemedView>
                                    </ThemedView>
                                )}

                                {!hasPlatformContact && !hasMerchantContact && !hasWorkingHours && (
                                    <ThemedText style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                                        {ar
                                            ? "لا توجد بيانات تواصل متاحة حالياً."
                                            : "No contact details are available right now."}
                                    </ThemedText>
                                )}
                            </ThemedView>
                        )}
                    </div>
                </SlideOverDrawer>
            );
        };
    },
    {
        props: ["open", "onClose", "summary", "selectedRail", "attemptStatus", "reference", "locale"],
    },
);

export default CheckoutHelpDrawer;
