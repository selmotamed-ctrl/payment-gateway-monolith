import { type PropType } from "vue";
import { defineComponent } from "@/utils/dc";
import { useLocale } from "@/utils/vael-compat";
import Decimal from "decimal.js";
import {PgTextField, StatusBadge} from "@pg/ui";
import type { LedgerTask as LedgerTaskType } from "@/content/academy";
import { ledgerTotals, parseDecimal, type LedgerAnswer } from "../labScoring";

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
        const setCell = (account: string, side: "DR" | "CR", value: string) => {
            if (value !== "" && !ALLOWED.test(value)) return;
            const cells = { ...(props.answer?.cells ?? {}) };
            cells[account] = { ...(cells[account] ?? {}), [side]: value };
            props.onChange({ ...(props.answer ?? {}), cells });
        };
        return () => {
            const cells = props.answer?.cells ?? {};
            const totals = ledgerTotals(cells);
            const balanced = totals.debit.eq(totals.credit) && totals.debit.gt(0);
            const fmt = (value: Decimal) => value.toFixed();
            const expectedFor = (account: string) => props.task.expected.find((line) => line.account === account);
            return (
                <div class="ac-lab-ledger">
                    <div class="ac-lab-tablewrap">
                        <table class="ac-lab-table ac-lab-table--ledger">
                            <caption>{t("Enter amounts as plain numbers. Leave a cell empty if the account is not touched.")}</caption>
                            <thead>
                                <tr>
                                    <th scope="col">{t("Account")}</th>
                                    <th scope="col" class="ac-lab-num">
                                        {t("Debit")}
                                    </th>
                                    <th scope="col" class="ac-lab-num">
                                        {t("Credit")}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {props.task.accounts.map((account) => {
                                    const expected = expectedFor(account);
                                    return (
                                        <tr key={account}>
                                            <th scope="row" dir="auto">
                                                {account}
                                                {props.locked ? (
                                                    <span class="ac-lab-expected">
                                                        {expected
                                                            ? `${t("Expected")}: ${expected.side === "DR" ? t("Debit") : t("Credit")} ${expected.amount}`
                                                            : t("Expected: untouched")}
                                                    </span>
                                                ) : null}
                                            </th>
                                            {(["DR", "CR"] as const).map((side) => {
                                                const raw = cells[account]?.[side] ?? "";
                                                const invalid = raw !== "" && parseDecimal(raw) === null;
                                                return (
                                                    <td class="ac-lab-num" key={side}>
                                                        <PgTextField
                                                            class="ac-lab-input ac-lab-input--cell"
                                                            density="compact"
                                                            hideDetails
                                                            inputmode="decimal"
                                                            autocomplete="off"
                                                            dir="ltr"
                                                            modelValue={raw}
                                                            disabled={props.locked}
                                                            onUpdate:modelValue={(value: string) => setCell(account, side, value)}
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
                                    <th scope="row">{t("Total")}</th>
                                    <td class="ac-lab-num" dir="ltr">
                                        {fmt(totals.debit)}
                                    </td>
                                    <td class="ac-lab-num" dir="ltr">
                                        {fmt(totals.credit)}
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                    <div role="status" aria-live="polite" class="ac-lab-ledger__status">
                        <StatusBadge
                            status={balanced ? "BALANCED" : "NOT_BALANCED"}
                            label={balanced ? t("Balanced") : t("NOT BALANCED")}
                            toneOverride={balanced ? "success" : "danger"}
                            showDot
                        />
                    </div>
                </div>
            );
        };
    },
});
export default LedgerTask;
