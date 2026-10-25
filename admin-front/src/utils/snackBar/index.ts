import { SnackBar } from "@/components/SnackBar";
import { ref } from "vue";

export interface SnackBarOptions {
    message: string;
    type: "error" | "warning" | "primary" | "disabled" | "success";
}

export const snackBarInstance = ref(
    null as InstanceType<typeof SnackBar> | null,
);

export function showSnackBar(opts: SnackBarOptions): void {
    if (!snackBarInstance.value) {
        return;
    }
    return snackBarInstance.value?.show(opts);
}
