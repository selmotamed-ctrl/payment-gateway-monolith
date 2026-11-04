import { defineComponent, onBeforeUnmount, ref, watch } from "vue";
import { LEDGER_START, formatScaled, nextAmount } from "../../../content/landing/landingModel";
import { useInView, usePageVisible, useReducedMotion } from "./motion";

/**
 * Decorative "ledger.invariant" readout. Debits and credits grow together on
 * every tick, so the difference is always 0.0000 — the double-entry invariant
 * the platform actually enforces. Amounts are BigInt counts of 1/10,000 so no
 * floating-point arithmetic touches a money-looking number.
 */
export { formatScaled, nextAmount };

export const LedgerTicker = defineComponent({
    name: "LandingLedgerTicker",
    setup() {
        const reduced = useReducedMotion();
        const root = ref<HTMLElement | null>(null);
        const inView = useInView(root);
        const pageVisible = usePageVisible();
        const debits = ref(LEDGER_START);
        const credits = ref(LEDGER_START);
        let seed = 7;
        let timer: ReturnType<typeof setInterval> | null = null;

        const stop = () => {
            if (timer) clearInterval(timer);
            timer = null;
        };

        const start = () => {
            if (timer || reduced.value) return;
            timer = setInterval(() => {
                const next = nextAmount(seed);
                seed = next.seed;
                debits.value += next.amount;
                credits.value += next.amount;
            }, 2200);
        };

        watch(
            [inView, pageVisible, reduced],
            ([visible, tabVisible, noMotion]) => (visible && tabVisible && !noMotion ? start() : stop()),
            { immediate: true },
        );
        onBeforeUnmount(stop);

        return () => (
            <div ref={root} class="pgl-invariant" data-reveal aria-hidden="true" dir="ltr">
                <div class="pgl-invariant__head">
                    <span class="pgl-pulse" />
                    ledger.invariant
                    <span class="pgl-cursor">▍</span>
                </div>
                <div class="pgl-invariant__row">
                    <span>Σ debits</span>
                    <b>{formatScaled(debits.value)}</b>
                </div>
                <div class="pgl-invariant__row">
                    <span>Σ credits</span>
                    <b>{formatScaled(credits.value)}</b>
                </div>
                <div class="pgl-invariant__row pgl-invariant__ok">
                    <span>difference</span>
                    <b>{formatScaled(debits.value - credits.value)} ✓</b>
                </div>
            </div>
        );
    },
});

export default LedgerTicker;
