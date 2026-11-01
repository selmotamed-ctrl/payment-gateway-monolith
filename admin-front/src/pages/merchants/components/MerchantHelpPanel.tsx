import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VExpansionPanel, VExpansionPanelText, VExpansionPanelTitle, VExpansionPanels } from "vuetify/components";
import { ThemedText } from "@/components/ThemedText";
import { MERCHANT_HELP_SECTIONS } from "../merchantHelp";

const MerchantHelpPanel = dc(() => {
    const { t } = useLocale();
    const open = ref<number[]>([]);
    return () => (
        <VExpansionPanels modelValue={open.value} onUpdate:modelValue={(value: unknown) => (open.value = (value as number[]) ?? [])} variant="accordion">
            {MERCHANT_HELP_SECTIONS.map((section, index) => (
                <VExpansionPanel key={section.title} value={index}>
                    <VExpansionPanelTitle>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t(section.title)}</ThemedText>
                    </VExpansionPanelTitle>
                    <VExpansionPanelText>
                        <ThemedText style={{ fontSize: "12px", lineHeight: 1.65, opacity: 0.8 }}>{t(section.body)}</ThemedText>
                    </VExpansionPanelText>
                </VExpansionPanel>
            ))}
        </VExpansionPanels>
    );
});

export default MerchantHelpPanel;
