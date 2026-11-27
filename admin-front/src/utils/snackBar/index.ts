import {showToast} from "@pg/ui";

export interface SnackBarOptions {
    message: string;
    type: "error" | "warning" | "primary" | "disabled" | "success";
}

const toneFor = (type: SnackBarOptions["type"]) => {
    if (type === "error") return "danger" as const;
    if (type === "warning") return "warning" as const;
    if (type === "success") return "success" as const;
    return "info" as const;
};

/** Backwards-compatible helper; every surface now uses the shared toast stack. */
export function showSnackBar(opts: SnackBarOptions): void {
    showToast({ message: opts.message, tone: toneFor(opts.type) });
}
