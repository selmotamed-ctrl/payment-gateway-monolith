import { computed, defineComponent, ref, watch, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VAutocomplete, VBtn, VSelect, VTextField } from "vuetify/components";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { FormField } from "@/components/ui/FormField";
import { MetaPill } from "@/components/ui/MetaPill";
import { createOptionsLoader } from "@/components/Table/referenceOptions";
import {
    addRedirectDomains,
    buildPolicyPatch,
    railChoices,
    railWhitelistModeOf,
    type PolicyDraft,
    type PolicyPatch,
    type RailChoice,
    type RailWhitelistMode,
} from "@/pages/applications/applicationActions";
import { reportCommerceError, runGoverned, notifyOutcome } from "../governedRequest";
import ReasonModal from "./ReasonModal";
import { RestrictedValue } from "./commerceBits";

export interface PolicyApplication {
    id: string;
    merchantId: string;
    assignedWalletId: string;
    assignedWallet: { id: string; currency: string; status: string };
    railWhitelist: string[] | null;
    redirectDomains: string[];
    redactedFields: string[];
}

type WalletChoice = { id: string; currency: string; status: string };

const railOptions = createOptionsLoader("rails");

/**
 * Policy edit (rail whitelist, redirect domains, settlement wallet). Every
 * change here widens or alters what the application may accept, so it is ALWAYS
 * an approval request (HTTP 202) and needs a reason.
 */
export const ApplicationPolicyModal = defineComponent({
    name: "ApplicationPolicyModal",
    props: {
        modelValue: { type: Boolean, required: true },
        application: { type: Object as PropType<PolicyApplication | null>, default: null },
    },
    emits: ["update:modelValue", "submitted"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const walletId = ref<string | null>(null);
        const railMode = ref<RailWhitelistMode>("ALL");
        const railCodes = ref<string[]>([]);
        const domains = ref<string[]>([]);
        const domainInput = ref("");
        const domainErrors = ref<string[]>([]);
        const rails = ref<RailChoice[]>([]);
        const wallets = ref<WalletChoice[]>([]);
        const submitting = ref(false);
        const errorMessage = ref("");

        const domainsRestricted = computed(() => props.application?.redactedFields.includes("redirectDomains") ?? false);

        const load = async (application: PolicyApplication) => {
            walletId.value = application.assignedWalletId;
            railMode.value = railWhitelistModeOf(application.railWhitelist);
            railCodes.value = [...(application.railWhitelist ?? [])];
            domains.value = [...application.redirectDomains];
            domainInput.value = "";
            domainErrors.value = [];
            errorMessage.value = "";
            rails.value = railChoices([], application.railWhitelist ?? []);
            wallets.value = [{ ...application.assignedWallet }];
            try {
                const loaded = await railOptions("");
                rails.value = railChoices(loaded, application.railWhitelist ?? []);
            } catch {
                // Keep the already whitelisted codes selectable.
            }
            try {
                const response = await api.get(urlsMap.walletsList, {
                    params: { merchantId: application.merchantId, currency: application.assignedWallet.currency, status: "ACTIVE", pageSize: 100 },
                });
                const payload = response.data?.data ?? response.data ?? {};
                const rows = (payload.wallets ?? []) as WalletChoice[];
                const merged = new Map<string, WalletChoice>(wallets.value.map((wallet) => [wallet.id, wallet]));
                for (const row of rows) merged.set(row.id, { id: row.id, currency: row.currency, status: row.status });
                wallets.value = [...merged.values()];
            } catch {
                // The current wallet stays selectable.
            }
        };

        watch(
            () => [props.modelValue, props.application?.id] as const,
            ([open]) => {
                if (open && props.application) void load(props.application);
            },
            { immediate: true },
        );

        const addDomains = () => {
            const result = addRedirectDomains(domains.value, domainInput.value);
            domains.value = result.domains;
            domainErrors.value = result.errors.map((entry) => `${entry.input}: ${t(entry.error)}`);
            if (result.errors.length === 0) domainInput.value = "";
        };

        const draft = (): PolicyDraft => ({
            assignedWalletId: walletId.value,
            railMode: railMode.value,
            railCodes: railCodes.value,
            redirectDomains: domainsRestricted.value ? props.application?.redirectDomains ?? [] : domains.value,
        });

        const submit = async (reason: string) => {
            const application = props.application;
            if (!application) return;
            const built = buildPolicyPatch(
                { assignedWalletId: application.assignedWalletId, railWhitelist: application.railWhitelist, redirectDomains: application.redirectDomains },
                draft(),
            );
            if (!built.ok) {
                errorMessage.value = t(built.error);
                return;
            }
            submitting.value = true;
            errorMessage.value = "";
            try {
                const patch: PolicyPatch = built.patch;
                const outcome = await runGoverned(() => api.patch(urlsMap.applicationDetail(application.id), { ...patch, reason }));
                notifyOutcome(outcome, "Application updated");
                emit("update:modelValue", false);
                emit("submitted", outcome);
            } catch (cause) {
                errorMessage.value = reportCommerceError(cause);
            } finally {
                submitting.value = false;
            }
        };

        return (): VNodeChild => (
            <ReasonModal
                modelValue={props.modelValue}
                onUpdate:modelValue={(value: boolean) => emit("update:modelValue", value)}
                title={t("Edit application policy")}
                description={t("Rail whitelist, redirect domains and the settlement wallet define what this application may accept. Any change is reviewed by an independent checker before it applies.")}
                mode="approval"
                submitLabel={t("Submit for approval")}
                loading={submitting.value}
                errorMessage={errorMessage.value}
                onSubmit={(reason: string) => void submit(reason)}
            >
                <FormField label={t("Settlement wallet")} hint={t("Only active wallets of this merchant in the same currency.")}>
                    <VSelect
                        modelValue={walletId.value}
                        onUpdate:modelValue={(value: string | null) => (walletId.value = value)}
                        items={wallets.value.map((wallet) => ({ title: `${wallet.currency} · ${wallet.id.slice(0, 8)} · ${wallet.status}`, value: wallet.id }))}
                        hideDetails
                    />
                </FormField>
                <FormField label={t("Rail whitelist")}>
                    <VSelect
                        modelValue={railMode.value}
                        onUpdate:modelValue={(value: RailWhitelistMode) => (railMode.value = value)}
                        items={[
                            { title: t("All active rails"), value: "ALL" },
                            { title: t("Selected rails only"), value: "LIST" },
                            { title: t("No rails (payments blocked)"), value: "NONE" },
                        ]}
                        hideDetails
                    />
                </FormField>
                {railMode.value === "LIST" && (
                    <FormField label={t("Allowed rails")}>
                        <VAutocomplete
                            modelValue={railCodes.value}
                            onUpdate:modelValue={(value: string[]) => (railCodes.value = value)}
                            items={rails.value.map((rail) => ({ title: rail.title, value: rail.code }))}
                            multiple
                            chips
                            closableChips
                            clearable
                            hideDetails
                        />
                    </FormField>
                )}
                {railMode.value === "NONE" && (
                    <VAlert type="warning" variant="tonal" density="compact">
                        {t("With no rails whitelisted the application cannot accept any payment.")}
                    </VAlert>
                )}
                <FormField
                    label={t("Redirect domains")}
                    hint={t("A hostname or an https origin without a path. Separate several with commas or new lines.")}
                    error={domainErrors.value.join(" · ")}
                >
                    {domainsRestricted.value ? (
                        <RestrictedValue />
                    ) : (
                        <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                            <VTextField
                                modelValue={domainInput.value}
                                onUpdate:modelValue={(value: string) => (domainInput.value = value)}
                                placeholder="shop.example.ly"
                                {...{ dir: "ltr" }}
                                hideDetails
                                onKeydown={(event: KeyboardEvent) => {
                                    if (event.key === "Enter") {
                                        event.preventDefault();
                                        addDomains();
                                    }
                                }}
                            />
                            <VBtn variant="tonal" prependIcon="mdi-plus" onClick={addDomains}>{t("Add")}</VBtn>
                        </div>
                    )}
                </FormField>
                {!domainsRestricted.value && domains.value.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                        {domains.value.map((domain) => (
                            <MetaPill key={domain}>
                                <span dir="ltr" style={{ fontFamily: "var(--pg-font-mono)" }}>{domain}</span>
                                <button
                                    type="button"
                                    aria-label={`${t("Remove")} ${domain}`}
                                    onClick={() => (domains.value = domains.value.filter((entry) => entry !== domain))}
                                    style={{ all: "unset", cursor: "pointer", marginInlineStart: "4px", fontSize: "14px", lineHeight: 1 }}
                                >
                                    ×
                                </button>
                            </MetaPill>
                        ))}
                    </div>
                )}
            </ReasonModal>
        );
    },
});

export default ApplicationPolicyModal;
