import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VSelect, VTextField, VTextarea } from "vuetify/components";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { FormField } from "@/components/ui/FormField";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MonoRef } from "@/components/ui/MonoRef";
import { normalizeArabicText } from "@/utils/arabic";
import { WizardSection } from "./WizardSection";
import type { WizardCryptoProfile } from "./types";
import type { WizardStepProps } from "./StepIdentity";

const hexToBytes = (hex: string): Uint8Array => {
    const clean = (hex ?? "").replace(/[^0-9a-fA-F]/g, "");
    const padded = clean.length % 2 === 0 ? clean : `0${clean}`;
    const bytes = new Uint8Array(padded.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = parseInt(padded.substring(index * 2, index * 2 + 2), 16);
    }
    return bytes;
};

const base64ToBytes = (value: string): Uint8Array => {
    const binary = atob((value ?? "").trim());
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
};

const toBytes = (value: string, encoding: "utf8" | "hex" | "base64"): Uint8Array => {
    if (encoding === "hex") {
        return hexToBytes(value);
    }
    if (encoding === "base64") {
        return base64ToBytes(value);
    }
    return new TextEncoder().encode(value ?? "");
};

const toHex = (buffer: ArrayBuffer): string =>
    Array.from(new Uint8Array(buffer))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");

const canonicalize = (
    payload: string,
    canonicalization: WizardCryptoProfile["canonicalization"],
    fields: string[],
): string => {
    if (canonicalization === "RAW_BODY") {
        return payload;
    }
    if (canonicalization === "TIMESTAMP_DOT_RAW_BODY") {
        const separator = payload.indexOf(".");
        if (separator < 0) {
            return payload;
        }
        return `${payload.substring(0, separator)}.${payload.substring(separator + 1)}`;
    }
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(payload || "{}");
    } catch {
        parsed = {};
    }
    const selected = fields.length ? fields : Object.keys(parsed);
    const pairs = selected
        .filter((field) => parsed[field] !== undefined)
        .sort()
        .map((field) => `${field}=${String(parsed[field])}`);
    if (canonicalization === "SORTED_VALUES_HASH") {
        return pairs.map((pair) => pair.split("=")[1] ?? "").join("");
    }
    return pairs.join("&");
};

const gridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: "14px",
} as const;

export const StepCryptoProfile = dc(
    (props: WizardStepProps) => {
        const { t } = useLocale();
        const activeIndex = ref(0);
        const samplePayload = ref('{"amount":"10500","merchantId":"MID123"}');
        const sampleKey = ref("");
        const expectedSignature = ref("");
        const computedSignature = ref<string | null>(null);
        const verifyError = ref<string | null>(null);
        const computing = ref(false);
        const normalizeArabic = ref(false);

        const profiles = computed(() => props.model.cryptoProfiles);

        const updateProfile = (index: number, patch: Partial<WizardCryptoProfile>) => {
            const cryptoProfiles = profiles.value.map((profile, profileIndex) =>
                profileIndex === index ? { ...profile, ...patch } : profile,
            );
            props.onChange({ ...props.model, cryptoProfiles });
        };

        const addProfile = () => {
            props.onChange({
                ...props.model,
                cryptoProfiles: [
                    ...profiles.value,
                    {
                        name: "",
                        direction: "OUTBOUND_SIGN",
                        algorithm: "HMAC_SHA256",
                        keyEncoding: "utf8",
                        canonicalization: "SORTED_KEY_VALUE_AMP",
                        secretRef: "",
                        fields: [],
                        toleranceSeconds: 300,
                    },
                ],
            });
            activeIndex.value = profiles.value.length;
        };

        const removeProfile = (index: number) => {
            props.onChange({
                ...props.model,
                cryptoProfiles: profiles.value.filter((_, profileIndex) => profileIndex !== index),
            });
            activeIndex.value = Math.max(0, Math.min(activeIndex.value, profiles.value.length - 2));
        };

        const compute = async () => {
            const profile = profiles.value[activeIndex.value];
            if (!profile) {
                return;
            }
            computing.value = true;
            verifyError.value = null;
            computedSignature.value = null;
            try {
                const keyMaterial = sampleKey.value || profile.secretRef;
                if (!keyMaterial) {
                    throw new Error("a sample key or secret reference is required");
                }
                const payload = normalizeArabic.value
                    ? JSON.stringify(JSON.parse(normalizeArabicText(samplePayload.value) || "{}"))
                    : samplePayload.value;
                const canonical = canonicalize(payload, profile.canonicalization, profile.fields);
                const keyBytes = toBytes(keyMaterial, profile.keyEncoding);
                const cryptoKey = await crypto.subtle.importKey(
                    "raw",
                    keyBytes as unknown as BufferSource,
                    { name: "HMAC", hash: "SHA-256" },
                    false,
                    ["sign"],
                );
                const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(canonical));
                computedSignature.value = toHex(signature).toUpperCase();
            } catch (e) {
                verifyError.value = e instanceof Error ? e.message : String(e);
            } finally {
                computing.value = false;
            }
        };

        const matches = computed(() => {
            if (!computedSignature.value || !expectedSignature.value) {
                return null;
            }
            return (
                computedSignature.value.toUpperCase() === expectedSignature.value.replace(/\s+/g, "").toUpperCase()
            );
        });

        const active = computed(() => profiles.value[activeIndex.value]);

        return () => (
            <SurfaceCard
                title={t("Crypto Profiles")}
                v-slots={{
                    headerActions: () => (
                        <VBtn variant="tonal" size="small" onClick={addProfile}>
                            {t("Add")}
                        </VBtn>
                    ),
                }}
            >
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                    {profiles.value.length > 0 && (
                        <SegmentedTabs
                            modelValue={String(activeIndex.value)}
                            tabs={profiles.value.map((profile, index) => ({
                                value: String(index),
                                label: profile.name || `Profile ${index + 1}`,
                            }))}
                            onUpdate:modelValue={(value: string) => (activeIndex.value = Number(value))}
                            ariaLabel={t("Crypto Profiles")}
                        />
                    )}

                    {active.value && (
                        <WizardSection
                            title={active.value.name || `Profile ${activeIndex.value + 1}`}
                            v-slots={{
                                actions: () => (
                                    <>
                                        <StatusBadge
                                            status={active.value!.direction}
                                            toneOverride="info"
                                            showDot={false}
                                        />
                                        <VBtn
                                            size="x-small"
                                            variant="text"
                                            color="error"
                                            onClick={() => removeProfile(activeIndex.value)}
                                        >
                                            ×
                                        </VBtn>
                                    </>
                                ),
                            }}
                        >
                            <div style={gridStyle}>
                                <FormField label={t("Signature Profile")}>
                                    <VTextField
                                        modelValue={active.value.name}
                                        onUpdate:modelValue={(v: string) => updateProfile(activeIndex.value, { name: v })}
                                    />
                                </FormField>
                                <FormField label={t("Type")}>
                                    <VSelect
                                        items={["OUTBOUND_SIGN", "INBOUND_VERIFY"]}
                                        modelValue={active.value.direction}
                                        onUpdate:modelValue={(v: any) => updateProfile(activeIndex.value, { direction: v })}
                                    />
                                </FormField>
                                <FormField label={t("Algorithm")}>
                                    <VSelect
                                        items={["HMAC_SHA256", "HMAC_SHA512", "RSA_SHA256"]}
                                        modelValue={active.value.algorithm}
                                        onUpdate:modelValue={(v: any) => updateProfile(activeIndex.value, { algorithm: v })}
                                    />
                                </FormField>
                                <FormField label={t("Key Encoding")}>
                                    <VSelect
                                        items={["utf8", "hex", "base64"]}
                                        modelValue={active.value.keyEncoding}
                                        onUpdate:modelValue={(v: any) => updateProfile(activeIndex.value, { keyEncoding: v })}
                                    />
                                </FormField>
                                <FormField label={t("Canonicalization")}>
                                    <VSelect
                                        items={[
                                            "SORTED_KEY_VALUE_AMP",
                                            "TIMESTAMP_DOT_RAW_BODY",
                                            "SORTED_VALUES_HASH",
                                            "RAW_BODY",
                                        ]}
                                        modelValue={active.value.canonicalization}
                                        onUpdate:modelValue={(v: any) =>
                                            updateProfile(activeIndex.value, { canonicalization: v })
                                        }
                                    />
                                </FormField>
                                <FormField label="secret_ref" sensitiveMakerChecker>
                                    <VTextField
                                        modelValue={active.value.secretRef}
                                        onUpdate:modelValue={(v: string) => updateProfile(activeIndex.value, { secretRef: v })}
                                    />
                                </FormField>
                                <FormField label={t("Params")}>
                                    <VTextField
                                        modelValue={(active.value.fields ?? []).join(",")}
                                        onUpdate:modelValue={(v: string) =>
                                            updateProfile(activeIndex.value, {
                                                fields: v
                                                    .split(",")
                                                    .map((entry) => entry.trim())
                                                    .filter((entry) => !!entry),
                                            })
                                        }
                                    />
                                </FormField>
                                <FormField label="tolerance_seconds">
                                    <VTextField
                                        type="number"
                                        modelValue={active.value.toleranceSeconds}
                                        onUpdate:modelValue={(v: any) =>
                                            updateProfile(activeIndex.value, { toleranceSeconds: Number(v) })
                                        }
                                    />
                                </FormField>
                            </div>
                        </WizardSection>
                    )}

                    <WizardSection title={t("Test Signature")} divider>
                        <FormField label={t("Payload")}>
                            <VTextarea
                                modelValue={samplePayload.value}
                                onUpdate:modelValue={(v: string) => (samplePayload.value = v)}
                                rows={4}
                            />
                        </FormField>
                        <FormField label={t("Secret")} sensitiveMakerChecker>
                            <VTextField
                                type="password"
                                modelValue={sampleKey.value}
                                onUpdate:modelValue={(v: string) => (sampleKey.value = v)}
                            />
                        </FormField>
                        <FormField label={t("Expected Signature")}>
                            <VTextField
                                modelValue={expectedSignature.value}
                                onUpdate:modelValue={(v: string) => (expectedSignature.value = v)}
                            />
                        </FormField>
                        <div style={{ display: "flex", flexDirection: "row", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                            <VBtn color="primary" loading={computing.value} onClick={() => void compute()}>
                                {t("Test Signature")}
                            </VBtn>
                            {computedSignature.value && (
                                <MonoRef value={computedSignature.value} truncate={32} />
                            )}
                            {matches.value !== null && (
                                <StatusBadge
                                    status={matches.value ? "VERIFIED" : "FAILED"}
                                    label={matches.value ? t("Passed") : t("Failed")}
                                    toneOverride={matches.value ? "success" : "danger"}
                                />
                            )}
                        </div>
                        {verifyError.value && (
                            <VAlert type="error" variant="tonal" density="compact">
                                {verifyError.value}
                            </VAlert>
                        )}
                    </WizardSection>
                </SurfaceCardText>
            </SurfaceCard>
        );
    },
    {
        props: ["model", "onChange", "onSave", "saving", "error"],
    },
);

export default StepCryptoProfile;
