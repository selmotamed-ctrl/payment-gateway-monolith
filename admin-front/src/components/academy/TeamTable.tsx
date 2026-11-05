import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VSelect, VTextField } from "vuetify/components";
import { EmptyState } from "@/components/ui/EmptyState";
import { MetaPill } from "@/components/ui/MetaPill";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";
import type { TeamRow, TeamStatus } from "@/content/academy/apiTypes";
import { fmtDate, fmtDateShort } from "./format";
import { ProgressBar } from "./ui/ProgressBar";
import { BADGE_TONE } from "./ui/trackMeta";
import type { BadgeState } from "./useAcademyProgress";

type Props = {
    rows: TeamRow[];
    trackTitles: Record<string, string>;
};

/** Sentinel for "no filter" in the two selects (never a real role or status value). */
const ALL = "__all__";

const STATUS_ORDER: TeamStatus[] = ["NOT_STARTED", "IN_PROGRESS", "EXAM_READY", "CERTIFIED", "EXPIRING_SOON", "RECERTIFICATION_REQUIRED"];
const STATUS_TONE: Record<TeamStatus, BadgeTone> = {
    NOT_STARTED: "neutral",
    IN_PROGRESS: "info",
    EXAM_READY: "info",
    CERTIFIED: "success",
    EXPIRING_SOON: "warning",
    RECERTIFICATION_REQUIRED: "danger",
};
/** Order of the status summary strip (after the "People" total). */
const SUMMARY_ORDER: TeamStatus[] = ["CERTIFIED", "EXAM_READY", "IN_PROGRESS", "EXPIRING_SOON", "RECERTIFICATION_REQUIRED", "NOT_STARTED"];

/** CSV cell: quote everything, neutralise spreadsheet formulas. */
export const csvCell = (value: string | number | boolean | null | undefined): string => {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
};

const badgeState = (badge: TeamRow["badges"][number]): Extract<BadgeState, "valid" | "expiring" | "expired"> => {
    if (badge.expired) return "expired";
    const left = Date.parse(badge.expiresAt) - Date.now();
    return left < 30 * 24 * 3600 * 1000 ? "expiring" : "valid";
};

export const TeamTable = dc(
    (props: Props) => {
        const { t } = useLocale();
        const search = ref("");
        const role = ref(ALL);
        const status = ref(ALL);

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
                    (role.value === ALL || row.role === role.value) &&
                    (status.value === ALL || row.status === status.value) &&
                    (!needle || row.name.toLowerCase().includes(needle) || row.email.toLowerCase().includes(needle)),
            );
        });

        /** Status counts over ALL rows (the summary never follows the filters). */
        const metrics = computed<MetricItem[]>(() => {
            const counts: Record<string, number> = {};
            for (const row of props.rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
            return [
                { key: "people", label: t("People"), value: props.rows.length },
                ...SUMMARY_ORDER.map((value) => ({ key: value, label: statusLabel(value), value: counts[value] ?? 0 })),
            ];
        });

        const roleItems = computed(() => [{ title: t("All roles"), value: ALL }, ...roles.value.map((r) => ({ title: r, value: r }))]);
        const statusItems = computed(() => [{ title: t("All statuses"), value: ALL }, ...STATUS_ORDER.map((s) => ({ title: statusLabel(s), value: s }))]);

        const clearFilters = () => {
            search.value = "";
            role.value = ALL;
            status.value = ALL;
        };

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

        /** "a / b" with a tiny bar. The bar repeats the numbers, so it is hidden from assistive tech. */
        const progressCell = (done: number, required: number, label: string) => (
            <span class="ac-team-progress">
                <span class="ac-team-progress__num ac-num">
                    {done} / {required}
                </span>
                <span class="ac-team-bar" aria-hidden="true">
                    <ProgressBar value={done} max={required} label={`${label}: ${done} / ${required}`} />
                </span>
            </span>
        );

        const badgeCell = (row: TeamRow) =>
            row.badges.length === 0 ? (
                <span class="ac-muted">—</span>
            ) : (
                <span class="ac-team-badges">
                    {row.badges.map((badge) => {
                        const state = badgeState(badge);
                        const trackTitle = props.trackTitles[badge.track] ?? badge.track;
                        const word = state === "valid" ? t("Certified") : state === "expiring" ? t("Expires soon") : t("Expired");
                        const when = `${state === "expired" ? t("expired") : t("valid until")} ${fmtDate(badge.expiresAt)}`;
                        return (
                            <span key={badge.id} class="ac-chip ac-team-badge" data-track={badge.track} title={when}>
                                <StatusBadge status={state} label={`${trackTitle} · ${word}`} toneOverride={BADGE_TONE[state]} />
                                <span class="ac-sr-only">{when}</span>
                            </span>
                        );
                    })}
                </span>
            );

        const renderRow = (row: TeamRow) => {
            const displayName = row.name || row.email;
            const trackTitle = row.activeTrack ? props.trackTitles[row.activeTrack] ?? row.activeTrack : "";
            return (
                <tr key={row.userId}>
                    <th scope="row" class="ac-team-rowhead">
                        <span class="ac-team-person">
                            <span class="ac-team-person__name pg-cell-truncate" dir="auto" title={displayName}>
                                {displayName}
                            </span>
                            {row.name && (
                                <span class="ac-team-person__email pg-cell-truncate" dir="ltr" title={row.email}>
                                    {row.email}
                                </span>
                            )}
                        </span>
                    </th>
                    <td>
                        <span class="ac-team-role">
                            <span>{row.role}</span>
                            {row.isMaker && <MetaPill size="x-small">{t("Maker")}</MetaPill>}
                            {row.isChecker && <MetaPill size="x-small">{t("Checker")}</MetaPill>}
                        </span>
                    </td>
                    <td>
                        {trackTitle ? (
                            <span class="pg-cell-truncate" title={trackTitle}>
                                {trackTitle}
                            </span>
                        ) : (
                            <span class="ac-muted">—</span>
                        )}
                    </td>
                    <td>{progressCell(row.lessonsCompleted, row.lessonsRequired, t("Lessons"))}</td>
                    <td>{progressCell(row.labsPassed, row.labsRequired, t("Labs"))}</td>
                    <td>{badgeCell(row)}</td>
                    <td>
                        <span class="ac-num">{fmtDateShort(row.lastActivityAt)}</span>
                    </td>
                    <td>
                        <StatusBadge status={row.status} label={statusLabel(row.status)} toneOverride={STATUS_TONE[row.status]} />
                    </td>
                </tr>
            );
        };

        return () => {
            const total = props.rows.length;
            const shown = visible.value.length;
            const headers = [t("Person"), t("Role"), t("Active track"), t("Lessons"), t("Labs"), t("Badges"), t("Last activity"), t("Status")];
            return (
                <div class="ac-team">
                    <div class="ac-team-strip">
                        <MetricStrip items={metrics.value} />
                    </div>
                    <div class="pg-table-card">
                        <div class="pg-table-toolbar">
                            <div class="ac-team-filters">
                                <VTextField
                                    class="pg-table-search"
                                    variant="outlined"
                                    density="compact"
                                    hideDetails
                                    color="primary"
                                    prependInnerIcon="mdi-magnify"
                                    placeholder={t("Search name or email")}
                                    {...{ "aria-label": t("Search name or email"), autocomplete: "off" }}
                                    modelValue={search.value}
                                    onUpdate:modelValue={(value: string | null) => (search.value = value ?? "")}
                                />
                                <VSelect
                                    class="ac-team-select"
                                    variant="outlined"
                                    density="compact"
                                    hideDetails
                                    color="primary"
                                    items={roleItems.value}
                                    {...{ "aria-label": t("Role") }}
                                    modelValue={role.value}
                                    onUpdate:modelValue={(value: unknown) => (role.value = typeof value === "string" ? value : ALL)}
                                />
                                <VSelect
                                    class="ac-team-select ac-team-select--status"
                                    variant="outlined"
                                    density="compact"
                                    hideDetails
                                    color="primary"
                                    items={statusItems.value}
                                    {...{ "aria-label": t("Status") }}
                                    modelValue={status.value}
                                    onUpdate:modelValue={(value: unknown) => (status.value = typeof value === "string" ? value : ALL)}
                                />
                            </div>
                            <div class="pg-table-toolbar__right ac-team-actions">
                                <span class="pg-record-count pg-tabular" aria-hidden="true">
                                    {shown}/{total}
                                </span>
                                <VBtn variant="outlined" prependIcon="mdi-download" disabled={shown === 0} onClick={exportCsv}>
                                    {`${t("Export CSV")} (${shown})`}
                                </VBtn>
                            </div>
                        </div>
                        {shown === 0 ? (
                            <EmptyState
                                icon="mdi-account-search-outline"
                                title={t("No one matches these filters.")}
                                actionLabel={t("Clear filters")}
                                onAction={clearFilters}
                            />
                        ) : (
                            <div class="table-wrapper ac-team-scroll">
                                <table class="ac-team-table">
                                    <caption class="pg-sr-only">{t("Academy progress by person")}</caption>
                                    <thead>
                                        <tr>
                                            {headers.map((header) => (
                                                <th key={header} scope="col">
                                                    {header}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>{visible.value.map(renderRow)}</tbody>
                                </table>
                            </div>
                        )}
                        <div class="pg-table-footer" role="status" aria-live="polite">
                            <span class="ac-num">{`${shown} / ${total} ${t("people shown")}`}</span>
                        </div>
                    </div>
                </div>
            );
        };
    },
    { props: ["rows", "trackTitles"] },
);
