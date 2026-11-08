import { defineComponent, type PropType, type VNodeChild } from "vue";
import { useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VAlert, VBtn } from "vuetify/components";
import { MetaPill } from "@/components/ui/MetaPill";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { statusTone } from "@/components/Table/statusTone";
import { approvalActionLabel, describeApprovalPayload } from "../approvalPayload";

export const toBadgeTone = (value: string): BadgeTone => {
    const tone = statusTone(value);
    return tone === "error" ? "danger" : tone === "primary" ? "info" : tone;
};

export const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
};

/** Muted placeholder for a value the backend redacted for this role. Never renders 0. */
export const RestrictedValue = defineComponent({
    name: "RestrictedValue",
    setup() {
        const { t } = useLocale();
        return (): VNodeChild => (
            <span
                title={t("Hidden for your role")}
                style={{ color: "var(--pg-ink-faint)", fontSize: "12px", fontStyle: "italic" }}
            >
                {t("Restricted")}
            </span>
        );
    },
});

/** A money amount, or the "Restricted" placeholder when `restricted` (balances for non-financial roles). */
export const MoneyOrRestricted = defineComponent({
    name: "MoneyOrRestricted",
    props: {
        amount: { type: [String, Number] as PropType<string | number | null | undefined>, default: null },
        currency: { type: String, default: "LYD" },
        restricted: { type: Boolean, default: false },
        size: { type: String as PropType<"sm" | "md" | "lg">, default: "sm" },
    },
    setup(props) {
        return (): VNodeChild =>
            props.restricted || props.amount === null || props.amount === undefined ? (
                <RestrictedValue />
            ) : (
                <MoneyDisplay amount={props.amount} currency={props.currency} size={props.size} />
            );
    },
});

/** Monospace pills for rail codes / redirect domains. */
export const PillList = defineComponent({
    name: "PillList",
    props: {
        items: { type: Array as PropType<string[]>, default: () => [] },
        emptyLabel: { type: String, default: "" },
        max: { type: Number, default: 0 },
    },
    setup(props) {
        const { t } = useLocale();
        return (): VNodeChild => {
            if (props.items.length === 0) {
                return <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>{props.emptyLabel || "—"}</span>;
            }
            const shown = props.max > 0 ? props.items.slice(0, props.max) : props.items;
            const hidden = props.items.length - shown.length;
            return (
                <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "4px" }}>
                    {shown.map((item) => (
                        <MetaPill key={item} size="x-small">
                            <span dir="ltr" style={{ fontFamily: "var(--pg-font-mono, ui-monospace, monospace)" }}>{item}</span>
                        </MetaPill>
                    ))}
                    {hidden > 0 && <MetaPill size="x-small" variant="outlined">{`+${hidden} ${t("more")}`}</MetaPill>}
                </span>
            );
        };
    },
});

/**
 * Shown after an action returned HTTP 202: the change was only SUBMITTED for
 * four-eyes approval, it is not applied yet.
 */
export const ApprovalSubmittedNotice = defineComponent({
    name: "ApprovalSubmittedNotice",
    props: {
        approvalRequestId: { type: String as PropType<string | null>, default: null },
        dismissible: { type: Boolean, default: true },
    },
    emits: ["dismiss"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const router = useRouter();
        const openApprovals = () =>
            void router.push({ name: "Approvals", query: props.approvalRequestId ? { open: props.approvalRequestId } : {} });
        return (): VNodeChild => (
            <VAlert type="info" variant="tonal" density="compact" {...{ role: "status" }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", justifyContent: "space-between" }}>
                    <span>{t("Submitted for approval. The change is not applied until an independent checker approves it.")}</span>
                    <span style={{ display: "inline-flex", gap: "6px" }}>
                        <VBtn size="small" variant="tonal" prependIcon="mdi-open-in-new" onClick={openApprovals}>{t("Open Approvals")}</VBtn>
                        {props.dismissible && <VBtn size="small" variant="text" onClick={() => emit("dismiss")}>{t("Dismiss")}</VBtn>}
                    </span>
                </div>
            </VAlert>
        );
    },
});

export interface PendingApprovalRow {
    id: string;
    state: string;
    payloadDiffJson: unknown;
    makerReason?: string | null;
    createdAt?: string | null;
}

/** Pending four-eyes requests of an entity, with a structured (non-JSON) summary of what is requested. */
export const PendingApprovalsList = defineComponent({
    name: "PendingApprovalsList",
    props: {
        approvals: { type: Array as PropType<PendingApprovalRow[]>, default: () => [] },
    },
    setup(props) {
        const { t } = useLocale();
        const router = useRouter();
        return (): VNodeChild => {
            if (props.approvals.length === 0) return null;
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    {props.approvals.map((approval) => {
                        const action = (approval.payloadDiffJson as { action?: string } | null)?.action;
                        const rows = describeApprovalPayload(approval.payloadDiffJson);
                        return (
                            <SurfaceCard key={approval.id} variant="tonal" color="warning">
                                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", justifyContent: "space-between" }}>
                                        <span style={{ display: "inline-flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                            <StatusBadge status={approval.state} toneOverride="warning" />
                                            <strong style={{ fontSize: "13px" }}>{t(approvalActionLabel(action))}</strong>
                                        </span>
                                        <VBtn
                                            size="small"
                                            variant="text"
                                            prependIcon="mdi-open-in-new"
                                            onClick={() => void router.push({ name: "Approvals", query: { open: approval.id } })}
                                        >
                                            {t("Open in Approvals")}
                                        </VBtn>
                                    </div>
                                    {approval.makerReason && <span style={{ fontSize: "12.5px", color: "var(--pg-ink-secondary)" }}>{approval.makerReason}</span>}
                                    {rows.length > 0 && (
                                        <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(110px, max-content) 1fr", gap: "6px 14px", fontSize: "12.5px" }}>
                                            {rows.map((row) => (
                                                <>
                                                    <dt key={`${row.key}-l`} style={{ color: "var(--pg-ink-muted)" }}>{t(row.label)}</dt>
                                                    <dd key={`${row.key}-v`} style={{ margin: 0, minWidth: 0 }}>
                                                        {row.kind === "status" ? (
                                                            <StatusBadge status={row.value} toneOverride={toBadgeTone(row.value)} />
                                                        ) : row.kind === "mono" ? (
                                                            <MonoRef value={row.value} truncate={18} />
                                                        ) : row.kind === "chips" ? (
                                                            <PillList items={row.value} emptyLabel={t(row.emptyLabel)} />
                                                        ) : (
                                                            t(row.value)
                                                        )}
                                                    </dd>
                                                </>
                                            ))}
                                        </dl>
                                    )}
                                    {approval.createdAt && <span style={{ fontSize: "11.5px", color: "var(--pg-ink-muted)" }}>{formatDateTime(approval.createdAt)}</span>}
                                </SurfaceCardText>
                            </SurfaceCard>
                        );
                    })}
                </div>
            );
        };
    },
});

export interface MiniColumn<T> {
    key: string;
    label: string;
    align?: "start" | "end";
    render: (row: T) => VNodeChild;
}

/** Compact semantic table for small, already-loaded lists inside drawers. */
export const MiniTable = defineComponent({
    name: "MiniTable",
    props: {
        columns: { type: Array as PropType<Array<MiniColumn<any>>>, required: true },
        rows: { type: Array as PropType<any[]>, default: () => [] },
        rowKey: { type: Function as PropType<(row: any) => string>, required: true },
        emptyLabel: { type: String, default: "" },
        ariaLabel: { type: String, default: "" },
    },
    setup(props) {
        const cell = (align: "start" | "end" | undefined) => ({
            padding: "8px 10px",
            textAlign: align ?? "start",
            borderBottom: "1px solid var(--pg-border-subtle)",
            verticalAlign: "middle" as const,
            fontSize: "12.5px",
        });
        return (): VNodeChild => {
            if (props.rows.length === 0) {
                return <div style={{ padding: "14px 4px", fontSize: "12.5px", color: "var(--pg-ink-muted)" }}>{props.emptyLabel}</div>;
            }
            return (
                <div style={{ overflowX: "auto", border: "1px solid var(--pg-border-subtle)", borderRadius: "var(--pg-radius-md)" }}>
                    <table aria-label={props.ariaLabel || undefined} style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                            <tr>
                                {props.columns.map((column) => (
                                    <th
                                        key={column.key}
                                        scope="col"
                                        style={{ ...cell(column.align), fontWeight: 600, color: "var(--pg-ink-muted)", backgroundColor: "var(--pg-bg-surface-subtle)", whiteSpace: "nowrap" }}
                                    >
                                        {column.label}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {props.rows.map((row) => (
                                <tr key={props.rowKey(row)}>
                                    {props.columns.map((column) => (
                                        <td key={column.key} style={cell(column.align)}>
                                            {column.render(row)}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            );
        };
    },
});
