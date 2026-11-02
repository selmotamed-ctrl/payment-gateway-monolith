import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VExpansionPanel, VExpansionPanelText, VExpansionPanelTitle, VExpansionPanels } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { areHelpPanelsVisible } from "@/constants/env";
import { KYB_HELP_SECTIONS } from "../kybReviewHelp";

const KybHelpPanel = dc(() => {
    const { t } = useLocale();
    const open = ref<number[]>([]);
    if (!areHelpPanelsVisible()) {
        return () => null;
    }
    return () => (
        <VExpansionPanels modelValue={open.value} onUpdate:modelValue={(value: unknown) => (open.value = (value as number[]) ?? [])} variant="accordion">
            {KYB_HELP_SECTIONS.map((section, index) => (
                <VExpansionPanel key={section.title} value={index}>
                    <VExpansionPanelTitle>
                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>
                                {t(section.title)}
                            </ThemedText>
                        </ThemedView>
                    </VExpansionPanelTitle>
                    <VExpansionPanelText>
                        <ThemedText style={{ fontSize: "12px", lineHeight: 1.65, opacity: 0.8 }}>
                            {t(section.body)}
                        </ThemedText>
                    </VExpansionPanelText>
                </VExpansionPanel>
            ))}
        </VExpansionPanels>
    );
});

export default KybHelpPanel;
