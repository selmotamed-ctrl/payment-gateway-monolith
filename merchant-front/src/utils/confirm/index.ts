import type {
    AwaitedConfirmationDialog,
    ConfirmOptions,
} from "@/components/ConfirmDialog";
import { ref } from "vue";

export const confirmDialogInstance = ref(
    null as null | InstanceType<typeof AwaitedConfirmationDialog>,
);
/**
 * Show a confirm dialog.
 * @returns true if user clicked “Confirm”, false on “Cancel”.
 */
export function showConfirm(opts: ConfirmOptions): Promise<boolean> {
    if (!confirmDialogInstance.value) {
        return Promise.reject(new Error("ConfirmDialog is not mounted"));
    }
    return confirmDialogInstance.value.show(opts);
}
