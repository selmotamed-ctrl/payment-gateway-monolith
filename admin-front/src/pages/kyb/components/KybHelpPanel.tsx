import { dc } from "@/utils/dc";
import { ref } from "vue";
import { useLocale } from "@/utils/vael-compat";
import {PgExpansionPanel, PgExpansionPanels} from "@pg/ui";
import {ThemedView} from "@pg/ui";
import {ThemedText} from "@pg/ui";
import { areHelpPanelsVisible } from "@/constants/env";
import { KYB_HELP_SECTIONS } from "../kybReviewHelp";

const KybHelpPanel = dc(() => {
    const { t } = useLocale();
    const open = ref<number[]>([]);
    if (!areHelpPanelsVisible()) {
        return () => null;
    }
    return () => (
        <PgExpansionPanels modelValue={open.value} onUpdate:modelValue={(value: unknown) => (open.value = (value as number[]) ?? [])} variant="accordion">
            {KYB_HELP_SECTIONS.map((section, index) => (
                <PgExpansionPanel key={section.title} value={index} title={t(section.title)}>
                    <ThemedText style={{ fontSize: "12px", lineHeight: 1.65, opacity: 0.8 }}>
                        {t(section.body)}
                    </ThemedText>
                </PgExpansionPanel>
            ))}
        </PgExpansionPanels>
    );
});

export default KybHelpPanel;
