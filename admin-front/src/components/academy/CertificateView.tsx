import { dc } from "kt-dc";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import { GuideMarkdown } from "@/components/guide/GuideMarkdown";
import type { AcademyBadge } from "@/content/academy/apiTypes";
import { fmtDate } from "./exam/ExamBriefing";
import { BadgeChip } from "./BadgeChip";
import type { BadgeState } from "./useAcademyProgress";

type Props = {
    badge: AcademyBadge;
    trackTitle: string;
    holderName: string;
    template: string;
    state: BadgeState;
};

const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 18mm; }
  body * { visibility: hidden !important; }
  .pg-cert-sheet, .pg-cert-sheet * { visibility: visible !important; }
  .pg-cert-sheet { position: absolute !important; inset-inline: 0; inset-block-start: 0; box-shadow: none !important; border: 3px double #444 !important; background: #fff !important; color: #000 !important; }
  .pg-cert-noprint { display: none !important; }
}
`;

const clean = (value: string) => value.replace(/[*_`\[\]<>]/g, "");

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
            <div style={{ display: "flex", flexDirection: "column", gap: "14px", maxInlineSize: "820px" }}>
                <style innerHTML={PRINT_CSS} />
                {lapsed && (
                    <div role="status" class="pg-cert-noprint" style={{ padding: "12px 14px", borderRadius: "10px", border: "1px solid var(--pg-status-danger-border)", background: "var(--pg-status-danger-bg)", color: "var(--pg-status-danger-text)" }}>
                        ✕ {props.state === "expired" ? t("This certificate has expired. Recertification is required: pass the exam again to renew it.") : t("The Academy content has changed in a major way since this certificate was issued. Recertification is required.")}
                    </div>
                )}
                {props.state === "expiring" && (
                    <div role="status" class="pg-cert-noprint" style={{ padding: "12px 14px", borderRadius: "10px", border: "1px solid var(--pg-status-warning-border)", background: "var(--pg-status-warning-bg)", color: "var(--pg-status-warning-text)" }}>
                        ⏳ {t("This certificate expires soon. You can renew it by passing the exam again.")}
                    </div>
                )}
                <article
                    class="pg-cert-sheet"
                    aria-label={t("Certificate")}
                    style={{ padding: "40px 36px", border: "3px double var(--pg-border-subtle)", borderRadius: "12px", background: "var(--pg-bg-surface)", textAlign: "center", display: "flex", flexDirection: "column", gap: "14px", alignItems: "center" }}
                >
                    <div style={{ fontSize: "13px", letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.7 }}>{t("Employee Academy")}</div>
                    <h2 style={{ fontSize: "28px", margin: 0 }}>{t("Certificate of completion")}</h2>
                    <div style={{ fontSize: "20px", fontWeight: 600 }}>{props.trackTitle}</div>
                    <div class="pg-cert-noprint"><BadgeChip track={b.track} state={props.state === "none" ? "valid" : props.state} expiresAt={b.expiresAt} /></div>
                    <div style={{ textAlign: "start", lineHeight: 1.8, maxInlineSize: "620px" }}><GuideMarkdown source={filled} /></div>
                    <div style={{ fontSize: "11px", opacity: 0.6, direction: "ltr" }}>ID: {b.id}</div>
                </article>
                <div class="pg-cert-noprint">
                    <VBtn color="primary" onClick={() => window.print()}>{t("Print certificate")}</VBtn>
                </div>
            </div>
        );
    };
});
