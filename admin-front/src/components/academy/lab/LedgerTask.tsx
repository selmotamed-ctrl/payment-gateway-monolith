import { defineComponent, type PropType } from "vue";
import { useLocale } from "vuetify";
import { VIcon } from "vuetify/components";
import Decimal from "decimal.js";
import type { LedgerTask as LedgerTaskType } from "@/content/academy";
import { ledgerTotals, parseDecimal, type LedgerAnswer } from "../labScoring";
import { labBorder } from "./PanelView";

const ALLOWED = /^-?\d*\.?\d*$/;

export const LedgerTask = defineComponent({
    name: "AcademyLabLedgerTask",
    props: {
        task: { type: Object as PropType<LedgerTaskType>, required: true },
        answer: { type: Object as PropType<LedgerAnswer | undefined>, default: undefined },
        locked: { type: Boolean, default: false },
        onChange: { type: Function as PropType<(answer: LedgerAnswer) => void>, required: true },
    },
    setup(props) {
        const { t } = useLocale();
        const setCell = (account: string, side: "DR" | "CR", value: string, input: HTMLInputElement, previous: string) => {
            if (!ALLOWED.test(value)) {
                // Reject anything that is not a plain decimal: restore the previous text.
                input.value = previous;
                return;
            }
            const cells = { ...(props.answer?.cells ?? {}) };
            cells[account] = { ...(cells[account] ?? {}), [side]: value };
            props.onChange({ ...(props.answer ?? {}), cells });
        };
        const cellStyle = {
            border: labBorder,
            borderRadius: "6px",
            padding: "6px 8px",
            width: "100%",
            minWidth: "96px",
            font: "inherit",
            textAlign: "end",
            background: "transparent",
            color: "inherit",
        } as const;
        return () => {
            const cells = props.answer?.cells ?? {};
            const totals = ledgerTotals(cells);
            const balanced = totals.debit.eq(totals.credit) && totals.debit.gt(0);
            const fmt = (value: Decimal) => value.toFixed();
            const expectedFor = (account: string) => props.task.expected.find((line) => line.account === account);
            return (
                <div style={{ display: "grid", gap: "10px" }}>
                    <div style={{ overflowX: "auto" }}>
                        <table style={{ borderCollapse: "collapse", width: "100%" }}>
                            <caption style={{ textAlign: "start", paddingBottom: "6px", opacity: 0.8 }}>
                                {t("Enter amounts as plain numbers. Leave a cell empty if the account is not touched.")}
                            </caption>
                            <thead>
                                <tr>
                                    <th scope="col" style={{ textAlign: "start", padding: "4px 8px", borderBottom: labBorder }}>{t("Account")}</th>
                                    <th scope="col" style={{ textAlign: "end", padding: "4px 8px", borderBottom: labBorder }}>{t("Debit")}</th>
                                    <th scope="col" style={{ textAlign: "end", padding: "4px 8px", borderBottom: labBorder }}>{t("Credit")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {props.task.accounts.map((account) => {
                                    const expected = expectedFor(account);
                                    return (
                                        <tr>
                                            <th scope="row" style={{ textAlign: "start", padding: "4px 8px", fontWeight: 500, overflowWrap: "anywhere" }}>
                                                {account}
                                                {props.locked ? (
                                                    <div style={{ fontWeight: 400, opacity: 0.8, fontSize: "0.85em" }}>
                                                        {expected
                                                            ? `${t("Expected")}: ${expected.side === "DR" ? t("Debit") : t("Credit")} ${expected.amount}`
                                                            : t("Expected: untouched")}
                                                    </div>
                                                ) : null}
                                            </th>
                                            {(["DR", "CR"] as const).map((side) => {
                                                const raw = cells[account]?.[side] ?? "";
                                                const invalid = raw !== "" && parseDecimal(raw) === null;
                                                return (
                                                    <td style={{ padding: "4px 8px" }}>
                                                        <input
                                                            type="text"
                                                            inputmode="decimal"
                                                            autocomplete="off"
                                                            dir="ltr"
                                                            value={raw}
                                                            disabled={props.locked}
                                                            aria-label={`${account} - ${side === "DR" ? t("Debit") : t("Credit")}`}
                                                            aria-invalid={invalid ? "true" : undefined}
                                                            style={cellStyle}
                                                            onInput={(event: Event) => {
                                                                const input = event.target as HTMLInputElement;
                                                                setCell(account, side, input.value, input, raw);
                                                            }}
                                                        />
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    );
                                })}
                            </tbody>
                            <tfoot>
                                <tr>
                                    <th scope="row" style={{ textAlign: "start", padding: "6px 8px", borderTop: labBorder }}>{t("Total")}</th>
                                    <td style={{ textAlign: "end", padding: "6px 8px", borderTop: labBorder }} dir="ltr">{fmt(totals.debit)}</td>
                                    <td style={{ textAlign: "end", padding: "6px 8px", borderTop: labBorder }} dir="ltr">{fmt(totals.credit)}</td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                    <div role="status" aria-live="polite">
                        <span
                            style={{
                                display: "inline-flex",
                                gap: "6px",
                                alignItems: "center",
                                padding: "4px 12px",
                                borderRadius: "999px",
                                fontWeight: 700,
                                border: `2px solid rgb(var(--v-theme-${balanced ? "success" : "error"}))`,
                            }}
                        >
                            <VIcon icon={balanced ? "mdi-scale-balance" : "mdi-alert-circle"} color={balanced ? "success" : "error"} size={18} aria-hidden="true" />
                            {balanced ? t("Balanced") : t("NOT BALANCED")}
                        </span>
                    </div>
                </div>
            );
        };
    },
});
export default LedgerTask;
