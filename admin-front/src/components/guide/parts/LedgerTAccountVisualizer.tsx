import { dc } from "kt-dc";
import { computed, ref } from "vue";
import Decimal from "decimal.js";
import { VBtn, VCard, VCardText, VSelect, VTextField } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";

type Side = "DEBIT" | "CREDIT";
type Line = { account: string; side: Side; amount: Decimal };

const EVENTS = [
    { title: "Payment confirmation (MERCHANT_ABSORBS)", value: "confirm" },
    { title: "T+1 settlement sweep", value: "sweep" },
    { title: "Full refund", value: "refund" },
    { title: "Chargeback reserve", value: "chargeback" },
    { title: "MERCHANT_DIRECT confirmation", value: "direct" },
    { title: "AML hold", value: "aml-hold" },
];

const d = (value: string): Decimal => {
    try {
        return new Decimal(value || "0");
    } catch {
        return new Decimal(0);
    }
};

const money = (value: Decimal): string => value.toFixed(4);

const buildLines = (event: string, amount: Decimal, commission: Decimal, gatewayFee: Decimal): Line[] => {
    switch (event) {
        case "sweep":
            return [
                { account: "TREASURY", side: "DEBIT", amount: amount.minus(gatewayFee) },
                { account: "GATEWAY_FEE_ACCRUAL", side: "DEBIT", amount: gatewayFee },
                { account: "GATEWAY_CLEARING", side: "CREDIT", amount },
            ];
        case "refund":
            return [
                { account: "MERCHANT_WALLET", side: "DEBIT", amount: amount.minus(commission) },
                { account: "PLATFORM_INCOME", side: "DEBIT", amount: commission },
                { account: "GATEWAY_CLEARING", side: "CREDIT", amount },
            ];
        case "chargeback":
            return [
                { account: "MERCHANT_WALLET", side: "DEBIT", amount: amount.minus(commission) },
                { account: "PLATFORM_INCOME", side: "DEBIT", amount: commission },
                { account: "CHARGEBACK_RESERVE", side: "CREDIT", amount },
            ];
        case "direct":
            return [
                { account: "COMMISSION_RECEIVABLE", side: "DEBIT", amount: commission },
                { account: "PLATFORM_INCOME", side: "CREDIT", amount: commission },
            ];
        case "aml-hold":
            return [
                { account: "GATEWAY_CLEARING", side: "DEBIT", amount },
                { account: "AML_HOLD", side: "CREDIT", amount },
            ];
        case "confirm":
        default:
            return [
                { account: "GATEWAY_CLEARING", side: "DEBIT", amount },
                { account: "GATEWAY_FEE_EXPENSE", side: "DEBIT", amount: gatewayFee },
                { account: "MERCHANT_WALLET", side: "CREDIT", amount: amount.minus(commission) },
                { account: "PLATFORM_INCOME", side: "CREDIT", amount: commission },
                { account: "GATEWAY_FEE_ACCRUAL", side: "CREDIT", amount: gatewayFee },
            ];
    }
};

export const LedgerTAccountVisualizer = dc(() => {
    const event = ref("confirm");
    const amountInput = ref("100.0000");
    const commissionPercent = ref("3");
    const gatewayFeeInput = ref("0.8000");

    const amount = computed(() => d(amountInput.value));
    const commission = computed(() => amount.value.times(d(commissionPercent.value)).dividedBy(100));
    const gatewayFee = computed(() => d(gatewayFeeInput.value));
    const lines = computed(() => buildLines(event.value, amount.value, commission.value, gatewayFee.value));
    const debitTotal = computed(() => lines.value.filter((line) => line.side === "DEBIT").reduce((sum, line) => sum.plus(line.amount), new Decimal(0)));
    const creditTotal = computed(() => lines.value.filter((line) => line.side === "CREDIT").reduce((sum, line) => sum.plus(line.amount), new Decimal(0)));
    const balanced = computed(() => debitTotal.value.equals(creditTotal.value));

    return () => (
        <VCard variant="outlined">
            <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <VSelect
                    modelValue={event.value}
                    onUpdate:modelValue={(value: string | null) => (event.value = value ?? "confirm")}
                    items={EVENTS}
                    label="Business event"
                />
                <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                    <VTextField
                        modelValue={amountInput.value}
                        onUpdate:modelValue={(value: string) => (amountInput.value = value ?? "")}
                        label="Amount (LYD)"
                        type="number"
                        style={{ flex: "1 1 160px" }}
                    />
                    <VTextField
                        modelValue={commissionPercent.value}
                        onUpdate:modelValue={(value: string) => (commissionPercent.value = value ?? "")}
                        label="Commission %"
                        type="number"
                        style={{ flex: "1 1 140px" }}
                    />
                    <VTextField
                        modelValue={gatewayFeeInput.value}
                        onUpdate:modelValue={(value: string) => (gatewayFeeInput.value = value ?? "")}
                        label="Gateway fee (LYD)"
                        type="number"
                        style={{ flex: "1 1 160px" }}
                    />
                </ThemedView>
                <ThemedView style={{ flexDirection: "row", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                    <StatusChip label={balanced.value ? "SUM(DEBIT) == SUM(CREDIT)" : "DR ≠ CR"} tone={balanced.value ? "success" : "error"} />
                    <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>
                        {`DR ${money(debitTotal.value)} · CR ${money(creditTotal.value)}`}
                    </ThemedText>
                </ThemedView>
                <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                        <thead>
                            <tr>
                                <th style={{ textAlign: "start", padding: "8px 6px" }}>GL Account</th>
                                <th style={{ textAlign: "start", padding: "8px 6px" }}>Side</th>
                                <th style={{ textAlign: "end", padding: "8px 6px" }}>Amount</th>
                            </tr>
                        </thead>
                        <tbody>
                            {lines.value.map((line, index) => (
                                <tr key={`${line.account}-${line.side}-${index}`} style={{ borderTop: "1px solid rgba(100,116,139,0.18)" }}>
                                    <td style={{ padding: "8px 6px", fontWeight: 600 }}>{line.account}</td>
                                    <td style={{ padding: "8px 6px" }}>
                                        <StatusChip label={line.side} tone={line.side === "DEBIT" ? "primary" : "warning"} size="x-small" />
                                    </td>
                                    <td style={{ padding: "8px 6px", textAlign: "end", direction: "ltr" }}>{money(line.amount)}</td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot>
                            <tr style={{ borderTop: "2px solid rgba(100,116,139,0.35)", fontWeight: 700 }}>
                                <td style={{ padding: "8px 6px" }}>Total</td>
                                <td style={{ padding: "8px 6px" }}>{balanced.value ? "Balanced" : "Unbalanced"}</td>
                                <td style={{ padding: "8px 6px", textAlign: "end", direction: "ltr" }}>
                                    {`Dr ${money(debitTotal.value)} / Cr ${money(creditTotal.value)}`}
                                </td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
                <VBtn size="small" variant="text" prependIcon="mdi-information-outline" onClick={() => (amountInput.value = "100.0000")}>
                    Reset example to 100.0000 LYD
                </VBtn>
            </VCardText>
        </VCard>
    );
});

export default LedgerTAccountVisualizer;
