import { computed, defineComponent, ref, useId } from "vue";
import { useLocale } from "vuetify";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { formatMoney } from "@/utils/money";
import { LANDING_FEE_BEARERS, computeLandingFees, type LandingFeeBearer } from "@/content/landing/landingModel";

const BEARER_LABELS: Record<LandingFeeBearer, string> = {
    MERCHANT_ABSORBS: "You absorb",
    PAYER_SURCHARGE: "Payer pays",
    SPLIT: "Split 50/50",
};

const sanitizeAmount = (raw: string): string => {
    // Accept Arabic-Indic digits and a single decimal separator; cap length and decimals.
    const ascii = raw
        .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
        .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
        .replace(/[٫,]/g, ".")
        .replace(/[^\d.]/g, "");
    const [whole = "", ...rest] = ascii.split(".");
    const fraction = rest.join("").slice(0, 3);
    const trimmedWhole = whole.slice(0, 9);
    return rest.length ? `${trimmedWhole}.${fraction}` : trimmedWhole;
};

/**
 * Wise-style "see exactly what you get" preview of the three fee-bearer modes.
 * Purely illustrative: the real commission profile is assigned per merchant/application/rail.
 */
export const FeePreview = defineComponent({
    name: "LandingFeePreview",
    setup() {
        const { t } = useLocale();
        const amountId = useId();
        const rateId = useId();
        const amount = ref("250.000");
        const rate = ref("2.5");
        const bearer = ref<LandingFeeBearer>("MERCHANT_ABSORBS");

        const result = computed(() =>
            computeLandingFees({
                amount: amount.value || "0",
                commissionPercent: rate.value || "0",
                feeBearer: bearer.value,
                payerSharePercent: "50",
            }),
        );

        const money = (value: Parameters<typeof formatMoney>[0]) => formatMoney(value, { currency: "LYD" });

        return () => (
            <div class="pgl-fee">
                <div class="pgl-fee__inputs">
                    <label class="pgl-field" for={amountId}>
                        <span class="pgl-field__label">{t("Sale amount (LYD)")}</span>
                        <input
                            id={amountId}
                            class="pgl-input pgl-tabular"
                            dir="ltr"
                            inputmode="decimal"
                            autocomplete="off"
                            value={amount.value}
                            onInput={(event: Event) => {
                                const el = event.target as HTMLInputElement;
                                amount.value = sanitizeAmount(el.value);
                                el.value = amount.value;
                            }}
                        />
                    </label>
                    <label class="pgl-field pgl-field--narrow" for={rateId}>
                        <span class="pgl-field__label">{t("Example commission %")}</span>
                        <input
                            id={rateId}
                            class="pgl-input pgl-tabular"
                            dir="ltr"
                            inputmode="decimal"
                            autocomplete="off"
                            value={rate.value}
                            onInput={(event: Event) => {
                                const el = event.target as HTMLInputElement;
                                const clean = sanitizeAmount(el.value).slice(0, 5);
                                rate.value = clean;
                                el.value = clean;
                            }}
                        />
                    </label>
                </div>
                <SegmentedTabs
                    ariaLabel={t("Who pays the fee")}
                    modelValue={bearer.value}
                    tabs={LANDING_FEE_BEARERS.map((value) => ({ value, label: t(BEARER_LABELS[value]) }))}
                    {...{ "onUpdate:modelValue": (value: string) => (bearer.value = value as LandingFeeBearer) }}
                />
                <dl class="pgl-fee__result" aria-live="polite">
                    <div>
                        <dt>{t("Payer is charged")}</dt>
                        <dd class="pgl-tabular" dir="ltr">
                            {money(result.value.customerTotal)}
                        </dd>
                    </div>
                    <div>
                        <dt>{t("Commission")}</dt>
                        <dd class="pgl-tabular" dir="ltr">
                            {money(result.value.commission)}
                        </dd>
                    </div>
                    <div class="pgl-fee__net">
                        <dt>{t("Credited to your wallet")}</dt>
                        <dd class="pgl-tabular" dir="ltr">
                            {money(result.value.netToWallet)}
                        </dd>
                    </div>
                </dl>
            </div>
        );
    },
});

export default FeePreview;
