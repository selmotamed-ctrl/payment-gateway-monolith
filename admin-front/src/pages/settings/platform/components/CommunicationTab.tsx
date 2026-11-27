import { defineComponent } from "@/utils/dc";
import { onMounted, ref, type PropType } from "vue";
import {PgAlert, PgButton, PgTextField} from "@pg/ui";
import { useLocale } from "@/utils/vael-compat";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import {FormField} from "@pg/ui";
import {SurfaceCard, SurfaceCardText} from "@pg/ui";
import {StatusBadge} from "@pg/ui";
import {MetaPill} from "@pg/ui";
import {StateView} from "@pg/ui";

type ChannelStatus = {
    enabled: boolean;
    configured: boolean;
    source: string;
    missingFields: string[];
    lastTestAt?: string | null;
    lastTestStatus?: string | null;
    lastTestError?: string | null;
    lastDeliveryAt?: string | null;
    lastDeliveryStatus?: string | null;
    consecutiveFailures?: number;
};

type CommunicationStatus = {
    email: ChannelStatus;
    sms: ChannelStatus;
    google: ChannelStatus;
    maintenance: { active: boolean; code: string; message: string } | null;
};

const format = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
};

const tone = (configured: boolean): "success" | "danger" => (configured ? "success" : "danger");

export const CommunicationTab = defineComponent({
    name: "CommunicationSettingsTab",
    props: {
        onEdit: { type: Function as PropType<(key: string) => void>, required: true },
    },
    setup(props) {
        const { t } = useLocale();
        const status = ref<CommunicationStatus | null>(null);
        const loading = ref(true);
        const error = ref<string | null>(null);
        const testEmail = ref("");
        const testSms = ref("");
        const sending = ref<"email" | "sms" | null>(null);

        const load = async () => {
            loading.value = true;
            error.value = null;
            try {
                const response = await api.get(urlsMap.settingsCommunicationStatus);
                const payload = response.data?.data ?? response.data ?? {};
                status.value = payload.status as CommunicationStatus;
            } catch (e) {
                error.value = extractApiErrorMessage(e);
            } finally {
                loading.value = false;
            }
        };
        onMounted(() => void load());

        const sendEmail = async () => {
            if (!testEmail.value.includes("@") || sending.value) return;
            sending.value = "email";
            try {
                await api.post(urlsMap.settingsTestEmail, { to: testEmail.value.trim() });
                showSnackBar({ type: "success", message: t("Test email sent") });
                await load();
            } catch (e) {
                showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
            } finally {
                sending.value = null;
            }
        };

        const sendSms = async () => {
            if (!testSms.value.trim() || sending.value) return;
            sending.value = "sms";
            try {
                await api.post(urlsMap.settingsTestSms, { to: testSms.value.trim() });
                showSnackBar({ type: "success", message: t("Test SMS sent") });
                await load();
            } catch (e) {
                showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
            } finally {
                sending.value = null;
            }
        };

        const channelCard = (
            title: string,
            channel: ChannelStatus,
            settingKey: string,
            test: () => unknown,
        ) => (
            <SurfaceCard>
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                        <span style={{ fontSize: "15px", fontWeight: 600 }}>{title}</span>
                        <StatusBadge
                            status={channel.configured ? "CONFIGURED" : "MISSING"}
                            toneOverride={tone(channel.configured)}
                            showDot={false}
                        />
                        <MetaPill size="x-small" variant="tonal">{channel.source}</MetaPill>
                        {channel.enabled ? null : <MetaPill size="x-small" variant="text">{t("Disabled")}</MetaPill>}
                        <div style={{ flex: 1 }} />
                        <PgButton size="small" variant="tonal" onClick={() => props.onEdit(settingKey)}>
                            {t("Edit setting")}
                        </PgButton>
                    </div>
                    {channel.missingFields.length > 0 ? (
                        <PgAlert tone="warning" density="compact">
                            {t("Missing")}: {channel.missingFields.join(", ")}
                        </PgAlert>
                    ) : null}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "8px", fontSize: "12px" }}>
                        <span>{t("Last test")}: {format(channel.lastTestAt)} ({channel.lastTestStatus ?? "—"})</span>
                        <span>{t("Last delivery")}: {format(channel.lastDeliveryAt)} ({channel.lastDeliveryStatus ?? "—"})</span>
                        <span>{t("Consecutive failures")}: {channel.consecutiveFailures ?? 0}</span>
                    </div>
                    {channel.lastTestError ? (
                        <PgAlert tone="danger" density="compact">{channel.lastTestError}</PgAlert>
                    ) : null}
                    <div style={{ display: "flex", gap: "8px", alignItems: "flex-start", flexWrap: "wrap" }}>{test()}</div>
                </SurfaceCardText>
            </SurfaceCard>
        );

        return () => (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value || !status.value ? (
                    <StateView loading={true} />
                ) : (
                    <>
                        {status.value.maintenance ? (
                            <PgAlert tone="danger">
                                <strong>{t("Merchant registration and sign-in are in maintenance")}. </strong>
                                {status.value.maintenance.message}
                            </PgAlert>
                        ) : (
                            <PgAlert tone="success">
                                {t("Email delivery is configured. Merchant registration and sign-in are available.")}
                            </PgAlert>
                        )}
                        {channelCard(
                            t("Email"),
                            status.value.email,
                            "communication.email",
                            () => (
                                <>
                                    <PgTextField
                                        modelValue={testEmail.value}
                                        onUpdate:modelValue={(value: string) => (testEmail.value = value)}
                                        label={t("Send test email to")}
                                        type="email"
                                        density="compact"
                                        hideDetails
                                        style={{ minInlineSize: "220px" }}
                                    />
                                    <PgButton
                                        variant="tonal"
                                        loading={sending.value === "email"}
                                        disabled={!testEmail.value.includes("@") || !status.value?.email.configured}
                                        onClick={() => void sendEmail()}
                                    >
                                        {t("Send test email")}
                                    </PgButton>
                                </>
                            ),
                        )}
                        {channelCard(
                            t("SMS"),
                            status.value.sms,
                            "communication.sms",
                            () => (
                                <>
                                    <PgTextField
                                        modelValue={testSms.value}
                                        onUpdate:modelValue={(value: string) => (testSms.value = value)}
                                        label={t("Send test SMS to")}
                                        density="compact"
                                        hideDetails
                                        style={{ minInlineSize: "220px" }}
                                    />
                                    <PgButton
                                        variant="tonal"
                                        loading={sending.value === "sms"}
                                        disabled={!testSms.value.trim() || !status.value?.sms.configured}
                                        onClick={() => void sendSms()}
                                    >
                                        {t("Send test SMS")}
                                    </PgButton>
                                </>
                            ),
                        )}
                        {channelCard(
                            t("Google sign-in"),
                            status.value.google,
                            "auth.google",
                            () => <span style={{ fontSize: "12px", opacity: 0.7 }}>{t("Google sign-in has no delivery test.")}</span>,
                        )}
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                            <PgButton variant="text" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>
                                {t("Refresh")}
                            </PgButton>
                        </div>
                    </>
                )}
            </div>
        );
    },
});

export default CommunicationTab;
