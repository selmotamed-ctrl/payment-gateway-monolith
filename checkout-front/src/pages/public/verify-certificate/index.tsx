import { dc } from "kt-dc";
import { onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { useRoute } from "vue-router";
import { VAlert, VBtn, VIcon, VProgressCircular } from "vuetify/components";
import CheckoutLayout from "@/layouts/checkout";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { api } from "@/state/api";
import { extractApiError } from "@/utils/errors/extractor";

type CertificateResult = {
    certificateId: string;
    publicId: string;
    status: "valid" | "expired" | "revoked";
    holderName: string;
    trackId: string;
    trackTitle: string;
    badgeCode: string;
    earnedAt: string;
    expiresAt: string;
    contentVersion: string;
};

const formatDate = (value: string): string => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
};

const VerifyCertificatePage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const loading = ref(true);
    const error = ref<string | null>(null);
    const certificate = ref<CertificateResult | null>(null);

    onMounted(async () => {
        const publicId = String(route.params.publicId ?? "");
        if (!publicId) {
            error.value = t("The certificate link is incomplete");
            loading.value = false;
            return;
        }
        try {
            const response = await api.get(`/v1/verify/certificate/${encodeURIComponent(publicId)}`);
            certificate.value = (response.data?.data ?? response.data) as CertificateResult;
        } catch (caught) {
            error.value = extractApiError(caught)?.error ?? t("The certificate could not be verified");
        } finally {
            loading.value = false;
        }
    });

    return () => (
        <CheckoutLayout title={t("Certificate verification")}>
            <SurfaceCard style={{ width: "100%", maxWidth: "620px" }}>
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    {loading.value ? (
                        <div style={{ display: "flex", justifyContent: "center", padding: "32px" }}>
                            <VProgressCircular indeterminate color="primary" />
                        </div>
                    ) : error.value ? (
                        <>
                            <VAlert type="error" variant="tonal">{error.value}</VAlert>
                            <div style={{ display: "flex", justifyContent: "center" }}>
                                <VBtn variant="tonal" onClick={() => window.location.reload()}>{t("Try again")}</VBtn>
                            </div>
                        </>
                    ) : certificate.value ? (
                        <>
                            <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                                <VIcon
                                    icon={certificate.value.status === "valid" ? "mdi-certificate-outline" : certificate.value.status === "revoked" ? "mdi-cancel" : "mdi-alert-circle-outline"}
                                    color={certificate.value.status === "valid" ? "success" : "warning"}
                                    size={42}
                                />
                                <div>
                                    <div style={{ fontSize: "18px", fontWeight: 700 }}>
                                        {certificate.value.status === "valid"
                                            ? t("Valid certificate")
                                            : certificate.value.status === "revoked"
                                                ? t("Revoked certificate")
                                                : t("Expired certificate")}
                                    </div>
                                    <div style={{ opacity: 0.7, fontSize: "13px" }}>
                                        {t("Payment Gateway Academy")}
                                    </div>
                                </div>
                            </div>
                            {certificate.value.status === "expired" && (
                                <VAlert type="warning" variant="tonal">
                                    {t("This certificate has expired. The holder must recertify to renew it.")}
                                </VAlert>
                            )}
                            {certificate.value.status === "revoked" && (
                                <VAlert type="error" variant="tonal">
                                    {t("This certificate was revoked by the issuer and is not valid. Contact the Academy administrator for details.")}
                                </VAlert>
                            )}
                            <dl class="certificate-verify__facts">
                                <div><dt>{t("Holder")}</dt><dd>{certificate.value.holderName}</dd></div>
                                <div><dt>{t("Track")}</dt><dd>{certificate.value.trackTitle}</dd></div>
                                <div><dt>{t("Certificate ID")}</dt><dd>{certificate.value.certificateId}</dd></div>
                                <div><dt>{t("Badge")}</dt><dd>{certificate.value.badgeCode}</dd></div>
                                <div><dt>{t("Earned")}</dt><dd>{formatDate(certificate.value.earnedAt)}</dd></div>
                                <div><dt>{t("Expires")}</dt><dd>{formatDate(certificate.value.expiresAt)}</dd></div>
                                <div><dt>{t("Content version")}</dt><dd>{certificate.value.contentVersion}</dd></div>
                            </dl>
                            <p style={{ fontSize: "12px", opacity: 0.65, margin: 0 }}>
                                {t("Verification confirms the issuer's record at the time of this check. It does not expose account or employment data.")}
                            </p>
                        </>
                    ) : null}
                </SurfaceCardText>
            </SurfaceCard>
        </CheckoutLayout>
    );
});

export default VerifyCertificatePage;
