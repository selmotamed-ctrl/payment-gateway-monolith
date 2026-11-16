import { dc } from "kt-dc";
import { ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { VAlert, VBtn } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
import { EmptyState } from "@/components/ui/EmptyState";
import { StateView } from "@/components/StateView";
import { SandboxBanner } from "@/components/sandbox/SandboxBanner";
import { sandboxGet } from "@/api/sandbox";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { buildCheckoutUrl } from "@/utils/security/checkoutUrl";
import { copyToClipboard } from "@/utils/common";
import { showSnackBar } from "@/utils/snackBar";

type Detail = {
    link: { id: string; key: string; title: string | null; description: string | null; amount: string; currency: string; state: string; feeBearer: string; useCount: number; confirmedCount: number; activeLockedCount: number; infiniteUse: boolean; expiresAt: string | null; redirectUrl: string | null; railWhitelist: string[] | null; createdAt: string };
    application: { id: string; name: string; status: string };
    wallet: { id: string; name: string | null; currency: string; status: string };
    attempts: Array<{ id: string; reference: string; status: string; totalChargedAmount: string; currency: string; createdAt: string; terminalAt: string | null }>;
};

const SandboxLinkDetailPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const detail = ref<Detail | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const linkId = () => String(route.params.id ?? "");
    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            detail.value = await sandboxGet<Detail>(`/studio/links/${encodeURIComponent(linkId())}`);
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };
    void load();
    watch(() => route.params.id, () => void load());
    const checkoutUrl = () => detail.value ? buildCheckoutUrl(detail.value.link.key, import.meta.env.VITE_CHECKOUT_BASE_URL, location.origin) : "";
    const attemptHeaders: TableHeader<Detail["attempts"][number]>[] = [
        { key: "reference", label: "Reference", Value: ({ row }) => <MonoRef value={row.reference} truncate={18} /> },
        { key: "status", label: "Status", Value: ({ row }) => <StatusBadge status={row.status} /> },
        { key: "totalChargedAmount", label: "Amount", Value: ({ row }) => <MoneyDisplay amount={row.totalChargedAmount} currency={row.currency} size="sm" /> },
        { key: "createdAt", label: "Created", value: (row) => row.createdAt },
        { key: "actions", label: "Actions", Value: ({ row }) => <VBtn size="small" variant="tonal" onClick={() => void router.push(`/sandbox/payments/${row.id}`)}>{t("Open")}</VBtn> },
    ];

    return () => (
        <ScreenContainer>
            <PageHeader title={detail.value?.link.title ?? t("Sandbox Link")} subtitle={detail.value?.link.key ?? linkId()} badge="SANDBOX" badgeTone="warning" breadcrumbs={[{ label: t("Sandbox Checkout Links"), to: "/sandbox/links" }, { label: detail.value?.link.key ?? linkId() }]} end={() => <div class="d-flex flex-wrap ga-2"><VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => void load()}>{t("Refresh")}</VBtn><VBtn variant="tonal" prependIcon="mdi-content-copy" onClick={() => { copyToClipboard(checkoutUrl()); showSnackBar({ type: "success", message: t("Copied") }); }}>{t("Copy checkout URL")}</VBtn><VBtn color="primary" prependIcon="mdi-open-in-new" onClick={() => window.open(checkoutUrl(), "_blank", "noopener")}>{t("Open checkout")}</VBtn></div>} />
            <SandboxBanner />
            {error.value ? <VAlert type="error" variant="tonal" class="mb-4">{error.value}</VAlert> : null}
            <StateView loading={loading.value} minHeight="200px">
                {detail.value ? <div class="d-flex flex-column ga-4">
                    <SurfaceCard title={t("Link")}>
                        <DescriptionList columns={2} items={[
                            { label: t("Link key"), value: <MonoRef value={detail.value.link.key} /> },
                            { label: t("State"), value: <StatusBadge status={detail.value.link.state} /> },
                            { label: t("Amount"), value: <MoneyDisplay amount={detail.value.link.amount} currency={detail.value.link.currency} size="sm" /> },
                            { label: t("Fee bearer"), value: detail.value.link.feeBearer },
                            { label: t("Uses"), value: `${detail.value.link.confirmedCount}/${detail.value.link.infiniteUse ? "∞" : detail.value.link.useCount}` },
                            { label: t("Active locks"), value: String(detail.value.link.activeLockedCount) },
                            { label: t("Application"), value: detail.value.application.name },
                            { label: t("Wallet"), value: detail.value.wallet.name || detail.value.wallet.id.slice(0, 8) },
                            { label: t("Expires"), value: detail.value.link.expiresAt ?? "—" },
                            { label: t("Redirect"), value: detail.value.link.redirectUrl ?? "—" },
                            { label: t("Allowed rails"), value: detail.value.link.railWhitelist?.join(", ") || t("All") },
                            { label: t("Created"), value: detail.value.link.createdAt },
                        ]} />
                        {detail.value.link.description ? <p class="text-caption text-medium-emphasis mt-3">{detail.value.link.description}</p> : null}
                    </SurfaceCard>
                    {detail.value.attempts.length > 0 ? <DataTable title={t("Payment attempts")} data={detail.value.attempts} headers={attemptHeaders} loading={false} showNumber={true} xlsx={false} noElevation={true} numberOfItemsPerPage={25} /> : <EmptyState title={t("No payment attempts yet")} />}
                </div> : null}
            </StateView>
        </ScreenContainer>
    );
});

export default SandboxLinkDetailPage;
