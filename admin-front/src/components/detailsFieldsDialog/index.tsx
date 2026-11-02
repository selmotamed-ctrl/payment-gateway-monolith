import { dc } from "kt-dc";
import type { FieldProps } from "../Field";
import { VCard, VCardActions, VCardText, VCardTitle, VDialog } from "vuetify/components";
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
    const titleId = "pg-details-title";
    const contentId = "pg-details-content";
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
                    scrollable
                    style={{
                        zIndex: 99,
                    }}
                    {...{
                        role: "dialog",
                        "aria-modal": "true",
                        "aria-labelledby": titleId,
                        "aria-describedby": contentId,
                    }}
                >
                    <VCard
                        onKeydown={(event: KeyboardEvent) => {
                            if (event.key === "Escape") {
                                event.preventDefault();
                                shown.value = false;
                            }
                        }}
                    >
                        <div id={titleId}>
                            <VCardTitle>{title.value ? t(title.value) : undefined}</VCardTitle>
                        </div>
                        <VCardText>
                            <div id={contentId}>
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
                            </div>
                        </VCardText>

                        <VCardActions>
                            <Button
                                {...{ autofocus: true, "aria-label": t("Close") }}
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
