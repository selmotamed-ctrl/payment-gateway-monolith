import type { SnackBarOptions } from "@/utils/snackBar/index";
import { useLocale } from "vuetify";
import { VSnackbar } from "vuetify/components";
import Button from "@/components/Button";
import { ref, type VNode } from "vue";
import { dc } from "kt-dc";

export const SnackBar = dc<
    {},
    {
        show(opts: SnackBarOptions): void;
    }
>((_, expose) => {
    const visible = ref(false);
    const message = ref<string>("");
    const type = ref("primary" as string);

    function show(opts: SnackBarOptions): void {
        message.value = opts.message;
        visible.value = true;
        type.value = opts.type;
    }

    const { t } = useLocale();

    expose({ show });

    return (): VNode => (
        <VSnackbar
            modelValue={visible.value}
            onUpdate:modelValue={(v) => {
                visible.value = v;
            }}
            timeout={4e3}
            color={type.value}
        >
            {{
                default: () => {
                    return (
                        <p style={{ fontSize: "14px", fontWeight: "700" }}>
                            {t(message.value)}
                        </p>
                    );
                },
                actions: () => {
                    return (
                        <Button
                            variant="text"
                            onClick={() => {
                                visible.value = false;
                            }}
                        >
                            {t("Close")}
                        </Button>
                    );
                },
            }}
        </VSnackbar>
    );
});

export default SnackBar;
