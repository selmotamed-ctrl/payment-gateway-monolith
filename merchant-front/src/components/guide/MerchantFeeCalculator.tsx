import { dc } from "kt-dc";
import { computed } from "vue";
import type Decimal from "decimal.js";
import { useLocale } from "vuetify";
import { VBtn, VBtnToggle, VCard, VCardText, VSelect, VTextField } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { MoneyText } from "@/components/MoneyText";
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

        return () => (
            <VCard>
                <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                    <ThemedView style={{ gap: "4px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                            {isArabic.value ? "حاسبة الرسوم وصافي التسوية" : "Fee & net settlement calculator"}
                        </ThemedText>
                        <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                            {isArabic.value
                                ? "نفس نموذج متحمل الرسوم المستخدم في صفحة الدفع، محسوب بـ decimal.js."
                                : "The same fee-bearer model used by checkout, calculated with decimal.js."}
                        </ThemedText>
                    </ThemedView>
                    <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "12px" }}>
                        <VTextField
                            label={isArabic.value ? "المبلغ" : "Amount"}
                            type="number"
                            modelValue={props.modelValue.amount}
                            onUpdate:modelValue={(value: string) => update({ amount: value })}
                            suffix="LYD"
                            style={{ minWidth: "170px", flex: "1 1 170px" }}
                        />
                        <VSelect
                            label={isArabic.value ? "السكة" : "Rail"}
                            items={RAIL_CODES.map((code) => ({ title: code, value: code }))}
                            modelValue={props.modelValue.rail}
                            onUpdate:modelValue={(value: string) => update({ rail: value })}
                            style={{ minWidth: "190px", flex: "1 1 190px" }}
                        />
                        <VTextField
                            label={isArabic.value ? "العمولة" : "Commission"}
                            type="number"
                            modelValue={props.modelValue.commission}
                            onUpdate:modelValue={(value: string) => update({ commission: value })}
                            suffix="%"
                            style={{ minWidth: "150px", flex: "1 1 150px" }}
                        />
                        <VTextField
                            label={isArabic.value ? "رسم البوابة" : "Gateway fee"}
                            type="number"
                            modelValue={props.modelValue.gatewayFee}
                            onUpdate:modelValue={(value: string) => update({ gatewayFee: value })}
                            suffix="%"
                            style={{ minWidth: "150px", flex: "1 1 150px" }}
                        />
                        {props.modelValue.feeBearer === "SPLIT" ? (
                            <VTextField
                                label={isArabic.value ? "حصة المنصة" : "Platform share"}
                                type="number"
                                modelValue={props.modelValue.platformShare}
                                onUpdate:modelValue={(value: string) => update({ platformShare: value })}
                                suffix="%"
                                style={{ minWidth: "150px", flex: "1 1 150px" }}
                            />
                        ) : null}
                    </ThemedView>
                    <ThemedView style={{ gap: "8px" }}>
                        <ThemedText style={{ fontSize: "13px", opacity: 0.72 }}>{isArabic.value ? "متحمل الرسوم" : "Fee bearer"}</ThemedText>
                        <VBtnToggle
                            mandatory
                            divided
                            modelValue={props.modelValue.feeBearer}
                            onUpdate:modelValue={(value: FeeBearer | null) => {
                                if (value) update({ feeBearer: value });
                            }}
                            style={{ maxWidth: "700px" }}
                        >
                            <VBtn value="MERCHANT_ABSORBS" size="small">{isArabic.value ? "التاجر يتحمل" : "Merchant absorbs"}</VBtn>
                            <VBtn value="PAYER_SURCHARGE" size="small">{isArabic.value ? "رسم على الدافع" : "Payer surcharge"}</VBtn>
                            <VBtn value="SPLIT" size="small">{isArabic.value ? "تقسيم" : "Split"}</VBtn>
                        </VBtnToggle>
                    </ThemedView>
                    <div style={{ overflowX: "auto", maxWidth: "760px" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                            <tbody>
                                {feeRows.value.map((row) => (
                                    <tr key={row.label} style={{ borderBottom: "1px solid rgba(100,116,139,0.18)" }}>
                                        <td style={{ padding: "9px 6px", opacity: 0.74 }}>{row.label}</td>
                                        <td style={{ padding: "9px 6px", textAlign: "end", direction: "ltr" }}>
                                            <MoneyText value={row.value} currency="LYD" bold />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <ThemedText style={{ fontSize: "12px", opacity: 0.6, maxWidth: "760px" }}>
                        {isArabic.value
                            ? "رسم البوابة تقديري على إجمالي العميل ويُعرض للشفافية؛ إضافة المحفظة تتبع معادلة متحمل الرسوم المختار."
                            : "Gateway fee is estimated on the customer total for this rail and is shown for transparency; the wallet credit follows the selected fee-bearer formula."}
                    </ThemedText>
                </VCardText>
            </VCard>
        );
    },
    { props: ["modelValue", "onUpdate:modelValue"] as any },
);

export default MerchantFeeCalculator;
