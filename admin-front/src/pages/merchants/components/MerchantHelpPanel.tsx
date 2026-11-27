import { dc } from "@/utils/dc";
import { ref } from "vue";
import { useLocale } from "@/utils/vael-compat";
import {PgExpansionPanel, PgExpansionPanelText, PgExpansionPanelTitle, PgExpansionPanels} from "@pg/ui";
import {ThemedText} from "@pg/ui";
import { areHelpPanelsVisible } from "@/constants/env";
import { MERCHANT_HELP_SECTIONS } from "../merchantHelp";

const MerchantHelpPanel = dc(() => {
    const { t } = useLocale();
    const open = ref<number[]>([]);
    if (!areHelpPanelsVisible()) {
        return () => null;
    }
    return () => (
        <PgExpansionPanels modelValue={open.value} onUpdate:modelValue={(value: unknown) => (open.value = (value as number[]) ?? [])} variant="accordion">
            {MERCHANT_HELP_SECTIONS.map((section, index) => (
                <PgExpansionPanel key={section.title} value={index}>
                    <PgExpansionPanelTitle>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t(section.title)}</ThemedText>
                    </PgExpansionPanelTitle>
                    <PgExpansionPanelText>
                        <ThemedText style={{ fontSize: "12px", lineHeight: 1.65, opacity: 0.8 }}>{t(section.body)}</ThemedText>
                    </PgExpansionPanelText>
                </PgExpansionPanel>
            ))}
        </PgExpansionPanels>
    );
});

export default MerchantHelpPanel;
