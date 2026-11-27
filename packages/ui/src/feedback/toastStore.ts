import { ref } from "vue";

export type ToastTone = "success" | "info" | "warning" | "danger" | "primary";

export interface ToastItem {
    id: number;
    tone: ToastTone;
    title?: string;
    message: string;
    durationMs: number;
    actionLabel?: string;
    onAction?: () => void;
    paused: boolean;
    remainingMs: number;
    startedAt: number;
}

const MAX_TOASTS = 4;
const SUCCESS_DURATION_MS = 4500;
const ATTENTION_DURATION_MS = 6500;

const toasts = ref<ToastItem[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let sequence = 0;

const normalizeTone = (tone?: string): ToastTone => {
    if (tone === "error") return "danger";
    if (tone === "warning" || tone === "danger" || tone === "success" || tone === "info") return tone;
    return "info";
};

function clearTimer(id: number) {
    const handle = timers.get(id);
    if (handle !== undefined) {
        clearTimeout(handle);
        timers.delete(id);
    }
}

function startTimer(item: ToastItem) {
    if (item.durationMs <= 0) return;
    clearTimer(item.id);
    item.startedAt = Date.now();
    const handle = setTimeout(() => dismissToast(item.id), Math.max(0, item.remainingMs));
    timers.set(item.id, handle);
}

export function dismissToast(id: number) {
    clearTimer(id);
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

export function pauseToast(id: number) {
    const item = toasts.value.find((toast) => toast.id === id);
    if (!item || item.paused || item.durationMs <= 0) return;
    const handle = timers.get(id);
    if (handle === undefined) return;
    clearTimer(id);
    item.remainingMs = Math.max(0, item.remainingMs - (Date.now() - item.startedAt));
    item.paused = true;
}

export function resumeToast(id: number) {
    const item = toasts.value.find((toast) => toast.id === id);
    if (!item || !item.paused) return;
    item.paused = false;
    startTimer(item);
}

/**
 * Guaranteed auto-dismissing toast. Success/info live 4.5 s, warning/danger
 * 6.5 s. `durationMs: 0` disables auto-dismiss. The stack caps at four; the
 * oldest toast makes room for a new one.
 */
export function showToast(options: {
    tone?: ToastTone | "error" | "primary";
    title?: string;
    message: string;
    durationMs?: number;
    actionLabel?: string;
    onAction?: () => void;
}) {
    const tone = normalizeTone(options.tone);
    const durationMs =
        options.durationMs ?? (tone === "danger" || tone === "warning" ? ATTENTION_DURATION_MS : SUCCESS_DURATION_MS);
    const item: ToastItem = {
        id: ++sequence,
        tone,
        title: options.title,
        message: options.message,
        durationMs,
        remainingMs: durationMs,
        startedAt: Date.now(),
        paused: false,
        actionLabel: options.actionLabel,
        onAction: options.onAction,
    };
    while (toasts.value.length >= 4) {
        dismissToast(toasts.value[0]!.id);
    }
    toasts.value = [...toasts.value, item];
    startTimer(item);
    return item.id;
}

export function useToasts() {
    return { toasts, showToast, dismissToast, pauseToast, resumeToast };
}

/** Clear every toast (used on logout and in tests). */
export function clearToasts() {
    for (const id of Array.from(timers.keys())) clearTimer(id);
    toasts.value = [];
}

export const TOAST_MAX_VISIBLE = MAX_TOASTS;
