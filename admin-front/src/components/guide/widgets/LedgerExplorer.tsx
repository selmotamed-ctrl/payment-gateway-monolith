import { computed, defineComponent, onMounted, ref } from "vue";
import { loadData, type LedgerData } from "@/content/guide";
import { simulateLedgerEvent } from "./engine/ledger";
import { useGuideLocale } from "./useGuideLocale";

export const LedgerExplorer = defineComponent({
    name: "LedgerExplorer",
    setup() {
        const { L } = useGuideLocale();
        const data = ref<LedgerData | null>(null);
        const amount = ref("100");
        const rate = ref("3");
        const fee = ref("0.8");
        const provFee = ref("1");
        const walletStart = ref("40");
        const selectedEventId = ref("E02");

        onMounted(async () => {
            const loaded = await loadData().catch(() => null);
            data.value = loaded?.["ledger-events"] ?? null;
        });

        const event = computed(() => data.value?.events.find((entry) => entry.id === selectedEventId.value));
        const result = computed(() =>
            data.value ? simulateLedgerEvent(data.value, selectedEventId.value, {
                A: amount.value,
                rate: rate.value,
                fee: fee.value,
                provFee: provFee.value,
                walletStart: walletStart.value,
            }) : undefined,
        );

        const reset = () => {
            amount.value = "100";
            rate.value = "3";
            fee.value = "0.8";
            provFee.value = "1";
            walletStart.value = "40";
            selectedEventId.value = "E02";
        };

        return () => (
            <section class="guide-tool">
                <header class="guide-tool__header">
                    <div>
                        <h2>{L("Ledger explorer", "مستكشف دفتر الأستاذ")}</h2>
                        <p>{L("Every journal entry has two sides that must balance exactly.", "لكل قيد يومية طرفان يجب أن يتساويا بدقة.")}</p>
                    </div>
                    <button type="button" class="guide-secondary-button" onClick={reset}>
                        {L("Reset", "إعادة تعيين")}
                    </button>
                </header>
                <p class="guide-tool__warning">
                    {L("Teaching tool — not connected to any real system.", "أداة تعليمية — غير متصلة بأي نظام حقيقي.")}
                </p>
                {!data.value ? (
                    <p>{L("Loading teaching data…", "جارٍ تحميل البيانات التعليمية…")}</p>
                ) : (
                    <>
                        <div class="guide-tool__grid">
                            <label class="guide-field">
                                <span>{L("Link amount A", "مبلغ الرابط A")}</span>
                                <input value={amount.value} onInput={(event) => (amount.value = (event.target as HTMLInputElement).value)} />
                            </label>
                            <label class="guide-field">
                                <span>{L("Commission rate %", "نسبة العمولة %")}</span>
                                <input value={rate.value} onInput={(event) => (rate.value = (event.target as HTMLInputElement).value)} />
                            </label>
                            <label class="guide-field">
                                <span>{L("Gateway fee", "رسوم البوابة")}</span>
                                <input value={fee.value} onInput={(event) => (fee.value = (event.target as HTMLInputElement).value)} />
                            </label>
                            <label class="guide-field">
                                <span>{L("Provider fee", "رسوم المزوّد")}</span>
                                <input value={provFee.value} onInput={(event) => (provFee.value = (event.target as HTMLInputElement).value)} />
                            </label>
                            <label class="guide-field">
                                <span>{L("Wallet start (E15)", "رصيد المحفظة (E15)")}</span>
                                <input value={walletStart.value} onInput={(event) => (walletStart.value = (event.target as HTMLInputElement).value)} />
                            </label>
                        </div>
                        <label class="guide-field">
                            <span>{L("Journal event", "حدث القيد")}</span>
                            <select value={selectedEventId.value} onChange={(event) => (selectedEventId.value = (event.target as HTMLSelectElement).value)}>
                                {data.value.events.map((entry) => (
                                    <option key={entry.id} value={entry.id}>
                                        {entry.id} — {entry.title}
                                    </option>
                                ))}
                            </select>
                        </label>
                        {result.value ? (
                            <div class="guide-ledger" aria-live="polite">
                                {result.value.entries.map((entry, entryIndex) => (
                                    <div key={`${result.value?.event.id}-${entryIndex}`} class="guide-ledger-entry">
                                        <div class="guide-ledger-entry__header">
                                            <strong>{entry.label}</strong>
                                            <span class={entry.balanced ? "guide-balanced" : "guide-not-balanced"}>
                                                {entry.balanced ? "Balanced" : "NOT BALANCED"}
                                            </span>
                                        </div>
                                        <table>
                                            <thead>
                                                <tr>
                                                    <th>{L("Account", "الحساب")}</th>
                                                    <th>{L("Debit", "مدين")}</th>
                                                    <th>{L("Credit", "دائن")}</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {entry.lines.map((line, lineIndex) => (
                                                    <tr key={`${line.account}-${lineIndex}`}>
                                                        <td>
                                                            <strong>{line.account}</strong>
                                                            <small>{line.why}</small>
                                                        </td>
                                                        <td>{line.side === "DR" ? line.value : ""}</td>
                                                        <td>{line.side === "CR" ? line.value : ""}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                            <tfoot>
                                                <tr>
                                                    <th>{L("Total", "الإجمالي")}</th>
                                                    <th>{entry.debitTotal}</th>
                                                    <th>{entry.creditTotal}</th>
                                                </tr>
                                            </tfoot>
                                        </table>
                                    </div>
                                ))}
                                <div class="guide-ledger-equation">
                                    <strong>{L("System equation after this event", "معادلة النظام بعد هذا الحدث")}</strong>
                                    <p>
                                        LEFT {result.value.equation.left} = RIGHT_PLUS {result.value.equation.rightPlus} −
                                        RIGHT_MINUS {result.value.equation.rightMinus} = {result.value.equation.right}
                                    </p>
                                    <span class={result.value.equation.ok ? "guide-balanced" : "guide-not-balanced"}>
                                        {result.value.equation.ok ? "Equation holds" : "EQUATION BROKEN"}
                                    </span>
                                </div>
                                {result.value.showBalance ? (
                                    <p class="guide-ledger-extra">
                                        <strong>{result.value.showBalance.label}:</strong> {result.value.showBalance.value}
                                    </p>
                                ) : null}
                            </div>
                        ) : null}
                        <div class="guide-tool__explain">
                            <h3>{L("Explain this result", "اشرح هذه النتيجة")}</h3>
                            <p>
                                {event.value
                                    ? L(
                                          `Debits and credits in "${event.value.title}" must be equal. The equation then checks that the whole ledger still balances after the event.`,
                                          `يجب أن يتساوى المدين والدائن في "${event.value.title}". ثم تتحقق المعادلة من أن الدفتر كله ما زال متوازناً بعد الحدث.`,
                                      )
                                    : L("Choose an event to see its explanation.", "اختر حدثاً لعرض شرحه.")}
                            </p>
                        </div>
                    </>
                )}
            </section>
        );
    },
});

export default LedgerExplorer;
