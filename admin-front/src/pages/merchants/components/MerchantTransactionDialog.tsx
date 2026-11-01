import { dc } from "kt-dc";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VCard, VCardText, VDialog } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { statusTone } from "@/components/Table/statusTone";
import { formatDateTime, formatMoney } from "../merchantHelp";
import type { MerchantTransaction } from "../types";

const Row = (props: { label: string; value: string; copy?: boolean; ltr?: boolean }) => (
    <ThemedView style={{ flexDirection: "row", gap: "12px", alignItems: "flex-start", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "6px" }}>
        <ThemedText style={{ fontSize: "12px", opacity: 0.62, minWidth: "150px" }}>{props.label}</ThemedText>
        <ThemedText
            style={{ fontSize: "12px", wordBreak: "break-word", direction: props.ltr ? "ltr" : undefined, cursor: props.copy && props.value ? "copy" : undefined }}
            onClick={() => {
                if (!props.copy || !props.value || props.value === "—") return;
                void navigator.clipboard?.writeText(props.value);
            }}
        >
            {props.value || "—"}
        </ThemedText>
    </ThemedView>
);

const MerchantTransactionDialog = dc(
    (props: {
        open: boolean;
        transaction: MerchantTransaction | null;
        canInquire: boolean;
        onUpdate: (open: boolean) => void;
        onInquire: (transaction: MerchantTransaction) => void;
        onOpenCase?: (caseId: string) => void;
    }) => {
        const { t } = useLocale();
        return () => {
            const tx = props.transaction;
            if (!tx) return <></>;
            const currency = tx.currency;
            return (
                <VDialog modelValue={props.open} onUpdate:modelValue={(value: boolean) => props.onUpdate(value)} maxWidth="980px" scrollable>
                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
                                <ThemedView style={{ gap: "4px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>{t("Transaction detail")}</ThemedText>
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.65, direction: "ltr" }}>{tx.reference}</ThemedText>
                                </ThemedView>
                                <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                    <StatusChip label={tx.status} tone={statusTone(tx.status)} />
                                    <StatusChip label={tx.env} tone={tx.env === "LIVE" ? "warning" : "info"} size="small" />
                                    <StatusChip label={tx.mode} tone="neutral" size="small" />
                                </ThemedView>
                            </ThemedView>

                            {tx.redactedFields.length > 0 && (
                                <VAlert type="info" variant="tonal">
                                    {t("Some transaction fields are restricted for your role.")}
                                </VAlert>
                            )}

                            <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px" }}>
                                <ThemedView style={{ gap: "6px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Payment")}</ThemedText>
                                    <Row label={t("Created")} value={formatDateTime(tx.createdAt)} />
                                    <Row label={t("Terminal")} value={formatDateTime(tx.terminalAt)} />
                                    <Row label={t("Application")} value={`${tx.application.name} (${tx.application.id})`} ltr />
                                    <Row label={t("Rail")} value={`${tx.rail.code} · ${tx.rail.nameEn}`} />
                                    <Row label={t("Gateway")} value={`${tx.gateway.code} · ${tx.gateway.name}`} />
                                    <Row label={t("Link key")} value={tx.link?.key ?? "—"} ltr copy />
                                    <Row label={t("Ledger entry")} value={tx.ledgerEntryId ?? "—"} ltr copy />
                                </ThemedView>
                                <ThemedView style={{ gap: "6px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Amounts and references")}</ThemedText>
                                    <Row label={t("Requested")} value={formatMoney(tx.requestedAmount, currency)} />
                                    <Row label={t("Surcharge")} value={formatMoney(tx.surchargeAmount, currency)} />
                                    <Row label={t("Total charged")} value={formatMoney(tx.totalChargedAmount, currency)} />
                                    <Row label={t("Settled")} value={formatMoney(tx.settledAmount, currency)} />
                                    <Row label={t("Gateway fee")} value={formatMoney(tx.gatewayFeeAmount, currency)} />
                                    <Row label={t("Platform commission")} value={formatMoney(tx.platformCommissionAmount, currency)} />
                                    <Row label={t("Net to merchant")} value={formatMoney(tx.netMerchantAmount, currency)} />
                                    <Row label={t("Provider reference")} value={tx.providerReference ?? "—"} ltr copy />
                                    <Row label={t("Network reference")} value={tx.networkReference ?? "—"} ltr copy />
                                    <Row label={t("Gateway reference")} value={tx.gatewayReference ?? "—"} ltr copy />
                                </ThemedView>
                            </ThemedView>

                            <ThemedView style={{ gap: "6px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Operator cases")}</ThemedText>
                                {tx.operatorCases.length === 0 && <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No operator case linked")}</ThemedText>}
                                {tx.operatorCases.map((operatorCase) => (
                                    <ThemedView key={operatorCase.id} style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                        <StatusChip label={operatorCase.state} tone={statusTone(operatorCase.state)} size="x-small" />
                                        <StatusChip label={operatorCase.priority} tone={statusTone(operatorCase.priority)} size="x-small" />
                                        <ThemedText style={{ fontSize: "12px" }}>{operatorCase.kind} · {formatDateTime(operatorCase.slaDueAt)}</ThemedText>
                                        <VBtn size="x-small" variant="text" onClick={() => props.onOpenCase?.(operatorCase.id)}>{t("Open case")}</VBtn>
                                    </ThemedView>
                                ))}
                            </ThemedView>

                            <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                                {props.canInquire && ["UNKNOWN", "VERIFYING"].includes(tx.status) && (
                                    <VBtn variant="tonal" prependIcon="mdi-radar" onClick={() => props.onInquire(tx)}>{t("Schedule inquiry")}</VBtn>
                                )}
                                <VBtn variant="text" onClick={() => props.onUpdate(false)}>{t("Close")}</VBtn>
                            </ThemedView>
                        </VCardText>
                    </VCard>
                </VDialog>
            );
        };
    },
    {
        props: ["open", "transaction", "canInquire", "onUpdate", "onInquire", "onOpenCase"],
    },
);

export default MerchantTransactionDialog;
