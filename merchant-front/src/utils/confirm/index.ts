import { ref } from "vue";

export interface ConfirmOptions {
    title: string;
    message: string;
    submitButtonLabel?: string;
    type: "error" | "warning" | "primary";
    slot?: (props: { form: any }) => any;
    onConfirm?: (form: any) => void | Promise<void>;
}

export const confirmDialogInstance = ref<{ show(opts: ConfirmOptions): Promise<boolean> } | null>(null);

/**
 * Show the shared confirmation dialog.
 * @returns true if the user confirmed, false on cancel.
 */
export function showConfirm(opts: ConfirmOptions): Promise<boolean> {
    if (!confirmDialogInstance.value) {
        return Promise.reject(new Error("ConfirmDialog is not mounted"));
    }
    return confirmDialogInstance.value.show(opts);
}
