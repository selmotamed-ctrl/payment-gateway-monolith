import { dc } from "kt-dc";
import type { FieldProps } from "../Field";
import { VCard, VCardActions, VCardText, VDialog } from "vuetify/components";
import { useLocale } from "vuetify";

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
            <>
                <VDialog
                    modelValue={shown.value}
                    onUpdate:modelValue={(v) => {
                        shown.value = !!v;
                    }}
                    maxWidth={"1000px"}
                    width={"100%"}
                    style={{
                        zIndex: 99,
                    }}
                >
                    <VCard title={title.value ? t(title.value) : undefined}>
                        <VCardText>
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
                        </VCardText>

                        <VCardActions>
                            <Button
                                onClick={() => {
                                    shown.value = false;
                                }}
                            >
                                {t("Close")}
                            </Button>
                        </VCardActions>
                    </VCard>
                </VDialog>
            </>
        );
    };
});
