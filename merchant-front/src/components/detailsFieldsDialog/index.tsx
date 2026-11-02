import { dc } from "kt-dc";
import { ref } from "vue";
import type { FieldProps } from "../Field";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import { FormModal } from "@/components/ui/FormModal";
import { ThemedView } from "@/components/ThemedView";

export const DetailsFieldsDialog = dc<
    {},
    {
        show: (props: {
            title: string;
            sections?: {
                fields: FieldProps[];
            }[];
            slot?: (props: { close: () => void }) => JSX.Element;
        }) => void;
    }
>((_, expose) => {
    const shown = ref(false);
    const fields = ref(
        [] as {
            fields: FieldProps[];
        }[],
    );
    const title = ref(null as null | string);
    const slot = ref(null as null | ((props: { close: () => void }) => JSX.Element));
    const show = (props: {
        title: string;
        sections?: {
            fields: FieldProps[];
        }[];
        slot?: (props: { close: () => void }) => JSX.Element;
    }) => {
        title.value = props.title;
        fields.value = props.sections || [];
        shown.value = true;
        slot.value = props.slot || null;
    };
    expose({
        show,
    });
    const { t } = useLocale();

    return () => {
        return (
            <FormModal
                modelValue={shown.value}
                onUpdate:modelValue={(value: boolean) => {
                    shown.value = value;
                }}
                title={title.value ? t(title.value) : t("Details")}
                size="lg"
                v-slots={{
                    footer: () => (
                        <VBtn
                            variant="outlined"
                            onClick={() => {
                                shown.value = false;
                            }}
                        >
                            {t("Close")}
                        </VBtn>
                    ),
                }}
            >
                <ThemedView
                    style={{
                        gap: "22px",
                    }}
                >
                    {!!fields.value?.length && <FieldsSections noElevation sections={fields.value}></FieldsSections>}
                    {slot?.value?.({
                        close: () => {
                            shown.value = false;
                        },
                    })}
                </ThemedView>
            </FormModal>
        );
    };
});
