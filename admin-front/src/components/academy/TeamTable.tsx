import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import type { TeamRow, TeamStatus } from "@/content/academy/apiTypes";
import { BadgeChip } from "./BadgeChip";
import type { BadgeState } from "./useAcademyProgress";
import { fmtDate } from "./exam/ExamBriefing";

type Props = {
    rows: TeamRow[];
    trackTitles: Record<string, string>;
};

const STATUS_ORDER: TeamStatus[] = ["NOT_STARTED", "IN_PROGRESS", "EXAM_READY", "CERTIFIED", "EXPIRING_SOON", "RECERTIFICATION_REQUIRED"];
const STATUS_TONE: Record<TeamStatus, string> = {
    NOT_STARTED: "neutral",
    IN_PROGRESS: "info",
    EXAM_READY: "info",
    CERTIFIED: "success",
    EXPIRING_SOON: "warning",
    RECERTIFICATION_REQUIRED: "danger",
};
const STATUS_ICON: Record<TeamStatus, string> = { NOT_STARTED: "○", IN_PROGRESS: "◐", EXAM_READY: "▶", CERTIFIED: "✓", EXPIRING_SOON: "⏳", RECERTIFICATION_REQUIRED: "⟳" };

/** CSV cell: quote everything, neutralise spreadsheet formulas. */
export const csvCell = (value: string | number | boolean | null | undefined): string => {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
};

const badgeState = (badge: TeamRow["badges"][number]): BadgeState => {
    if (badge.expired) return "expired";
    const left = Date.parse(badge.expiresAt) - Date.now();
    return left < 30 * 24 * 3600 * 1000 ? "expiring" : "valid";
};

const cell = { padding: "10px 12px", borderBottom: "1px solid var(--pg-border-subtle)", verticalAlign: "top", textAlign: "start" } as const;
const inputStyle = { padding: "8px 10px", border: "1px solid var(--pg-border-subtle)", borderRadius: "8px", background: "transparent", color: "inherit", minBlockSize: "38px" } as const;

export const TeamTable = dc((props: Props) => {
    const { t } = useLocale();
    const search = ref("");
    const role = ref("");
    const status = ref("");

    const statusLabel = (value: TeamStatus): string =>
        ({
            NOT_STARTED: t("Not started"),
            IN_PROGRESS: t("In progress"),
            EXAM_READY: t("Exam ready"),
            CERTIFIED: t("Certified"),
            EXPIRING_SOON: t("Expiring within 30 days"),
            RECERTIFICATION_REQUIRED: t("Recertification required"),
        })[value];

    const roles = computed(() => Array.from(new Set(props.rows.map((row) => row.role))).sort());
    const visible = computed(() => {
        const needle = search.value.trim().toLowerCase();
        return props.rows.filter(
            (row) =>
                (!role.value || row.role === role.value) &&
                (!status.value || row.status === status.value) &&
                (!needle || row.name.toLowerCase().includes(needle) || row.email.toLowerCase().includes(needle)),
        );
    });

    const exportCsv = () => {
        const head = ["Name", "Email", "Role", "Maker", "Checker", "Status", "Active track", "Lessons completed", "Lessons required", "Labs passed", "Labs required", "Badges", "Last activity"];
        const lines = [head.map(csvCell).join(",")];
        for (const row of visible.value) {
            lines.push(
                [
                    row.name,
                    row.email,
                    row.role,
                    row.isMaker ? "yes" : "no",
                    row.isChecker ? "yes" : "no",
                    row.status,
                    row.activeTrack ?? "",
                    row.lessonsCompleted,
                    row.lessonsRequired,
                    row.labsPassed,
                    row.labsRequired,
                    row.badges.map((b) => `${b.track} until ${b.expiresAt.slice(0, 10)}${b.expired ? " (expired)" : ""}`).join("; "),
                    row.lastActivityAt ?? "",
                ]
                    .map(csvCell)
                    .join(","),
            );
        }
        const blob = new Blob([`﻿${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `academy-team-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    return () => (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "flex-end" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
                    {t("Search name or email")}
                    <input type="search" value={search.value} onInput={(e: Event) => (search.value = (e.target as HTMLInputElement).value)} style={{ ...inputStyle, minInlineSize: "220px" }} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
                    {t("Role")}
                    <select value={role.value} onChange={(e: Event) => (role.value = (e.target as HTMLSelectElement).value)} style={inputStyle}>
                        <option value="">{t("All roles")}</option>
                        {roles.value.map((r) => <option key={r} value={r} selected={role.value === r}>{r}</option>)}
                    </select>
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
                    {t("Status")}
                    <select value={status.value} onChange={(e: Event) => (status.value = (e.target as HTMLSelectElement).value)} style={inputStyle}>
                        <option value="">{t("All statuses")}</option>
                        {STATUS_ORDER.map((s) => <option key={s} value={s} selected={status.value === s}>{statusLabel(s)}</option>)}
                    </select>
                </label>
                <VBtn variant="outlined" disabled={visible.value.length === 0} onClick={exportCsv}>{t("Export CSV")} ({visible.value.length})</VBtn>
            </div>
            <div role="status" aria-live="polite" style={{ fontSize: "12px", opacity: 0.75 }}>
                {visible.value.length} / {props.rows.length} {t("people shown")}
            </div>
            {visible.value.length === 0 ? (
                <p style={{ margin: 0 }}>{t("No one matches these filters.")}</p>
            ) : (
                <div style={{ overflowX: "auto", border: "1px solid var(--pg-border-subtle)", borderRadius: "10px" }}>
                    <table style={{ inlineSize: "100%", borderCollapse: "collapse", fontSize: "13px", minInlineSize: "980px" }}>
                        <caption style={{ position: "absolute", insetInlineStart: "-9999px" }}>{t("Academy progress by person")}</caption>
                        <thead>
                            <tr>
                                {[t("Person"), t("Role"), t("Active track"), t("Lessons"), t("Labs"), t("Badges"), t("Last activity"), t("Status")].map((h) => (
                                    <th key={h} scope="col" style={{ ...cell, fontWeight: 600, background: "var(--pg-bg-surface-subtle)" }}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {visible.value.map((row) => (
                                <tr key={row.userId}>
                                    <th scope="row" style={{ ...cell, fontWeight: 500 }}>
                                        <div style={{ fontWeight: 600 }}>{row.name || row.email}</div>
                                        <div style={{ opacity: 0.7, fontSize: "12px" }} dir="ltr">{row.email}</div>
                                    </th>
                                    <td style={cell}>
                                        {row.role}
                                        {(row.isMaker || row.isChecker) && (
                                            <div style={{ fontSize: "12px", opacity: 0.75 }}>{[row.isMaker ? t("Maker") : "", row.isChecker ? t("Checker") : ""].filter(Boolean).join(" · ")}</div>
                                        )}
                                    </td>
                                    <td style={cell}>{row.activeTrack ? props.trackTitles[row.activeTrack] ?? row.activeTrack : "—"}</td>
                                    <td style={cell}>{row.lessonsCompleted} / {row.lessonsRequired}</td>
                                    <td style={cell}>{row.labsPassed} / {row.labsRequired}</td>
                                    <td style={cell}>
                                        {row.badges.length === 0 ? "—" : (
                                            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                                {row.badges.map((b) => (
                                                    <div key={b.id}>
                                                        <div style={{ fontSize: "12px" }}>{props.trackTitles[b.track] ?? b.track}</div>
                                                        <BadgeChip track={b.track} state={badgeState(b)} expiresAt={b.expiresAt} />
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </td>
                                    <td style={cell}>{row.lastActivityAt ? fmtDate(row.lastActivityAt) : "—"}</td>
                                    <td style={cell}>
                                        <span style={{ display: "inline-flex", gap: "6px", alignItems: "center", padding: "2px 10px", borderRadius: "999px", whiteSpace: "nowrap", border: `1px solid var(--pg-status-${STATUS_TONE[row.status]}-border)`, background: `var(--pg-status-${STATUS_TONE[row.status]}-bg)`, color: `var(--pg-status-${STATUS_TONE[row.status]}-text)` }}>
                                            <span aria-hidden="true">{STATUS_ICON[row.status]}</span>{statusLabel(row.status)}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
});
