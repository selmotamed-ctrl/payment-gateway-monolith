import { dc } from "kt-dc";
import { computed } from "vue";
import type Decimal from "decimal.js";
import { useLocale } from "vuetify";
import { VSelect, VTextField } from "vuetify/components";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { FormField } from "@/components/ui/FormField";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { toDecimal } from "@/utils/money";

export type FeeBearer = "MERCHANT_ABSORBS" | "PAYER_SURCHARGE" | "SPLIT";

export type MerchantFeeCalculatorForm = {
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

export const MerchantFeeCalculator = dc(
    (props: {
        modelValue: MerchantFeeCalculatorForm;
        "onUpdate:modelValue"?: (value: MerchantFeeCalculatorForm) => void;
    }) => {
        const { current } = useLocale();
        const isArabic = computed(() => current.value === "ar");
        const update = (patch: Partial<MerchantFeeCalculatorForm>) => {
            props["onUpdate:modelValue"]?.({ ...props.modelValue, ...patch });
        };

        const feeResult = computed<FeeResult>(() => {
            const amount = toDecimal(props.modelValue.amount);
            const commission = amount.times(toDecimal(props.modelValue.commission)).dividedBy(100);
            let customerTotal = amount;
            let netToWallet = amount;
            let payerShare = toDecimal(0);
            if (props.modelValue.feeBearer === "MERCHANT_ABSORBS") {
                customerTotal = amount;
                netToWallet = amount.minus(commission);
            } else if (props.modelValue.feeBearer === "PAYER_SURCHARGE") {
                payerShare = commission;
                customerTotal = amount.plus(commission);
                netToWallet = amount;
            } else {
                payerShare = commission.times(toDecimal(props.modelValue.platformShare)).dividedBy(100);
                customerTotal = amount.plus(payerShare);
                netToWallet = amount.minus(commission.minus(payerShare));
            }
            const gatewayFee = customerTotal.times(toDecimal(props.modelValue.gatewayFee)).dividedBy(100);
            return { customerTotal, commission, gatewayFee, netToWallet, payerShare };
        });

        const feeRows = computed<{ label: string; value: Decimal }[]>(() => {
            const result = feeResult.value;
            const rows: { label: string; value: Decimal }[] = [
                { label: isArabic.value ? "ما يدفعه عميلك عند الدفع" : "What your customer pays at checkout", value: result.customerTotal },
                { label: isArabic.value ? "عمولة المنصة" : "Platform commission", value: result.commission },
                { label: isArabic.value ? "رسم البوابة (تقديري)" : "Gateway fee (estimated)", value: result.gatewayFee },
                { label: isArabic.value ? "صافي LYD الذي يُضاف لمحفظتك" : "Exact net LYD credited to your wallet", value: result.netToWallet },
            ];
            if (props.modelValue.feeBearer === "SPLIT") {
                rows.splice(1, 0, {
                    label: isArabic.value ? "حصة الدافع (رسم إضافي)" : "Payer share (surcharge)",
                    value: result.payerShare,
                });
            }
            return rows;
        });

        const feeBearerTabs = computed(() => [
            { value: "MERCHANT_ABSORBS", label: isArabic.value ? "التاجر يتحمل" : "Merchant absorbs" },
            { value: "PAYER_SURCHARGE", label: isArabic.value ? "رسم على الدافع" : "Payer surcharge" },
            { value: "SPLIT", label: isArabic.value ? "تقسيم" : "Split" },
        ]);

        return () => (
            <SurfaceCard
                title={isArabic.value ? "حاسبة الرسوم وصافي التسوية" : "Fee & net settlement calculator"}
                subtitle={
                    isArabic.value
                        ? "نفس نموذج متحمل الرسوم المستخدم في صفحة الدفع، محسوب بـ decimal.js."
                        : "The same fee-bearer model used by checkout, calculated with decimal.js."
                }
            >
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                    <div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: "12px" }}>
                        <div style={{ minWidth: "170px", flex: "1 1 170px" }}>
                            <FormField label={isArabic.value ? "المبلغ" : "Amount"} required>
                                <VTextField
                                    type="number"
                                    modelValue={props.modelValue.amount}
                                    onUpdate:modelValue={(value: string) => update({ amount: value })}
                                    suffix="LYD"
                                    hideDetails
                                />
                            </FormField>
                        </div>
                        <div style={{ minWidth: "190px", flex: "1 1 190px" }}>
                            <FormField label={isArabic.value ? "السكة" : "Rail"} required>
                                <VSelect
                                    items={RAIL_CODES.map((code) => ({ title: code, value: code }))}
                                    modelValue={props.modelValue.rail}
                                    onUpdate:modelValue={(value: string) => update({ rail: value })}
                                    hideDetails
                                />
                            </FormField>
                        </div>
                        <div style={{ minWidth: "150px", flex: "1 1 150px" }}>
                            <FormField label={isArabic.value ? "العمولة" : "Commission"} required>
                                <VTextField
                                    type="number"
                                    modelValue={props.modelValue.commission}
                                    onUpdate:modelValue={(value: string) => update({ commission: value })}
                                    suffix="%"
                                    hideDetails
                                />
                            </FormField>
                        </div>
                        <div style={{ minWidth: "150px", flex: "1 1 150px" }}>
                            <FormField label={isArabic.value ? "رسم البوابة" : "Gateway fee"} required>
                                <VTextField
                                    type="number"
                                    modelValue={props.modelValue.gatewayFee}
                                    onUpdate:modelValue={(value: string) => update({ gatewayFee: value })}
                                    suffix="%"
                                    hideDetails
                                />
                            </FormField>
                        </div>
                        {props.modelValue.feeBearer === "SPLIT" ? (
                            <div style={{ minWidth: "150px", flex: "1 1 150px" }}>
                                <FormField label={isArabic.value ? "حصة المنصة" : "Platform share"} required>
                                    <VTextField
                                        type="number"
                                        modelValue={props.modelValue.platformShare}
                                        onUpdate:modelValue={(value: string) => update({ platformShare: value })}
                                        suffix="%"
                                        hideDetails
                                    />
                                </FormField>
                            </div>
                        ) : null}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <span style={{ fontSize: "13px", color: "var(--pg-ink-secondary)" }}>
                            {isArabic.value ? "متحمل الرسوم" : "Fee bearer"}
                        </span>
                        <SegmentedTabs
                            modelValue={props.modelValue.feeBearer}
                            tabs={feeBearerTabs.value}
                            ariaLabel={isArabic.value ? "متحمل الرسوم" : "Fee bearer"}
                            onUpdate:modelValue={(value: string) => update({ feeBearer: value as FeeBearer })}
                        />
                    </div>
                    <DescriptionList
                        ariaLabel={isArabic.value ? "نتائج الرسوم" : "Fee results"}
                        items={feeRows.value.map((row) => ({
                            label: row.label,
                            value: row.value.toString(),
                            money: true,
                            currency: "LYD",
                        }))}
                    />
                    <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)", maxWidth: "760px", lineHeight: 1.55 }}>
                        {isArabic.value
                            ? "رسم البوابة تقديري على إجمالي العميل ويُعرض للشفافية؛ إضافة المحفظة تتبع معادلة متحمل الرسوم المختار."
                            : "Gateway fee is estimated on the customer total for this rail and is shown for transparency; the wallet credit follows the selected fee-bearer formula."}
                    </span>
                </div>
            </SurfaceCard>
        );
    },
    { props: ["modelValue", "onUpdate:modelValue"] as any },
);

export default MerchantFeeCalculator;
