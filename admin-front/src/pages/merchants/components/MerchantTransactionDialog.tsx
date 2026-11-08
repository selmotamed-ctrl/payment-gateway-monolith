import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VAlert, VBtn } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { statusTone } from "@/components/Table/statusTone";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";
import { DescriptionList, type DescriptionItem } from "@/components/ui/DescriptionList";
import { MonoRef } from "@/components/ui/MonoRef";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { MetaPill } from "@/components/ui/MetaPill";
import { JournalEntryDrawer } from "@/components/ledger/JournalEntryDrawer";
import { LedgerRefLink } from "@/components/ledger/LedgerRefLink";
import { formatDateTime } from "@/components/ledger/format";
import { ApplicationDetailDrawer } from "./ApplicationDetailDrawer";
import InboundEventDrawer from "@/pages/transactions/components/InboundEventDrawer";
import { PayloadRows, payloadPropsOfText, sectionTitleKey } from "@/pages/transactions/components/PayloadRows";
import { flattenPayload, formatDuration, httpStatusTone, sectionsOfRequest } from "@/pages/transactions/payloadRows";
import { buildRetryGroupView, footerActionsFor, outcomeGroupOf } from "@/pages/transactions/lifecycle";
import type { AttemptDetail, StepLogRow } from "@/pages/transactions/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { hasOneOfAuthorities } from "@/state/user";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import type { MerchantTransaction } from "../types";

type TabKey = "summary" | "steps" | "webhooks" | "group";

const MerchantTransactionDialog = dc(
    (props: {
        open: boolean;
        /** Row the merchant 360 / transactions table already has (shown while the detail loads). */
        transaction?: MerchantTransaction | null;
        /** Attempt id when no row is at hand (global transactions page, deep links). */
        attemptId?: string | null;
        canInquire?: boolean;
        onUpdate: (open: boolean) => void;
        /** When given and the root attempt is shown, the parent owns the inquiry (and its refresh). */
        onInquire?: (transaction: MerchantTransaction) => void;
        onOpenCase?: (caseId: string) => void;
        /** Called after an action changed the attempt (inquiry scheduled). */
        onChanged?: () => void;
    }) => {
        const { t } = useLocale();
        const router = useRouter();
        const badgeTone = (tone: ReturnType<typeof statusTone>): BadgeTone => (tone === "error" ? "danger" : tone === "primary" ? "info" : tone);

        const detail = ref<AttemptDetail | null>(null);
        const loading = ref(false);
        const error = ref<string | null>(null);
        const tab = ref<TabKey>("summary");
        const activeId = ref<string | null>(null);
        const expandedSteps = ref<Set<string>>(new Set());
        const journalEntryId = ref<string | null>(null);
        const applicationId = ref<string | null>(null);
        const inboundEventId = ref<string | null>(null);
        const inquiring = ref(false);
        let requestSeq = 0;

        const rootId = () => props.attemptId ?? props.transaction?.id ?? null;

        const load = async (id: string) => {
            const seq = ++requestSeq;
            loading.value = true;
            error.value = null;
            try {
                const response = await api.get(urlsMap.attemptDetail(id));
                if (seq !== requestSeq) return;
                detail.value = (response.data?.data ?? response.data) as AttemptDetail;
            } catch (cause) {
                if (seq !== requestSeq) return;
                detail.value = null;
                error.value = extractApiErrorMessage(cause);
            } finally {
                if (seq === requestSeq) loading.value = false;
            }
        };

        // Opening (or switching to another attempt) always starts on the summary with fresh data.
        watch(
            () => [props.open, rootId()] as const,
            ([open, id]) => {
                if (open && id) {
                    activeId.value = id;
                    tab.value = "summary";
                    expandedSteps.value = new Set();
                    detail.value = null;
                    void load(id);
                } else if (!open) {
                    requestSeq += 1;
                    journalEntryId.value = null;
                    applicationId.value = null;
                    inboundEventId.value = null;
                }
            },
            { immediate: true },
        );

        const switchAttempt = (id: string) => {
            if (id === activeId.value) return;
            activeId.value = id;
            tab.value = "summary";
            expandedSteps.value = new Set();
            detail.value = null;
            void load(id);
        };

        const isRoot = computed(() => activeId.value !== null && activeId.value === rootId());
        const redacted = (field: string): boolean => detail.value?.redactedFields.includes(field) === true;
        const attemptStatus = computed(() => detail.value?.attempt.status ?? (isRoot.value ? props.transaction?.status : undefined) ?? "");

        const canInquirePermission = computed(() => props.canInquire ?? hasOneOfAuthorities(["attempt:inquire"]));
        const footerActions = computed(() =>
            footerActionsFor({
                status: attemptStatus.value,
                canInquire: canInquirePermission.value,
                canAdjust: hasOneOfAuthorities(["finance:write"]),
                canDispute: hasOneOfAuthorities(["dispute:write"]),
                inquiryEligible: isRoot.value ? props.transaction?.inquiryEligible : undefined,
            }),
        );

        const close = () => props.onUpdate(false);

        const inquire = async () => {
            const id = activeId.value;
            if (!id || inquiring.value) return;
            if (props.onInquire && props.transaction && isRoot.value) {
                props.onInquire(props.transaction);
                return;
            }
            inquiring.value = true;
            try {
                await api.post(urlsMap.attemptInquire(id), {});
                showSnackBar({ type: "success", message: t("Attempt inquiry scheduled") });
                props.onChanged?.();
                await load(id);
            } catch (cause) {
                showSnackBar({ type: "error", message: extractApiErrorMessage(cause) });
            } finally {
                inquiring.value = false;
            }
        };

        const goTo = (location: Parameters<typeof router.push>[0]) => {
            close();
            void router.push(location);
        };

        const restricted = () => <span style={{ color: "var(--pg-ink-faint)", fontSize: "12.5px" }}>{t("Restricted")}</span>;
        const money = (value: string | null | undefined, currency: string, hiddenField = "amounts") =>
            redacted(hiddenField) ? restricted() : <MoneyDisplay amount={value ?? null} currency={currency} />;
        const reference = (value: string | null | undefined, hiddenField: string) => (redacted(hiddenField) ? restricted() : <MonoRef value={value ?? ""} />);

        const sectionHeading = (label: string) => (
            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>
                {label}
            </ThemedText>
        );

        // ------------------------------------------------------------------ summary tab
        const summaryTab = (data: AttemptDetail) => {
            const attempt = data.attempt;
            const currency = attempt.currency;
            const paymentItems: DescriptionItem[] = [
                { label: t("Created"), value: formatDateTime(attempt.createdAt) },
                { label: t("Terminal"), value: formatDateTime(attempt.terminalAt) },
                { label: t("Expires"), value: formatDateTime(attempt.expiresAt) },
                {
                    label: t("Merchant"),
                    value: (
                        <LedgerRefLink
                            value={data.merchant.id}
                            truncate={14}
                            label={t("Open merchant")}
                            onOpen={() => goTo({ name: "MerchantDetail", params: { id: data.merchant.id } })}
                        />
                    ),
                },
                {
                    label: t("Application"),
                    value: (
                        <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                            <span>{data.application.name}</span>
                            <LedgerRefLink value={data.application.id} truncate={14} label={t("Open application")} onOpen={() => (applicationId.value = data.application.id)} />
                        </ThemedView>
                    ),
                },
                { label: t("Rail"), value: `${data.rail.code} · ${data.rail.nameEn}` },
                { label: t("Gateway"), value: `${data.gateway.code} · ${data.gateway.name}` },
                { label: t("Link key"), value: <MonoRef value={attempt.link?.key ?? ""} /> },
                {
                    label: t("Ledger entry"),
                    value: redacted("ledgerEntryId") ? (
                        restricted()
                    ) : (
                        <LedgerRefLink value={attempt.ledgerEntryId ?? ""} truncate={14} label={t("Open journal entry")} onOpen={(id: string) => (journalEntryId.value = id)} />
                    ),
                },
                { label: t("Fee bearer"), value: attempt.feeBearer ?? "—" },
                { label: t("Settlement target"), value: attempt.settlementTarget ?? "—" },
            ];
            const amountItems: DescriptionItem[] = [
                { label: t("Requested"), value: money(attempt.requestedAmount, currency) },
                { label: t("Surcharge"), value: money(attempt.surchargeAmount, currency) },
                { label: t("Total charged"), value: money(attempt.totalChargedAmount, currency) },
                { label: t("Settled"), value: money(attempt.settledAmount, currency) },
                { label: t("Gateway fee"), value: money(attempt.gatewayFeeAmount, currency) },
                { label: t("Platform commission"), value: money(attempt.platformCommissionAmount, currency) },
                { label: t("Net to merchant"), value: money(attempt.netMerchantAmount, currency) },
                { label: t("Provider reference"), value: reference(attempt.providerReference, "providerReference") },
                { label: t("Network reference"), value: reference(attempt.networkReference, "networkReference") },
                { label: t("Gateway reference"), value: reference(attempt.gatewayReference, "gatewayReference") },
            ];
            const customer = flattenPayload(attempt.customerFieldsMasked ?? {});
            return (
                <ThemedView style={{ gap: "18px" }}>
                    {attempt.substatus && (
                        <VAlert type="info" variant="tonal" density="compact">
                            {attempt.substatus}
                        </VAlert>
                    )}
                    <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px" }}>
                        <ThemedView style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                            {sectionHeading(t("Payment"))}
                            <DescriptionList items={paymentItems} />
                        </ThemedView>
                        <ThemedView style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                            {sectionHeading(t("Amounts and references"))}
                            <DescriptionList items={amountItems} />
                        </ThemedView>
                    </ThemedView>

                    <ThemedView style={{ gap: "6px" }}>
                        {sectionHeading(t("Customer fields (masked)"))}
                        <PayloadRows rows={customer.rows} truncated={customer.truncated} emptyLabel={t("No customer fields recorded")} />
                    </ThemedView>

                    <ThemedView style={{ gap: "6px" }}>
                        {sectionHeading(t("Operator cases"))}
                        {data.operatorCases.length === 0 && <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No operator case linked")}</ThemedText>}
                        {data.operatorCases.map((operatorCase) => (
                            <ThemedView key={operatorCase.id} style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                <StatusBadge status={operatorCase.state} label={operatorCase.state} toneOverride={badgeTone(statusTone(operatorCase.state))} />
                                <StatusBadge status={operatorCase.priority} label={operatorCase.priority} toneOverride={badgeTone(statusTone(operatorCase.priority))} />
                                <ThemedText style={{ fontSize: "12px" }}>
                                    {operatorCase.kind} · {formatDateTime(operatorCase.slaDueAt)}
                                </ThemedText>
                                <VBtn
                                    size="x-small"
                                    variant="text"
                                    onClick={() => {
                                        if (props.onOpenCase) props.onOpenCase(operatorCase.id);
                                        else goTo({ name: "OperatorCaseDetail", params: { id: operatorCase.id } });
                                    }}
                                >
                                    {t("Open case")}
                                </VBtn>
                            </ThemedView>
                        ))}
                    </ThemedView>

                    <ThemedView style={{ gap: "6px" }}>
                        {sectionHeading(t("Disputes"))}
                        {data.disputes.length === 0 && <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No dispute linked")}</ThemedText>}
                        {data.disputes.map((dispute) => (
                            <ThemedView key={dispute.id} style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                <StatusBadge status={dispute.status} label={dispute.status} toneOverride={badgeTone(statusTone(dispute.status))} />
                                {redacted("amounts") ? restricted() : <MoneyDisplay amount={dispute.disputedAmount} currency={currency} size="sm" />}
                                <ThemedText style={{ fontSize: "12px" }}>
                                    {dispute.reasonCode ?? "—"} · {formatDateTime(dispute.createdAt)}
                                </ThemedText>
                                <VBtn size="x-small" variant="text" onClick={() => goTo({ name: "Disputes", query: { open: dispute.id } })}>
                                    {t("Open dispute")}
                                </VBtn>
                            </ThemedView>
                        ))}
                    </ThemedView>

                    <ThemedView style={{ gap: "6px" }}>
                        {sectionHeading(t("Adjustments"))}
                        {data.adjustments.length === 0 && <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No adjustment linked")}</ThemedText>}
                        {data.adjustments.map((adjustment) => (
                            <ThemedView key={adjustment.id} style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                <StatusBadge status={adjustment.type} label={adjustment.type} showDot={false} />
                                <StatusBadge status={adjustment.state} label={adjustment.state} toneOverride={badgeTone(statusTone(adjustment.state))} />
                                {redacted("amounts") ? restricted() : <MoneyDisplay amount={adjustment.amount} currency={currency} size="sm" />}
                                {adjustment.journalEntryId && <LedgerRefLink value={adjustment.journalEntryId} truncate={12} label={t("Open journal entry")} onOpen={(id: string) => (journalEntryId.value = id)} />}
                                <VBtn size="x-small" variant="text" onClick={() => goTo({ name: "Adjustments", query: { open: adjustment.id } })}>
                                    {t("Open adjustment")}
                                </VBtn>
                            </ThemedView>
                        ))}
                    </ThemedView>
                </ThemedView>
            );
        };

        // ------------------------------------------------------------------ step logs tab
        const toggleStep = (id: string) => {
            const next = new Set(expandedSteps.value);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            expandedSteps.value = next;
        };

        const stepCard = (log: StepLogRow) => {
            const open = expandedSteps.value.has(log.id);
            const sections = open ? sectionsOfRequest(log.redactedRequestJson) : [];
            const response = open ? payloadPropsOfText(log.redactedResponseText) : null;
            return (
                <div key={log.id} style={{ border: "1px solid var(--pg-border-subtle)", borderRadius: "var(--pg-radius-sm)", overflow: "hidden" }}>
                    <button
                        type="button"
                        aria-expanded={open ? "true" : "false"}
                        onClick={() => toggleStep(log.id)}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            flexWrap: "wrap",
                            inlineSize: "100%",
                            padding: "8px 12px",
                            border: 0,
                            textAlign: "start",
                            backgroundColor: open ? "var(--pg-bg-surface-subtle)" : "var(--pg-bg-surface)",
                            cursor: "pointer",
                            fontFamily: "inherit",
                            color: "var(--pg-ink-primary)",
                        }}
                    >
                        <span class="pg-tabular" style={{ fontSize: "11.5px", color: "var(--pg-ink-muted)" }}>#{log.stepOrder}</span>
                        <StatusBadge status={log.phase} label={log.phase} showDot={false} />
                        <span class="pg-mono" style={{ fontSize: "12px" }}>{log.stepId ?? "—"}</span>
                        <span style={{ flex: 1 }} />
                        {log.httpStatus !== null && <StatusBadge status={String(log.httpStatus)} label={`HTTP ${log.httpStatus}`} toneOverride={httpStatusTone(log.httpStatus)} showDot={false} />}
                        <StatusBadge status={log.outcome} label={log.outcome} toneOverride={badgeTone(statusTone(log.outcome))} showDot={false} />
                        <span class="pg-tabular" style={{ fontSize: "11.5px", color: "var(--pg-ink-muted)" }}>{formatDuration(log.durationMs)}</span>
                        <span aria-hidden="true" style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>{open ? "▾" : "▸"}</span>
                    </button>
                    {open && (
                        <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "12px", borderTop: "1px solid var(--pg-border-subtle)" }}>
                            <ThemedText style={{ fontSize: "11.5px", opacity: 0.6 }}>{formatDateTime(log.createdAt)}</ThemedText>
                            {sections.length === 0 && <PayloadRows emptyLabel={t("No request payload recorded")} />}
                            {sections.map((section) => (
                                <div key={section.id} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                    {sectionHeading(t(sectionTitleKey(section.id)))}
                                    <PayloadRows rows={section.rows} truncated={section.truncated} />
                                </div>
                            ))}
                            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                {sectionHeading(t("Response"))}
                                <PayloadRows rows={response?.rows ?? []} truncated={response?.truncated ?? 0} text={response?.text ?? ""} emptyLabel={t("Empty response")} />
                            </div>
                        </div>
                    )}
                </div>
            );
        };

        const stepsTab = (data: AttemptDetail) =>
            data.stepLogs.length === 0 ? (
                <EmptyState title={t("No step logs")} description={t("No gateway steps were recorded for this attempt.")} />
            ) : (
                <ThemedView style={{ gap: "8px" }}>
                    <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{t("Payloads are redacted. Expand a step to read its request and response fields.")}</ThemedText>
                    {data.stepLogs.map(stepCard)}
                </ThemedView>
            );

        // ------------------------------------------------------------------ webhooks tab
        const webhooksTab = (data: AttemptDetail) =>
            data.inboundEvents.length === 0 ? (
                <EmptyState title={t("No inbound webhooks")} description={t("The provider has not called back for this attempt.")} />
            ) : (
                <ThemedView style={{ gap: "8px" }}>
                    {data.inboundEvents.map((event) => (
                        <SurfaceCard key={event.id} onClick={() => void (inboundEventId.value = event.id)}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <StatusBadge status={event.verified ? "VERIFIED" : "UNVERIFIED"} label={event.verified ? t("Signature verified") : t("Signature not verified")} toneOverride={event.verified ? "success" : "danger"} />
                                <ThemedText style={{ fontSize: "12px" }}>{formatDateTime(event.receivedAt)}</ThemedText>
                                <span style={{ flex: 1 }} />
                                <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>{event.processingResult ?? t("Not processed")}</ThemedText>
                            </ThemedView>
                            <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap", marginBlockStart: "6px" }}>
                                <MetaPill size="x-small">{event.gateway.code}</MetaPill>
                                <MetaPill size="x-small">{event.sourceIp}</MetaPill>
                                {event.verificationError && <MetaPill size="x-small" color="error">{event.verificationError}</MetaPill>}
                            </ThemedView>
                        </SurfaceCard>
                    ))}
                </ThemedView>
            );

        // ------------------------------------------------------------------ retry group tab
        const groupTab = (data: AttemptDetail) => {
            if (!data.attemptGroup) return <EmptyState title={t("No retry group")} description={t("This attempt is not part of a checkout retry group.")} />;
            const view = buildRetryGroupView(data.attemptGroup.attempts, data.attempt.id);
            return (
                <ThemedView style={{ gap: "10px" }}>
                    <ThemedText style={{ fontSize: "12.5px" }}>
                        {t("Attempts of the same payer on this payment link")}: {view.attempts.length} · {t("Successful")}: {data.attemptGroup.successCount}
                    </ThemedText>
                    {view.recoveredAfterFailure && (
                        <VAlert type="info" variant="tonal" density="compact">
                            {t("The customer failed on an earlier attempt and then paid successfully on another rail or retry.")}
                        </VAlert>
                    )}
                    {view.attempts.map((entry, index) => {
                        const current = entry.id === data.attempt.id;
                        return (
                            <ThemedView
                                key={entry.id}
                                style={{
                                    flexDirection: "row",
                                    alignItems: "center",
                                    gap: "8px",
                                    flexWrap: "wrap",
                                    padding: "8px 12px",
                                    border: `1px solid ${current ? "var(--pg-accent-interactive)" : "var(--pg-border-subtle)"}`,
                                    borderRadius: "var(--pg-radius-sm)",
                                }}
                            >
                                <span class="pg-tabular" style={{ fontSize: "11.5px", color: "var(--pg-ink-muted)" }}>#{index + 1}</span>
                                <StatusBadge status={entry.status} label={entry.status} toneOverride={badgeTone(statusTone(entry.status))} />
                                {entry.requestedAmount !== undefined && !redacted("amounts") && <MoneyDisplay amount={entry.requestedAmount} currency={data.attempt.currency} size="sm" />}
                                <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>{formatDateTime(entry.createdAt)}</ThemedText>
                                <span style={{ flex: 1 }} />
                                {current ? (
                                    <MetaPill size="x-small" color="info">{t("This attempt")}</MetaPill>
                                ) : (
                                    <LedgerRefLink value={entry.id} truncate={10} label={t("Open attempt")} onOpen={(id: string) => switchAttempt(id)} />
                                )}
                            </ThemedView>
                        );
                    })}
                    {outcomeGroupOf(attemptStatus.value) === "failed" && !view.anySucceeded && (
                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{t("No attempt of this payer has succeeded yet.")}</ThemedText>
                    )}
                </ThemedView>
            );
        };

        const tabs = computed(() => [
            { value: "summary", label: t("Summary") },
            { value: "steps", label: t("Step logs"), count: detail.value?.stepLogs.length },
            { value: "webhooks", label: t("Inbound webhooks"), count: detail.value?.inboundEvents.length },
            { value: "group", label: t("Checkout retry group"), count: detail.value?.attemptGroup ? detail.value.attemptGroup.attempts.length : undefined },
        ]);

        const bodyContent = () => {
            const data = detail.value;
            if (error.value) return <StateView error={error.value} minHeight="200px" onRetry={() => activeId.value && void load(activeId.value)} />;
            if (!data) return <StateView loading minHeight="240px" />;
            const attempt = data.attempt;
            return (
                <ThemedView style={{ gap: "16px" }}>
                    <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                            {!isRoot.value && rootId() && (
                                <VBtn size="x-small" variant="text" prependIcon="mdi-arrow-left" onClick={() => rootId() && switchAttempt(rootId()!)}>
                                    {t("Back to original attempt")}
                                </VBtn>
                            )}
                            <ThemedText style={{ fontSize: "12px", opacity: 0.65, direction: "ltr" }}>{attempt.reference}</ThemedText>
                        </ThemedView>
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                            <StatusBadge status={attempt.status} label={attempt.status} toneOverride={badgeTone(statusTone(attempt.status))} />
                            <StatusBadge status={attempt.env} label={attempt.env} toneOverride={attempt.env === "LIVE" ? "warning" : "info"} />
                            <StatusBadge status={attempt.mode} label={attempt.mode} toneOverride="neutral" />
                        </ThemedView>
                    </ThemedView>

                    {data.redactedFields.length > 0 && (
                        <VAlert type="info" variant="tonal">
                            {t("Some transaction fields are restricted for your role.")}
                        </VAlert>
                    )}

                    <SegmentedTabs modelValue={tab.value} onUpdate:modelValue={(value: string) => (tab.value = value as TabKey)} tabs={tabs.value} ariaLabel={t("Transaction sections")} />

                    {tab.value === "summary" && summaryTab(data)}
                    {tab.value === "steps" && stepsTab(data)}
                    {tab.value === "webhooks" && webhooksTab(data)}
                    {tab.value === "group" && groupTab(data)}
                </ThemedView>
            );
        };

        return () => {
            const id = rootId();
            if (!id) return <></>;
            return (
                <>
                    <SlideOverDrawer
                        modelValue={props.open}
                        onUpdate:modelValue={(value: boolean) => props.onUpdate(value)}
                        title={t("Transaction detail")}
                        subtitle={detail.value?.attempt.reference ?? props.transaction?.reference ?? ""}
                        width={720}
                        v-slots={{
                            default: bodyContent,
                            footer: () => (
                                <>
                                    {footerActions.value.includes("inquire") && (
                                        <VBtn variant="tonal" prependIcon="mdi-radar" loading={inquiring.value} onClick={() => void inquire()}>
                                            {t("Schedule inquiry")}
                                        </VBtn>
                                    )}
                                    {footerActions.value.includes("adjustment") && detail.value && (
                                        <VBtn
                                            variant="tonal"
                                            prependIcon="mdi-cash-refund"
                                            onClick={() => goTo({ name: "Adjustments", query: { attemptId: detail.value!.attempt.id, merchantId: detail.value!.merchant.id } })}
                                        >
                                            {t("Create refund / adjustment")}
                                        </VBtn>
                                    )}
                                    {footerActions.value.includes("dispute") && detail.value && (
                                        <VBtn
                                            variant="tonal"
                                            prependIcon="mdi-gavel"
                                            onClick={() => goTo({ name: "Disputes", query: { attemptId: detail.value!.attempt.id, merchantId: detail.value!.merchant.id } })}
                                        >
                                            {t("Record dispute")}
                                        </VBtn>
                                    )}
                                    <VBtn variant="text" onClick={close}>{t("Close")}</VBtn>
                                </>
                            ),
                        }}
                    />
                    {journalEntryId.value && <JournalEntryDrawer entryId={journalEntryId.value} onClose={() => (journalEntryId.value = null)} />}
                    {applicationId.value && <ApplicationDetailDrawer applicationId={applicationId.value} onClose={() => (applicationId.value = null)} />}
                    {inboundEventId.value && (
                        <InboundEventDrawer
                            eventId={inboundEventId.value}
                            onClose={() => (inboundEventId.value = null)}
                            onOpenAttempt={(id: string) => {
                                inboundEventId.value = null;
                                switchAttempt(id);
                            }}
                        />
                    )}
                </>
            );
        };
    },
    {
        props: ["open", "transaction", "attemptId", "canInquire", "onUpdate", "onInquire", "onOpenCase", "onChanged"],
    },
);

export default MerchantTransactionDialog;
