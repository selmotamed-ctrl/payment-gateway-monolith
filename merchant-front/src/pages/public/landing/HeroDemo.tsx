import { computed, defineComponent, onBeforeUnmount, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { VIcon } from "vuetify/components";
import Decimal from "decimal.js";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatMoney } from "@/utils/money";
import {
    LANDING_DEMO_AMOUNT,
    LANDING_DEMO_COMMISSION_PERCENT,
    LANDING_DEMO_STEPS,
    LANDING_RAIL_MODES,
    journalImbalance,
    landingDemoJournal,
    nextDemoStep,
    type LandingRailMode,
} from "@/content/landing/landingModel";
import { animateProgress, useInView, usePageVisible, useReducedMotion } from "./motion";

/** Deterministic decorative QR-like module path (21×21 with three finder patterns). */
const buildQrPath = (): string => {
    const size = 21;
    let seed = 7;
    const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };
    const inFinder = (x: number, y: number) =>
        (x < 8 && y < 8) || (x > size - 9 && y < 8) || (x < 8 && y > size - 9);
    const parts: string[] = [];
    const finder = (ox: number, oy: number) => {
        parts.push(`M${ox} ${oy}h7v7h-7z M${ox + 1} ${oy + 1}v5h5v-5z M${ox + 2} ${oy + 2}h3v3h-3z`);
    };
    finder(0, 0);
    finder(size - 7, 0);
    finder(0, size - 7);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (inFinder(x, y)) continue;
            if (rand() > 0.52) parts.push(`M${x} ${y}h1v1h-1z`);
        }
    }
    return parts.join(" ");
};
const QR_PATH = buildQrPath();

const STATUS_LABELS: Record<string, string> = {
    AWAITING_CUSTOMER: "Awaiting customer",
    VERIFYING: "Verifying",
    SUCCEEDED: "Succeeded",
};

const ACCOUNT_LABELS: Record<string, string> = {
    GATEWAY_CLEARING: "Gateway clearing",
    MERCHANT_WALLET: "Your wallet",
    PLATFORM_INCOME: "Platform commission",
};

export const HeroDemo = defineComponent({
    name: "LandingHeroDemo",
    setup() {
        const { t, current } = useLocale();
        const reduced = useReducedMotion();
        const root = ref<HTMLElement | null>(null);
        const inView = useInView(root);
        const pageVisible = usePageVisible();

        // Reduced motion starts on the completed state with autoplay off.
        const step = ref(reduced.value ? LANDING_DEMO_STEPS.length - 1 : 0);
        const mode = ref<LandingRailMode>("OTP");
        const userPaused = ref(reduced.value);
        const announce = ref(false);
        const walletShown = ref(new Decimal(0));

        const journal = landingDemoJournal();
        const walletCredit = journal.find((line) => line.account === "MERCHANT_WALLET")!.amount;
        const balanced = journalImbalance(journal).isZero();

        const playing = computed(() => !userPaused.value && inView.value && pageVisible.value);
        const current_ = computed(() => LANDING_DEMO_STEPS[step.value]!);
        const modeMeta = computed(() => LANDING_RAIL_MODES.find((m) => m.mode === mode.value)!);

        let timer: ReturnType<typeof setTimeout> | null = null;
        let cancelCount: (() => void) | null = null;
        let modeCursor = 0;

        const clearTimer = () => {
            if (timer) clearTimeout(timer);
            timer = null;
        };

        const schedule = () => {
            clearTimer();
            if (!playing.value) return;
            timer = setTimeout(() => {
                const next = nextDemoStep(step.value);
                if (next === 0) {
                    // Cycle through the five checkout experiences on each loop.
                    modeCursor = (modeCursor + 1) % LANDING_RAIL_MODES.length;
                    mode.value = LANDING_RAIL_MODES[modeCursor]!.mode;
                }
                step.value = next;
            }, current_.value.holdMs);
        };

        watch([step, playing], schedule, { immediate: true });

        watch(
            step,
            (value) => {
                cancelCount?.();
                if (value < LANDING_DEMO_STEPS.length - 1) {
                    walletShown.value = new Decimal(0);
                    return;
                }
                if (reduced.value) {
                    walletShown.value = walletCredit;
                    return;
                }
                cancelCount = animateProgress(900, (p) => {
                    walletShown.value = walletCredit.times(p).toDecimalPlaces(3, Decimal.ROUND_DOWN);
                });
            },
            { immediate: true },
        );

        onBeforeUnmount(() => {
            clearTimer();
            cancelCount?.();
        });

        const selectMode = (next: LandingRailMode) => {
            mode.value = next;
            modeCursor = LANDING_RAIL_MODES.findIndex((m) => m.mode === next);
            announce.value = true;
            step.value = 1;
        };

        const togglePlay = () => {
            userPaused.value = !userPaused.value;
            announce.value = userPaused.value;
        };

        const stepForward = () => {
            userPaused.value = true;
            announce.value = true;
            step.value = nextDemoStep(step.value);
        };

        const money = (value: Decimal | string) => formatMoney(value, { currency: "LYD" });

        const renderAction = () => {
            const s = step.value;
            if (s === 0) {
                return (
                    <div class="pgl-demo__hint">
                        <VIcon icon="mdi-gesture-tap" size={18} aria-hidden="true" />
                        <span>{t("Choose how to pay")}</span>
                    </div>
                );
            }
            if (s === 2) {
                return (
                    <div class="pgl-demo__verifying">
                        <span class="pgl-spinner" aria-hidden="true" />
                        <span>{t("Verifying with the provider")}</span>
                    </div>
                );
            }
            if (s >= 3) {
                return (
                    <div class="pgl-demo__success">
                        <svg class="pgl-check" viewBox="0 0 52 52" aria-hidden="true">
                            <circle class="pgl-check__circle" cx="26" cy="26" r="24" />
                            <path class="pgl-check__tick" d="M15 27l7 7 15-16" />
                        </svg>
                        <div>
                            <div class="pgl-demo__success-title">{t("Payment confirmed")}</div>
                            <div class="pgl-mono pgl-demo__ref" dir="ltr">
                                PG-4092-7KQ
                            </div>
                        </div>
                    </div>
                );
            }
            // s === 1: mode-specific customer action
            switch (mode.value) {
                case "OTP":
                    return (
                        <div class="pgl-demo__otp" dir="ltr" aria-hidden="true">
                            {["4", "7", "1", "9", "0", "3"].map((digit, index) => (
                                <span class="pgl-otp-box" style={{ "--pgl-i": index }} key={index}>
                                    <span class="pgl-otp-digit">{digit}</span>
                                </span>
                            ))}
                        </div>
                    );
                case "QR":
                    return (
                        <div class="pgl-demo__qr" aria-hidden="true">
                            <svg viewBox="-1 -1 23 23" class="pgl-qr" shape-rendering="crispEdges">
                                <path d={QR_PATH} fill="currentColor" fill-rule="evenodd" />
                            </svg>
                            <span class="pgl-qr__scan" />
                        </div>
                    );
                case "PUSH":
                    return (
                        <div class="pgl-demo__push" aria-hidden="true">
                            <div class="pgl-push-card">
                                <VIcon icon="mdi-bell-ring-outline" size={16} />
                                <span>
                                    {t("Approve")} <b class="pgl-tabular">{money(LANDING_DEMO_AMOUNT)}</b>
                                </span>
                                <span class="pgl-push-card__btn">{t("Approve")}</span>
                            </div>
                        </div>
                    );
                case "REDIRECT":
                    return (
                        <div class="pgl-demo__redirect" aria-hidden="true">
                            <span>{t("Redirecting to the bank page")}</span>
                            <span class="pgl-bar">
                                <span class="pgl-bar__fill" />
                            </span>
                        </div>
                    );
                case "CARD":
                default:
                    return (
                        <div class="pgl-demo__card" dir="ltr" aria-hidden="true">
                            <span class="pgl-mono">•••• •••• •••• 4242</span>
                            <span class="pgl-mono">12/28 · •••</span>
                        </div>
                    );
            }
        };

        return () => {
            const s = step.value;
            const status = current_.value.status;
            const isRtl = current.value === "ar";
            return (
                <figure
                    ref={root}
                    class="pgl-demo"
                    data-step={s}
                    data-mode={mode.value}
                    aria-labelledby="pgl-demo-title"
                    aria-describedby="pgl-demo-caption"
                >
                    <h2 id="pgl-demo-title" class="pgl-sr-only">
                        {t("Interactive payment simulation")}
                    </h2>
                    <div class="pgl-demo__window">
                        <div class="pgl-demo__chrome" aria-hidden="true">
                            <span class="pgl-dot" />
                            <span class="pgl-dot" />
                            <span class="pgl-dot" />
                            <span class="pgl-demo__url pgl-mono" dir="ltr">
                                <VIcon icon="mdi-lock-outline" size={12} />
                                pay.example.ly/pay/lnk_8F2K…
                            </span>
                        </div>

                        <div class="pgl-demo__body">
                            <div class="pgl-demo__merchant">
                                <span class="pgl-demo__avatar" aria-hidden="true">
                                    {isRtl ? "و" : "W"}
                                </span>
                                <div>
                                    <div class="pgl-demo__merchant-name">{t("Al-Waha Electronics")}</div>
                                    <div class="pgl-demo__merchant-sub">{t("Order #4092")}</div>
                                </div>
                                <span class="pgl-demo__lock" title={t("Price locked on the server")}>
                                    <VIcon icon="mdi-lock" size={12} aria-hidden="true" />
                                    {t("Server-priced")}
                                </span>
                            </div>

                            <div class="pgl-demo__amount pgl-tabular" dir="ltr">
                                {formatMoney(LANDING_DEMO_AMOUNT, { currency: "LYD", showCurrency: false })}
                                <span class="pgl-demo__ccy">LYD</span>
                            </div>

                            <div class="pgl-demo__rails" role="group" aria-label={t("Payment method")}>
                                {LANDING_RAIL_MODES.map((item) => (
                                    <button
                                        key={item.mode}
                                        type="button"
                                        class="pgl-rail"
                                        aria-pressed={mode.value === item.mode ? "true" : "false"}
                                        onClick={() => selectMode(item.mode)}
                                    >
                                        <VIcon icon={item.icon} size={15} aria-hidden="true" />
                                        <span>{t(item.label)}</span>
                                    </button>
                                ))}
                            </div>

                            <div class="pgl-demo__action" key={`${mode.value}-${s}`}>
                                {renderAction()}
                            </div>

                            <div class="pgl-demo__status">
                                <StatusBadge status={status} label={t(STATUS_LABELS[status]!)} />
                                <ol class="pgl-demo__progress" aria-hidden="true">
                                    {LANDING_DEMO_STEPS.map((item) => (
                                        <li key={item.index} data-done={item.index <= s ? "" : undefined} />
                                    ))}
                                </ol>
                            </div>
                        </div>
                    </div>

                    <div class="pgl-demo__ledger" data-active={s === LANDING_DEMO_STEPS.length - 1 ? "" : undefined}>
                        <div class="pgl-demo__ledger-head">
                            <span>{t("Journal entry")}</span>
                            <span class="pgl-mono" dir="ltr">
                                PLATFORM_CLEARING
                            </span>
                        </div>
                        <ul class="pgl-demo__lines">
                            {journal.map((line, index) => (
                                <li key={line.account} style={{ "--pgl-i": index }}>
                                    <span class={["pgl-side", line.side === "DR" ? "pgl-side--dr" : "pgl-side--cr"]}>
                                        {line.side === "DR" ? t("Dr") : t("Cr")}
                                    </span>
                                    <span class="pgl-demo__acct">{t(ACCOUNT_LABELS[line.account]!)}</span>
                                    <span class="pgl-tabular" dir="ltr">
                                        {money(line.amount)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                        <div class="pgl-demo__ledger-foot">
                            <span class="pgl-balanced">
                                <VIcon icon="mdi-scale-balance" size={14} aria-hidden="true" />
                                {balanced ? t("Balanced: debits equal credits") : t("Unbalanced")}
                            </span>
                            <span class="pgl-demo__wallet">
                                <span>{t("Wallet")}</span>
                                <b class="pgl-tabular" dir="ltr">
                                    +{money(walletShown.value)}
                                </b>
                            </span>
                        </div>
                    </div>

                    <div class="pgl-demo__controls">
                        <button
                            type="button"
                            class="pgl-icon-btn"
                            onClick={togglePlay}
                            aria-label={userPaused.value ? t("Play simulation") : t("Pause simulation")}
                        >
                            <VIcon icon={userPaused.value ? "mdi-play" : "mdi-pause"} size={16} aria-hidden="true" />
                        </button>
                        <button type="button" class="pgl-icon-btn" onClick={stepForward} aria-label={t("Next step")}>
                            <VIcon icon={isRtl ? "mdi-skip-previous" : "mdi-skip-next"} size={16} aria-hidden="true" />
                        </button>
                        <p id="pgl-demo-caption" class="pgl-demo__caption" aria-live={announce.value ? "polite" : "off"}>
                            <span class="pgl-demo__step pgl-tabular">
                                {s + 1}/{LANDING_DEMO_STEPS.length}
                            </span>
                            {t(current_.value.caption)}
                            <span class="pgl-sr-only">
                                {" · "}
                                {t(modeMeta.value.label)}
                            </span>
                        </p>
                    </div>
                    <figcaption class="pgl-demo__note">
                        {t("Illustrative simulation. Example commission")} {LANDING_DEMO_COMMISSION_PERCENT}%
                    </figcaption>
                </figure>
            );
        };
    },
});

export default HeroDemo;
