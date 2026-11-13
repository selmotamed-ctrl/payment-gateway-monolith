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

type Detail = {
    application: { id: string; name: string; status: string; businessUseDescription: string | null; expectedMonthlyVolume: string; railWhitelist: string[] | null; redirectDomainAllowlist: string[] | null; createdAt: string };
    wallet: { id: string; name: string | null; currency: string; status: string };
    links: Array<{ id: string; key: string; title: string | null; amount: string; currency: string; state: string; useCount: number; confirmedCount: number; createdAt: string }>;
    payments: Array<{ id: string; reference: string; status: string; totalChargedAmount: string; currency: string; createdAt: string }>;
};

const SandboxApplicationDetailPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const detail = ref<Detail | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const applicationId = () => String(route.params.id ?? "");
    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            detail.value = await sandboxGet<Detail>(`/studio/applications/${encodeURIComponent(applicationId())}`);
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };
    void load();
    watch(() => route.params.id, () => void load());

    const linkHeaders: TableHeader<Detail["links"][number]>[] = [
        { key: "key", label: "Link key", Value: ({ row }) => <MonoRef value={row.key} truncate={18} /> },
        { key: "title", label: "Title", value: (row) => row.title ?? "—" },
        { key: "amount", label: "Amount", Value: ({ row }) => <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" /> },
        { key: "state", label: "State", Value: ({ row }) => <StatusBadge status={row.state} /> },
        { key: "uses", label: "Uses", value: (row) => `${row.confirmedCount}/${row.useCount}` },
        { key: "createdAt", label: "Created", value: (row) => row.createdAt },
        { key: "actions", label: "Actions", Value: ({ row }) => <VBtn size="small" variant="tonal" onClick={() => void router.push(`/sandbox/links/${row.id}`)}>{t("Open")}</VBtn> },
    ];
    const paymentHeaders: TableHeader<Detail["payments"][number]>[] = [
        { key: "reference", label: "Reference", Value: ({ row }) => <MonoRef value={row.reference} truncate={18} /> },
        { key: "status", label: "Status", Value: ({ row }) => <StatusBadge status={row.status} /> },
        { key: "totalChargedAmount", label: "Amount", Value: ({ row }) => <MoneyDisplay amount={row.totalChargedAmount} currency={row.currency} size="sm" /> },
        { key: "createdAt", label: "Created", value: (row) => row.createdAt },
        { key: "actions", label: "Actions", Value: ({ row }) => <VBtn size="small" variant="tonal" onClick={() => void router.push(`/sandbox/payments/${row.id}`)}>{t("Open")}</VBtn> },
    ];

    return () => (
        <ScreenContainer>
            <PageHeader title={detail.value?.application.name ?? t("Sandbox Application")} subtitle={detail.value?.application.id ?? applicationId()} badge="SANDBOX" badgeTone="warning" breadcrumbs={[{ label: t("Sandbox Applications"), to: "/sandbox/applications" }, { label: detail.value?.application.name ?? applicationId() }]} end={() => <VBtn variant="tonal" onClick={() => void router.push("/sandbox/applications")}>{t("Back")}</VBtn>} />
            <SandboxBanner />
            {error.value ? <VAlert type="error" variant="tonal" class="mb-4">{error.value}</VAlert> : null}
            <StateView loading={loading.value} minHeight="200px">
                {detail.value ? <div class="d-flex flex-column ga-4">
                    <SurfaceCard title={t("Application")}>
                        <DescriptionList columns={2} items={[
                            { label: t("Application ID"), value: <MonoRef value={detail.value.application.id} /> },
                            { label: t("Status"), value: <StatusBadge status={detail.value.application.status} /> },
                            { label: t("Wallet"), value: `${detail.value.wallet.name || detail.value.wallet.id.slice(0, 8)} · ${detail.value.wallet.currency}` },
                            { label: t("Wallet status"), value: <StatusBadge status={detail.value.wallet.status} /> },
                            { label: t("Expected monthly volume"), value: <MoneyDisplay amount={detail.value.application.expectedMonthlyVolume} currency={detail.value.wallet.currency} size="sm" /> },
                            { label: t("Rail whitelist"), value: detail.value.application.railWhitelist?.join(", ") || t("All") },
                            { label: t("Redirect domains"), value: detail.value.application.redirectDomainAllowlist?.join(", ") || "—" },
                            { label: t("Created"), value: detail.value.application.createdAt },
                        ]} />
                        {detail.value.application.businessUseDescription ? <p class="text-caption text-medium-emphasis mt-3">{detail.value.application.businessUseDescription}</p> : null}
                    </SurfaceCard>
                    <DataTable title={t("Payment links")} data={detail.value.links} headers={linkHeaders} loading={false} showNumber={true} xlsx={false} noElevation={true} numberOfItemsPerPage={20} />
                    {detail.value.payments.length > 0 ? <DataTable title={t("Recent payments")} data={detail.value.payments} headers={paymentHeaders} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={20} /> : <EmptyState title={t("No payments yet")} />}
                </div> : null}
            </StateView>
        </ScreenContainer>
    );
});

export default SandboxApplicationDetailPage;
