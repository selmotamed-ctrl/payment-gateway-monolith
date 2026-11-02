import { dc } from "kt-dc";
import { useLocale } from "vuetify";
import { VAlert, VBtn } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { statusTone } from "@/components/Table/statusTone";
import { formatDateTime, formatMoney } from "../merchantHelp";
import type { MerchantTransaction } from "../types";

import { FormModal } from "@/components/ui/FormModal";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { MonoRef } from "@/components/ui/MonoRef";

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
                <FormModal
                modelValue={props.open}
                onUpdate:modelValue={(value: boolean) => props.onUpdate(value)}
                title={t("Transaction detail")}
                size="lg"
            >
<ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
                                <ThemedView style={{ gap: "4px" }}>
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
                                <ThemedView style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Payment")}</ThemedText>
                                    <DescriptionList
                                        items={[
                                            { label: t("Created"), value: formatDateTime(tx.createdAt) },
                                            { label: t("Terminal"), value: formatDateTime(tx.terminalAt) },
                                            {
                                                label: t("Application"),
                                                value: (
                                                    <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                                                        <span>{tx.application.name}</span>
                                                        <MonoRef value={tx.application.id} truncate={14} />
                                                    </ThemedView>
                                                ),
                                            },
                                            { label: t("Rail"), value: `${tx.rail.code} · ${tx.rail.nameEn}` },
                                            { label: t("Gateway"), value: `${tx.gateway.code} · ${tx.gateway.name}` },
                                            { label: t("Link key"), value: <MonoRef value={tx.link?.key ?? ""} /> },
                                            { label: t("Ledger entry"), value: <MonoRef value={tx.ledgerEntryId ?? ""} /> },
                                        ]}
                                    />
                                </ThemedView>
                                <ThemedView style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Amounts and references")}</ThemedText>
                                    <DescriptionList
                                        items={[
                                            { label: t("Requested"), value: formatMoney(tx.requestedAmount, currency) },
                                            { label: t("Surcharge"), value: formatMoney(tx.surchargeAmount, currency) },
                                            { label: t("Total charged"), value: formatMoney(tx.totalChargedAmount, currency) },
                                            { label: t("Settled"), value: formatMoney(tx.settledAmount, currency) },
                                            { label: t("Gateway fee"), value: formatMoney(tx.gatewayFeeAmount, currency) },
                                            { label: t("Platform commission"), value: formatMoney(tx.platformCommissionAmount, currency) },
                                            { label: t("Net to merchant"), value: formatMoney(tx.netMerchantAmount, currency) },
                                            { label: t("Provider reference"), value: <MonoRef value={tx.providerReference ?? ""} /> },
                                            { label: t("Network reference"), value: <MonoRef value={tx.networkReference ?? ""} /> },
                                            { label: t("Gateway reference"), value: <MonoRef value={tx.gatewayReference ?? ""} /> },
                                        ]}
                                    />
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
            </FormModal>
            );
        };
    },
    {
        props: ["open", "transaction", "canInquire", "onUpdate", "onInquire", "onOpenCase"],
    },
);

export default MerchantTransactionDialog;
