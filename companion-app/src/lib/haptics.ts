import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";

const native = (): boolean => Capacitor.isNativePlatform();

export const tapFeedback = async (): Promise<void> => {
    if (!native()) return;
    try {
        await Haptics.impact({ style: ImpactStyle.Light });
    } catch {
        // Haptics are optional and must never block an action.
    }
};

export const successFeedback = async (): Promise<void> => {
    if (!native()) return;
    try {
        await Haptics.notification({ type: NotificationType.Success });
    } catch {
        // Haptics are optional and must never block an action.
    }
};

export const selectionFeedback = async (): Promise<void> => {
    if (!native()) return;
    try {
        await Haptics.selectionStart();
        await Haptics.selectionEnd();
    } catch {
        // Haptics are optional and must never block an action.
    }
};
