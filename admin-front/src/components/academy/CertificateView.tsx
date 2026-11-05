import { dc } from "kt-dc";
import { RouterLink } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn, VIcon } from "vuetify/components";
import LogoSvg from "@/assets/images/logo.svg";
import { GuideMarkdown } from "@/components/guide/GuideMarkdown";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import type { AcademyBadge } from "@/content/academy/apiTypes";
import { BadgeChip } from "./BadgeChip";
import { fmtDate } from "./format";
import { Callout } from "./ui/Callout";
import type { BadgeState } from "./useAcademyProgress";

type Props = {
    badge: AcademyBadge;
    trackTitle: string;
    holderName: string;
    template: string;
    state: BadgeState;
};

/**
 * Print rules are injected only while the certificate page is mounted (never global): a global
 * `body * { visibility: hidden }` would blank every other printable page. Only the sheet prints.
 * Hard-coded black on white is intentional here: paper ignores the dark theme tokens.
 */
const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 18mm; }
  body * { visibility: hidden !important; }
  .pg-cert-sheet, .pg-cert-sheet * { visibility: visible !important; color: #000 !important; }
  .pg-cert-sheet { position: absolute !important; inset-inline: 0; inset-block-start: 0; max-inline-size: none !important; margin: 0 !important; box-shadow: none !important; border: 3px double #444 !important; border-radius: 0 !important; background: #fff !important; }
  .pg-cert-sheet .ac-cert-frame { border: 0 !important; }
  .pg-cert-noprint { display: none !important; }
}
`;

/** Strip markdown control characters so a name or track title cannot inject formatting into the sheet. */
const clean = (value: string) => value.replace(/[*_`\[\]<>]/g, "");

/**
 * Certificate page body: the formal sheet (main) and a status aside. The print rules live in
 * `PRINT_CSS`: only `.pg-cert-sheet` prints, `.pg-cert-noprint` never does.
 */
export const CertificateView = dc((props: Props) => {
    const { t } = useLocale();
    return () => {
        const b = props.badge;
        const filled = props.template
            .replaceAll("{name}", clean(props.holderName))
            .replaceAll("{track}", clean(props.trackTitle))
            .replaceAll("{passedAt}", fmtDate(b.earnedAt))
            .replaceAll("{contentVersion}", clean(b.v))
            .replaceAll("{expiresAt}", fmtDate(b.expiresAt));
        const lapsed = props.state === "expired" || props.state === "recertify";
        return (
            <>
                <style innerHTML={PRINT_CSS} />
                <div class="ac-split ac-cert">
                    <div class="ac-cert__main">
                        <article class="pg-cert-sheet ac-cert-sheet" aria-label={t("Certificate")}>
                            <div class="ac-cert-frame">
                                <header class="ac-cert-head">
                                    <img class="ac-cert-mark" src={LogoSvg} alt="" width={44} height={44} />
                                    <p class="ac-cert-eyebrow">{t("Employee Academy")}</p>
                                    <h2 class="ac-cert-title">{t("Certificate of completion")}</h2>
                                </header>
                                <p class="ac-cert-track" dir="auto">{props.trackTitle}</p>
                                <div class="ac-cert-body" dir="auto">
                                    <GuideMarkdown source={filled} />
                                </div>
                                <footer class="ac-cert-foot">
                                    <span class="ac-cert-id pg-mono ac-ltr">{`ID: ${b.id}`}</span>
                                </footer>
                            </div>
                        </article>
                    </div>

                    <aside class="ac-aside pg-cert-noprint">
                        {lapsed && (
                            <Callout tone="danger" role="status">
                                {props.state === "expired"
                                    ? t("This certificate has expired. Recertification is required: pass the exam again to renew it.")
                                    : t("The Academy content has changed in a major way since this certificate was issued. Recertification is required.")}
                            </Callout>
                        )}
                        {props.state === "expiring" && (
                            <Callout tone="warning" role="status" icon="mdi-timer-sand">
                                {t("This certificate expires soon. You can renew it by passing the exam again.")}
                            </Callout>
                        )}

                        <SurfaceCard class="ac-card" title={t("Status")}>
                            <div class="ac-stack">
                                <div>
                                    <BadgeChip track={b.track} state={props.state === "none" ? "valid" : props.state} expiresAt={b.expiresAt} compact />
                                </div>
                                <DescriptionList
                                    items={[
                                        { label: t("Issued"), value: fmtDate(b.earnedAt) },
                                        { label: t("Valid until"), value: fmtDate(b.expiresAt) },
                                        { label: t("Content version"), value: b.v, mono: true },
                                    ]}
                                />
                                <VBtn color="primary" block prependIcon="mdi-printer-outline" onClick={() => window.print()}>
                                    {t("Print certificate")}
                                </VBtn>
                                <RouterLink class="ac-link ac-cert-back" to={{ name: "AdminAcademy" }}>
                                    <VIcon class="ac-flip" icon="mdi-arrow-left" size={16} />
                                    {t("Back to Academy")}
                                </RouterLink>
                            </div>
                        </SurfaceCard>
                    </aside>
                </div>
            </>
        );
    };
}, { props: ["badge", "trackTitle", "holderName", "template", "state"] });
