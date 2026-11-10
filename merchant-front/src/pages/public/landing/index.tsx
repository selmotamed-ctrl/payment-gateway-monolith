import "./landing.css";
import {
    computed,
    defineComponent,
    h,
    markRaw,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    shallowRef,
    watch,
    type Component,
} from "vue";
import { useLocale } from "vuetify";
import { VBtn, VIcon } from "vuetify/components";
import LogoSvg from "@/assets/images/logo.svg";
import { setLocale } from "@/plugins/localization";
import ThemeMenu from "@/components/ThemeMenu";
import { HeroDemo } from "./HeroDemo";
import { FeePreview } from "./FeePreview";
import { LedgerTicker } from "./LedgerTicker";
import {
    animateProgress,
    splitWords,
    useActiveSection,
    useInView,
    useReducedMotion,
    useReveal,
    useSpotlight,
    useTilt,
    withViewTransition,
} from "./motion";

/* -------------------------------------------------------------------------- */
/* Static content (catalogue keys; every string is translated via t())        */
/* -------------------------------------------------------------------------- */

const NAV = [
    { id: "pgl-flow", label: "How it works" },
    { id: "pgl-product", label: "Product" },
    { id: "pgl-developers", label: "Developers" },
    { id: "pgl-security", label: "Security" },
];

const FLOW = [
    { icon: "mdi-link-variant", title: "Payment link", text: "You set the amount once. It is stored on the server and the checkout cannot change it.", chip: "lnk_8F2K…" },
    { icon: "mdi-cellphone-check", title: "Hosted checkout", text: "The payer sees only the rails enabled for your application, in Arabic or English.", chip: "AWAITING_CUSTOMER" },
    { icon: "mdi-shield-check-outline", title: "Trusted confirmation", text: "Success is accepted only on verified provider evidence, never on a browser return.", chip: "SUCCEEDED" },
    { icon: "mdi-book-open-variant", title: "Double-entry ledger", text: "Every attempt posts a balanced journal: commission, fees and your net, to four decimal places.", chip: "Σ Dr = Σ Cr" },
    { icon: "mdi-bank-transfer-out", title: "Wallet & cash-out", text: "Your balance is derived from the ledger. Request a cash-out to your verified bank account.", chip: "IBAN" },
];

const MARQUEE = [
    { icon: "mdi-link-variant", label: "Payment links & QR" },
    { icon: "mdi-form-textbox-password", label: "One-time code" },
    { icon: "mdi-qrcode-scan", label: "Scan QR" },
    { icon: "mdi-cellphone-check", label: "Approve in app" },
    { icon: "mdi-bank-transfer", label: "Bank redirect" },
    { icon: "mdi-credit-card-outline", label: "Card form" },
    { icon: "mdi-point-of-sale", label: "Live POS screens" },
    { icon: "mdi-percent-outline", label: "Fees you can see" },
    { icon: "mdi-wallet-outline", label: "Wallets & sealed statements" },
    { icon: "mdi-account-multiple-check-outline", label: "Four-eyes changes" },
    { icon: "mdi-timer-sand", label: "Disputes with deadlines" },
    { icon: "mdi-bank-outline", label: "Bring your own gateway" },
];

const STATS = [
    { value: 5, from: 0, label: "ways to pay on one checkout" },
    { value: 3, from: 0, label: "fee-bearer modes per link" },
    { value: 2, from: 0, label: "languages, with full right-to-left" },
    { value: 0, from: 100, label: "floating-point operations on your money" },
];

const SECURITY = [
    { icon: "mdi-account-multiple-check-outline", title: "Maker-checker on sensitive changes", text: "Wallet assignment, rail whitelists and redirect allowlists wait for a second person. The server enforces maker ≠ checker." },
    { icon: "mdi-file-certificate-outline", title: "KYB and AML before live money", text: "Business profile, beneficial owners, documents and payout account are reviewed before activation." },
    { icon: "mdi-lan-connect", title: "Mutual TLS between services", text: "The merchant edge and the core service talk over mutual TLS 1.3 with channel-bound certificates." },
    { icon: "mdi-safe-square-outline", title: "Encrypted, write-only secrets", text: "Gateway credentials are encrypted with AES-256-GCM and can never be read back from the portal." },
    { icon: "mdi-book-lock-outline", title: "Append-only ledger", text: "Balances are never edited. Corrections are new, approved journal entries with an audit trail." },
    { icon: "mdi-account-key-outline", title: "Least-privilege teams", text: "Owners, accountants, cashiers and developers each get only the authorities they need." },
];

const ONBOARDING = [
    { title: "Create your account", text: "Register with your name, phone number and email." },
    { title: "Business profile", text: "Legal name, registration, tax ID, category and expected volume." },
    { title: "Owners & documents", text: "Beneficial owners and the KYB documents that prove them." },
    { title: "Payout account", text: "The corporate bank account your cash-outs go to." },
    { title: "Compliance review", text: "The platform team reviews KYB and screening, and may ask for more information." },
    { title: "Go live", text: "Create a wallet and application, then share links, pair a POS screen or call the API." },
];

const FAQ = [
    { q: "How is my commission set?", a: "Commission profiles are configured by the platform per merchant, application and rail. You choose per link whether you absorb the fee, the payer pays it, or you split it, and the checkout shows the payer the exact total." },
    { q: "Can I use my own gateway accounts?", a: "Yes. In merchant-direct mode you register your own gateway credentials; money settles to your account and the platform records only its commission." },
    { q: "When is a payment safe to fulfil?", a: "When its status is SUCCEEDED. Pending, verifying or unknown attempts are not paid yet, and a browser return alone never proves payment." },
    { q: "What do my customers see?", a: "A focused hosted checkout in Arabic or English showing your name, the server-set amount, any service fee, and only the payment methods you enabled." },
    { q: "Can I test before going live?", a: "You can sign up and prepare onboarding straight away. Live collection starts after KYB approval; ask the platform team about test credentials for your integration." },
];

/* -------------------------------------------------------------------------- */
/* Small presentational pieces                                                */
/* -------------------------------------------------------------------------- */

const StatCounter = defineComponent({
    name: "LandingStatCounter",
    props: {
        value: { type: Number, required: true },
        from: { type: Number, default: 0 },
        label: { type: String, required: true },
        index: { type: Number, default: 0 },
    },
    setup(props) {
        const { t } = useLocale();
        const reduced = useReducedMotion();
        const el = ref<HTMLElement | null>(null);
        const inView = useInView(el, "0px 0px -15% 0px");
        const shown = ref(reduced.value ? props.value : props.from);
        let started = false;
        let cancel: (() => void) | null = null;
        watch(inView, (visible) => {
            if (!visible || started) return;
            started = true;
            if (reduced.value) {
                shown.value = props.value;
                return;
            }
            cancel = animateProgress(1100 + props.index * 120, (p) => {
                shown.value = Math.round(props.from + (props.value - props.from) * p);
            });
        });
        onBeforeUnmount(() => cancel?.());
        return () => (
            <div ref={el} class="pgl-stat" data-reveal style={{ "--pgl-i": props.index }}>
                <span class="pgl-stat__value pgl-tabular" aria-hidden="true">
                    {shown.value}
                </span>
                <span class="pgl-sr-only">{props.value}</span>
                <span class="pgl-stat__label">{t(props.label)}</span>
            </div>
        );
    },
});

/** Mounts a heavy below-the-fold section only when it approaches the viewport. */
const useLazySection = (loader: () => Promise<{ default: Component }>, onLoaded: () => void) => {
    const anchor = ref<HTMLElement | null>(null);
    // Wrapped so Vue's ref unwrapping cannot collapse the Component union type.
    const comp = shallowRef<{ component: Component } | null>(null);
    const near = useInView(anchor, "600px 0px");
    const stop = watch(
        near,
        async (value) => {
            if (!value || comp.value) return;
            const mod = await loader();
            comp.value = { component: markRaw(mod.default) };
            await nextTick();
            onLoaded();
            stop();
        },
        { immediate: true },
    );
    return { anchor, comp };
};

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

const LandingPage = defineComponent({
    name: "LandingPage",
    setup() {
        const { t, current: locale } = useLocale();
        const reduced = useReducedMotion();
        const root = ref<HTMLElement | null>(null);
        const scrolled = ref(false);
        const reveal = useReveal(root, reduced);
        const isRtl = computed(() => locale.value === "ar");
        const year = new Date().getFullYear();

        const developer = useLazySection(() => import("./DeveloperSection"), () => reveal.refresh());
        const heroStage = ref<HTMLElement | null>(null);
        const marqueePaused = ref(false);
        const activeSection = useActiveSection(NAV.map((item) => item.id));
        useSpotlight(root, reduced);
        useTilt(heroStage, reduced);

        const onScroll = () => {
            scrolled.value = window.scrollY > 8;
        };

        const syncDocumentMeta = () => {
            document.title = `${t("Payment Gateway")} · ${t("Collect on any rail. Reconcile every dinar.")}`;
            let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
            if (!meta) {
                meta = document.createElement("meta");
                meta.name = "description";
                document.head.appendChild(meta);
            }
            meta.content = t(
                "Payment links, in-store POS screens and a server API for Libyan businesses, backed by a bilingual hosted checkout and a double-entry ledger.",
            );
        };

        onMounted(() => {
            window.addEventListener("scroll", onScroll, { passive: true });
            onScroll();
            syncDocumentMeta();
        });
        onBeforeUnmount(() => window.removeEventListener("scroll", onScroll));
        watch(locale, () => syncDocumentMeta());

        const switchLocale = (next: "ar" | "en") => {
            if (locale.value === next) return;
            withViewTransition(() => setLocale(next), reduced.value);
        };

        const jumpTo = (event: MouseEvent, id: string) => {
            const target = document.getElementById(id);
            if (!target) return;
            event.preventDefault();
            target.scrollIntoView({ behavior: reduced.value ? "auto" : "smooth", block: "start" });
            target.focus({ preventScroll: true });
            history.replaceState(history.state, "", `#${id}`);
        };

        const sectionHead = (id: string, eyebrow: string, title: string, lede?: string) => (
            <header class="pgl-section-head" data-reveal>
                <p class="pgl-eyebrow">{t(eyebrow)}</p>
                <h2 id={`${id}-title`} class="pgl-h2">
                    {t(title)}
                </h2>
                {lede && <p class="pgl-lede">{t(lede)}</p>}
            </header>
        );

        const brand = () => (
            <span class="pgl-brand">
                <span class="pgl-brand__mark">
                    <img src={LogoSvg} alt="" width={22} height={22} />
                </span>
                <span class="pgl-brand__text">
                    <span class="pgl-brand__name">{t("Payment Gateway")}</span>
                    <span class="pgl-brand__sub">{t("Merchant Portal")}</span>
                </span>
            </span>
        );

        /** The headline, one box per word so the entrance can stagger them. */
        const headline = () => {
            const first = splitWords(t("Collect on any rail."));
            const second = splitWords(t("Reconcile every dinar."));
            let order = 0;
            return (
                <h1 id="pgl-hero-title" class="pgl-h1">
                    <span class="pgl-h1__line">
                        {first.map((word) => [
                            <span key={`a-${order}`} class="pgl-word" style={{ "--w": order++ }}>
                                {word}
                            </span>,
                            " ",
                        ])}
                    </span>
                    <span class="pgl-h1__line pgl-h1__line--accent">
                        {second.map((word, index) =>
                            index === second.length - 1 ? (
                                <span key="em" class="pgl-h1__em">
                                    <span class="pgl-word" style={{ "--w": order++, "--k": index }}>
                                        {word}
                                    </span>
                                    <svg class="pgl-underline" viewBox="0 0 200 12" preserveAspectRatio="none" aria-hidden="true">
                                        <defs>
                                            <linearGradient id="pgl-underline-grad" x1="0" x2="1" y1="0" y2="0">
                                                <stop offset="0" stop-color="#3a63ff" />
                                                <stop offset="0.55" stop-color="#7a55ff" />
                                                <stop offset="1" stop-color="#0fb5a3" />
                                            </linearGradient>
                                        </defs>
                                        <path d="M3 8 C 40 2, 90 12, 130 6 S 185 4, 197 7" pathLength="300" />
                                    </svg>
                                </span>
                            ) : (
                                [
                                    <span key={`b-${index}`} class="pgl-word" style={{ "--w": order++, "--k": index }}>
                                        {word}
                                    </span>,
                                    " ",
                                ]
                            ),
                        )}
                    </span>
                </h1>
            );
        };

        return () => (
            <div ref={root} class="pgl-root" data-motion={reveal.active.value ? "on" : "off"}>
                <a class="pgl-skip" href="#pgl-main" onClick={(e: MouseEvent) => jumpTo(e, "pgl-main")}>
                    {t("Skip to main content")}
                </a>

                <span class="pgl-progress" aria-hidden="true" />

                {/* ------------------------------------------------ Header */}
                <header class="pgl-header" data-scrolled={scrolled.value ? "" : undefined}>
                    <div class="pgl-container pgl-header__inner">
                        <a href="#pgl-main" class="pgl-brand-link" aria-label={t("Payment Gateway")} onClick={(e: MouseEvent) => jumpTo(e, "pgl-main")}>
                            {brand()}
                        </a>
                        <nav class="pgl-nav" aria-label={t("Sections")}>
                            {NAV.map((item) => (
                                <a
                                    key={item.id}
                                    href={`#${item.id}`}
                                    aria-current={activeSection.value === item.id ? "true" : undefined}
                                    onClick={(e: MouseEvent) => jumpTo(e, item.id)}
                                >
                                    {t(item.label)}
                                </a>
                            ))}
                        </nav>
                        <div class="pgl-header__actions">
                            <div class="pgl-lang" role="group" aria-label={t("Language")}>
                                <button
                                    type="button"
                                    lang="ar"
                                    aria-pressed={locale.value === "ar" ? "true" : "false"}
                                    onClick={() => switchLocale("ar")}
                                >
                                    ع
                                    <span class="pgl-sr-only">العربية</span>
                                </button>
                                <button
                                    type="button"
                                    lang="en"
                                    aria-pressed={locale.value === "en" ? "true" : "false"}
                                    onClick={() => switchLocale("en")}
                                >
                                    EN
                                    <span class="pgl-sr-only">English</span>
                                </button>
                            </div>
                            <ThemeMenu buttonClass="pgl-icon-btn" iconSize={17} />
                            <VBtn to={{ name: "Login" }} variant="text" class="pgl-header__login">
                                {t("Login")}
                            </VBtn>
                            <VBtn to={{ name: "Register" }} color="primary" class="pgl-header__cta">
                                {t("Get started")}
                            </VBtn>
                        </div>
                    </div>
                </header>

                <main id="pgl-main" tabindex={-1} class="pgl-main">
                    {/* ------------------------------------------------ Hero */}
                    <section class="pgl-hero" aria-labelledby="pgl-hero-title">
                        <div class="pgl-hero__bg" aria-hidden="true">
                            <span class="pgl-aurora pgl-aurora--a" />
                            <span class="pgl-aurora pgl-aurora--b" />
                            <span class="pgl-aurora pgl-aurora--c" />
                            <span class="pgl-grid-bg" />
                            <span class="pgl-grain" />
                        </div>
                        <div class="pgl-container pgl-hero__grid">
                            <div class="pgl-hero__copy">
                                <p class="pgl-eyebrow pgl-eyebrow--pill">
                                    <span class="pgl-pulse" aria-hidden="true" />
                                    {t("Built for Libyan businesses")}
                                </p>
                                {headline()}
                                <p class="pgl-lede pgl-lede--hero">
                                    {t(
                                        "Payment links, in-store POS screens and a server API — one KYB-verified merchant account, a bilingual hosted checkout, and a double-entry ledger behind every balance.",
                                    )}
                                </p>
                                <div class="pgl-cta-row">
                                    <VBtn to={{ name: "Register" }} color="primary" size="large" class="pgl-btn-primary" appendIcon={isRtl.value ? "mdi-arrow-left" : "mdi-arrow-right"}>
                                        {t("Create a merchant account")}
                                    </VBtn>
                                    <VBtn to={{ name: "Login" }} variant="outlined" size="large" class="pgl-btn-secondary">
                                        {t("Sign in to the portal")}
                                    </VBtn>
                                </div>
                                <ul class="pgl-hero__proof">
                                    {["Bilingual hosted checkout", "KYB-verified before live money", "Ledger-derived balances"].map((item) => (
                                        <li key={item}>
                                            <VIcon icon="mdi-check-circle" size={16} aria-hidden="true" />
                                            {t(item)}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                            <div ref={heroStage} class="pgl-hero__demo">
                                <span class="pgl-stage-glow" aria-hidden="true" />
                                <span class="pgl-float pgl-float--a" aria-hidden="true">
                                    <VIcon icon="mdi-shield-check-outline" size={16} />
                                    {t("Trusted confirmation")}
                                </span>
                                <span class="pgl-float pgl-float--b" aria-hidden="true">
                                    <VIcon icon="mdi-scale-balance" size={16} />
                                    {/* dir on an inner span: `dir` on the positioned element would flip its own inset-inline-end. */}
                                    <span class="pgl-mono" dir="ltr">
                                        Σ Dr = Σ Cr
                                    </span>
                                </span>
                                <HeroDemo />
                            </div>
                        </div>
                    </section>

                    {/* ------------------------------------------------ Rail ticker */}
                    <div class="pgl-marquee-wrap">
                        <section class="pgl-marquee" aria-label={t("Capabilities")} data-paused={marqueePaused.value ? "" : undefined}>
                            <div class="pgl-marquee__track">
                                {[0, 1].map((copy) => (
                                    <ul key={copy} class="pgl-marquee__group" aria-hidden={copy === 1 ? "true" : undefined}>
                                        {MARQUEE.map((item) => (
                                            <li key={item.label} class="pgl-marquee__item">
                                                <VIcon icon={item.icon} size={18} aria-hidden="true" />
                                                {t(item.label)}
                                            </li>
                                        ))}
                                    </ul>
                                ))}
                            </div>
                        </section>
                        <button
                            type="button"
                            class="pgl-icon-btn pgl-marquee__toggle"
                            aria-pressed={marqueePaused.value ? "true" : "false"}
                            aria-label={marqueePaused.value ? t("Play ticker") : t("Pause ticker")}
                            onClick={() => (marqueePaused.value = !marqueePaused.value)}
                        >
                            <VIcon icon={marqueePaused.value ? "mdi-play" : "mdi-pause"} size={16} aria-hidden="true" />
                        </button>
                    </div>

                    {/* ------------------------------------------------ Flow */}
                    <section id="pgl-flow" class="pgl-section" tabindex={-1} aria-labelledby="pgl-flow-title">
                        <div class="pgl-container">
                            {sectionHead(
                                "pgl-flow",
                                "How money moves",
                                "From a shared link to a reconciled wallet",
                                "Every step is a real state in the platform, so what you see in the portal is what happened.",
                            )}
                            <div class="pgl-flow" data-reveal>
                                <span class="pgl-flow__track" aria-hidden="true">
                                    <span class="pgl-flow__runner" />
                                </span>
                                <ol class="pgl-flow__list">
                                {FLOW.map((node, index) => (
                                    <li key={node.title} class="pgl-flow__node" style={{ "--pgl-i": index }}>
                                        <span class="pgl-flow__icon" aria-hidden="true">
                                            <VIcon icon={node.icon} size={20} />
                                        </span>
                                        <h3 class="pgl-h4">{t(node.title)}</h3>
                                        <p>{t(node.text)}</p>
                                        <span class="pgl-chip pgl-mono" dir="ltr">
                                            {node.chip}
                                        </span>
                                    </li>
                                ))}
                                </ol>
                            </div>
                        </div>
                    </section>

                    {/* ------------------------------------------------ Bento */}
                    <section id="pgl-product" class="pgl-section pgl-section--alt" tabindex={-1} aria-labelledby="pgl-product-title">
                        <div class="pgl-container">
                            {sectionHead(
                                "pgl-product",
                                "Product",
                                "Everything a Libyan merchant needs to get paid",
                                "Online, in store and from your own systems — one workspace, one ledger.",
                            )}
                            <div class="pgl-bento">
                                {/* Links */}
                                <article data-spot="" class="pgl-cell pgl-cell--links" data-reveal style={{ "--pgl-i": 0 }}>
                                    <div class="pgl-cell__text">
                                        <h3 class="pgl-h3">{t("Payment links & QR")}</h3>
                                        <p>{t("Single-use or multi-use links with expiry, a rail whitelist and a QR code. Share them anywhere; the amount is locked on the server.")}</p>
                                        <ul class="pgl-tags">
                                            {["Single-use", "Multi-use", "Expiry", "Rail whitelist"].map((tag) => (
                                                <li key={tag}>{t(tag)}</li>
                                            ))}
                                        </ul>
                                    </div>
                                    <div class="pgl-mini-link" aria-hidden="true">
                                        <div class="pgl-mini-link__qr">
                                            <VIcon icon="mdi-qrcode" size={64} />
                                        </div>
                                        <div class="pgl-mini-link__meta">
                                            <span class="pgl-mono" dir="ltr">
                                                pay.example.ly/pay/lnk_8F2K…
                                            </span>
                                            <b class="pgl-tabular" dir="ltr">
                                                250.000 LYD
                                            </b>
                                            <span class="pgl-mini-link__lock">
                                                <VIcon icon="mdi-lock" size={12} />
                                                {t("Server-priced")}
                                            </span>
                                        </div>
                                    </div>
                                </article>

                                {/* POS */}
                                <article data-spot="" class="pgl-cell pgl-cell--pos" data-reveal style={{ "--pgl-i": 1 }}>
                                    <h3 class="pgl-h3">{t("Live POS screens")}</h3>
                                    <p>{t("Pair a cashier terminal with a customer-facing screen that updates in real time.")}</p>
                                    <div class="pgl-pos" aria-hidden="true">
                                        <span class="pgl-pos__live">
                                            <span class="pgl-pulse" />
                                            {t("Live")}
                                        </span>
                                        <b class="pgl-tabular" dir="ltr">
                                            86.500 LYD
                                        </b>
                                        <span class="pgl-pos__status">
                                            <span class="pgl-pos__s1">{t("Waiting for payment")}</span>
                                            <span class="pgl-pos__s2">{t("Paid")}</span>
                                        </span>
                                    </div>
                                </article>

                                {/* Fees */}
                                <article data-spot="" class="pgl-cell pgl-cell--fees" data-reveal style={{ "--pgl-i": 2 }}>
                                    <h3 class="pgl-h3">{t("Fees you can see")}</h3>
                                    <p>{t("Absorb the fee, pass it to the payer, or split it. Try it:")}</p>
                                    <FeePreview />
                                </article>

                                {/* Wallets */}
                                <article data-spot="" class="pgl-cell pgl-cell--wallet" data-reveal style={{ "--pgl-i": 3 }}>
                                    <h3 class="pgl-h3">{t("Wallets & sealed statements")}</h3>
                                    <p>{t("Balances come from the ledger, not an editable number. Monthly statements carry a snapshot hash and export to Excel.")}</p>
                                    <dl class="pgl-statement" aria-hidden="true">
                                        <div>
                                            <dt>{t("Opening balance")}</dt>
                                            <dd class="pgl-tabular" dir="ltr">12,480.000</dd>
                                        </div>
                                        <div>
                                            <dt>{t("Net credits")}</dt>
                                            <dd class="pgl-tabular pgl-pos-num" dir="ltr">+48,215.250</dd>
                                        </div>
                                        <div>
                                            <dt>{t("Cash-outs")}</dt>
                                            <dd class="pgl-tabular" dir="ltr">−40,000.000</dd>
                                        </div>
                                        <div class="pgl-statement__total">
                                            <dt>{t("Closing balance")}</dt>
                                            <dd class="pgl-tabular" dir="ltr">20,695.250</dd>
                                        </div>
                                        <div class="pgl-statement__hash">
                                            <dt>{t("Snapshot hash")}</dt>
                                            <dd class="pgl-mono" dir="ltr">9f2c…e41a</dd>
                                        </div>
                                    </dl>
                                </article>

                                {/* Maker-checker */}
                                <article data-spot="" class="pgl-cell pgl-cell--small" data-reveal style={{ "--pgl-i": 4 }}>
                                    <div class="pgl-mc" aria-hidden="true">
                                        <span class="pgl-mc__avatar">M</span>
                                        <span class="pgl-mc__line" />
                                        <span class="pgl-mc__avatar pgl-mc__avatar--c">C</span>
                                    </div>
                                    <h3 class="pgl-h3">{t("Four-eyes changes")}</h3>
                                    <p>{t("Sensitive application changes are proposals until a second person approves them.")}</p>
                                </article>

                                {/* Disputes */}
                                <article data-spot="" class="pgl-cell pgl-cell--small" data-reveal style={{ "--pgl-i": 5 }}>
                                    <span class="pgl-icon-tile" aria-hidden="true">
                                        <VIcon icon="mdi-timer-sand" size={18} />
                                    </span>
                                    <h3 class="pgl-h3">{t("Disputes with deadlines")}</h3>
                                    <p>{t("See every chargeback, its evidence deadline, and upload your evidence in time.")}</p>
                                </article>

                                {/* Team */}
                                <article data-spot="" class="pgl-cell pgl-cell--small" data-reveal style={{ "--pgl-i": 6 }}>
                                    <span class="pgl-icon-tile" aria-hidden="true">
                                        <VIcon icon="mdi-account-group-outline" size={18} />
                                    </span>
                                    <h3 class="pgl-h3">{t("Roles for your team")}</h3>
                                    <p>{t("Invite owners, accountants, cashiers and developers with scoped authorities.")}</p>
                                </article>

                                {/* Merchant direct */}
                                <article data-spot="" class="pgl-cell pgl-cell--small" data-reveal style={{ "--pgl-i": 7 }}>
                                    <span class="pgl-icon-tile" aria-hidden="true">
                                        <VIcon icon="mdi-bank-outline" size={18} />
                                    </span>
                                    <h3 class="pgl-h3">{t("Bring your own gateway")}</h3>
                                    <p>{t("Use your own gateway credentials and settle directly; the platform records only its commission.")}</p>
                                </article>
                            </div>
                        </div>
                    </section>

                    {/* ------------------------------------------------ Stats */}
                    <section class="pgl-stats" aria-label={t("At a glance")}>
                        <div class="pgl-container pgl-stats__grid">
                            {STATS.map((stat, index) => (
                                <StatCounter key={stat.label} value={stat.value} from={stat.from} label={stat.label} index={index} />
                            ))}
                        </div>
                    </section>

                    {/* ------------------------------------------------ Developers (lazy) */}
                    <section id="pgl-developers" class="pgl-section" tabindex={-1} aria-labelledby="pgl-developers-title">
                        <div class="pgl-container">
                            {sectionHead(
                                "pgl-developers",
                                "Developers",
                                "Create a link from your backend in one request",
                                "A small, strict server API: create, read and cancel links, and look up payments by reference.",
                            )}
                            <div ref={developer.anchor} class="pgl-lazy" data-loaded={developer.comp.value ? "" : undefined}>
                                {developer.comp.value ? h(developer.comp.value.component) : <div class="pgl-lazy__placeholder" aria-hidden="true" />}
                            </div>
                        </div>
                    </section>

                    {/* ------------------------------------------------ Security */}
                    <section id="pgl-security" class="pgl-section pgl-section--alt" tabindex={-1} aria-labelledby="pgl-security-title">
                        <div class="pgl-container">
                            {sectionHead(
                                "pgl-security",
                                "Security & compliance",
                                "Controls a central-bank auditor expects",
                                "Designed around four-eyes governance, KYB/AML and an immutable ledger.",
                            )}
                            <div class="pgl-security">
                                <ul class="pgl-security__list">
                                    {SECURITY.map((item, index) => (
                                        <li key={item.title} data-reveal style={{ "--pgl-i": index }}>
                                            <span class="pgl-icon-tile" aria-hidden="true">
                                                <VIcon icon={item.icon} size={18} />
                                            </span>
                                            <div>
                                                <h3 class="pgl-h4">{t(item.title)}</h3>
                                                <p>{t(item.text)}</p>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                                <LedgerTicker />
                            </div>
                        </div>
                    </section>

                    {/* ------------------------------------------------ Onboarding */}
                    <section id="pgl-onboarding" class="pgl-section" tabindex={-1} aria-labelledby="pgl-onboarding-title">
                        <div class="pgl-container">
                            {sectionHead(
                                "pgl-onboarding",
                                "Onboarding",
                                "From sign-up to your first payment",
                                "The same steps you will see in the portal's onboarding page.",
                            )}
                            <ol class="pgl-steps" data-reveal>
                                {ONBOARDING.map((item, index) => (
                                    <li key={item.title} style={{ "--pgl-i": index }}>
                                        <span class="pgl-steps__num pgl-tabular" aria-hidden="true">
                                            {index + 1}
                                        </span>
                                        <h3 class="pgl-h4">{t(item.title)}</h3>
                                        <p>{t(item.text)}</p>
                                    </li>
                                ))}
                            </ol>
                        </div>
                    </section>

                    {/* ------------------------------------------------ FAQ */}
                    <section id="pgl-faq" class="pgl-section pgl-section--alt" tabindex={-1} aria-labelledby="pgl-faq-title">
                        <div class="pgl-container pgl-faq">
                            {sectionHead("pgl-faq", "FAQ", "Straight answers")}
                            <div class="pgl-faq__list" data-reveal>
                                {FAQ.map((item) => (
                                    <details key={item.q} class="pgl-faq__item">
                                        <summary>
                                            <span>{t(item.q)}</span>
                                            <VIcon icon="mdi-plus" size={18} aria-hidden="true" class="pgl-faq__icon" />
                                        </summary>
                                        <p>{t(item.a)}</p>
                                    </details>
                                ))}
                            </div>
                        </div>
                    </section>

                    {/* ------------------------------------------------ Final CTA */}
                    <section class="pgl-final" aria-labelledby="pgl-final-title">
                        <div class="pgl-container pgl-final__inner" data-reveal>
                            <h2 id="pgl-final-title" class="pgl-h2">
                                {t("Start collecting with confidence.")}
                            </h2>
                            <p class="pgl-lede">{t("Create your account now and finish onboarding at your own pace.")}</p>
                            <div class="pgl-cta-row pgl-cta-row--center">
                                <VBtn to={{ name: "Register" }} color="primary" size="large" class="pgl-btn-primary">
                                    {t("Create a merchant account")}
                                </VBtn>
                                <VBtn to={{ name: "Login" }} variant="outlined" size="large" class="pgl-btn-secondary">
                                    {t("Sign in to the portal")}
                                </VBtn>
                            </div>
                            <ul class="pgl-final__proof">
                                {["Bilingual hosted checkout", "KYB-verified before live money", "Ledger-derived balances"].map((item) => (
                                    <li key={item}>
                                        <VIcon icon="mdi-check-circle" size={16} aria-hidden="true" />
                                        {t(item)}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </section>
                </main>

                {/* ------------------------------------------------ Footer */}
                <footer class="pgl-footer">
                    <div class="pgl-container pgl-footer__inner">
                        {brand()}
                        <nav aria-label={t("Footer")} class="pgl-footer__links">
                            <VBtn to={{ name: "Register" }} variant="text" size="small">
                                {t("Create account")}
                            </VBtn>
                            <VBtn to={{ name: "Login" }} variant="text" size="small">
                                {t("Login")}
                            </VBtn>
                            <VBtn to={{ name: "MerchantGuide" }} variant="text" size="small">
                                {t("Merchant guide")}
                            </VBtn>
                            <VBtn to={{ name: "MerchantDeveloperGuide" }} variant="text" size="small">
                                {t("Developer guide")}
                            </VBtn>
                        </nav>
                        <span class="pgl-footer__copy">
                            © <span class="pgl-tabular">{year}</span> {t("Payment Gateway")}
                        </span>
                    </div>
                </footer>
            </div>
        );
    },
});

export default LandingPage;
