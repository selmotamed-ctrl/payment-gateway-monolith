import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import type { Channel, LocalNotificationSchema } from "@capacitor/local-notifications";
import { loadCompanionData, todayKey, updateSettings } from "./data";

const CHANNEL_ID = "reading-reminders";
const ACTION_TYPE = "reading-reminder";
const BASE_ID = 7100;
const WINDOW_DAYS = 8;

const native = (): boolean => Capacitor.isNativePlatform();

const parseTime = (value: string): { hour: number; minute: number } => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value);
    const hour = Number(match?.[1] ?? 20);
    const minute = Number(match?.[2] ?? 0);
    return {
        hour: Math.max(0, Math.min(23, Number.isFinite(hour) ? hour : 20)),
        minute: Math.max(0, Math.min(59, Number.isFinite(minute) ? minute : 0)),
    };
};

const withinQuietHours = (time: string, start: string, end: string): boolean => {
    if (start === end) return false;
    return start < end ? time >= start && time < end : time >= start || time < end;
};

const ensureChannel = async (): Promise<void> => {
    const channel: Channel = {
        id: CHANNEL_ID,
        name: "Reading reminders",
        description: "A quiet nudge to continue reading the guide or academy.",
        importance: 3,
        visibility: 1,
        lights: false,
        vibration: true,
    };
    try {
        const { channels } = await LocalNotifications.listChannels();
        if (!channels.some((entry) => entry.id === CHANNEL_ID)) {
            await LocalNotifications.createChannel(channel);
        }
    } catch {
        // Channel management is Android-only; scheduling still works without it.
    }
};

const registerActions = async (): Promise<void> => {
    try {
        await LocalNotifications.registerActionTypes({
            types: [
                {
                    id: ACTION_TYPE,
                    actions: [
                        { id: "open", title: "Open" },
                        { id: "snooze", title: "Later" },
                    ],
                },
            ],
        });
    } catch {
        // Actions are a convenience; tap-to-open still works.
    }
};

export const reminderPermissionGranted = async (): Promise<boolean> => {
    if (!native()) return false;
    const status = await LocalNotifications.checkPermissions();
    return status.display === "granted";
};

export const requestReminderPermission = async (): Promise<boolean> => {
    if (!native()) return false;
    const status = await LocalNotifications.checkPermissions();
    if (status.display === "granted") return true;
    const requested = await LocalNotifications.requestPermissions();
    return requested.display === "granted";
};

export const cancelReminders = async (): Promise<void> => {
    if (!native()) return;
    try {
        const pending = await LocalNotifications.getPending();
        const ours = pending.notifications
            .filter((entry) => entry.id >= BASE_ID && entry.id <= BASE_ID + WINDOW_DAYS)
            .map((entry) => ({ id: entry.id }));
        if (ours.length > 0) await LocalNotifications.cancel({ notifications: ours });
    } catch {
        // A missing pending list is not an error.
    }
};

const reminderBody = (title: string | undefined, index: number): string => {
    if (title) {
        const clean = title.length > 64 ? `${title.slice(0, 61)}…` : title;
        return index === 0
            ? `Your bookmark is waiting: ${clean}`
            : `Continue ${clean}`;
    }
    const fallbacks = [
        "A five-minute read is ready when you are.",
        "Your guide is here for a quiet moment.",
        "A short read for today.",
        "Continue where you left off.",
    ];
    return fallbacks[index % fallbacks.length]!;
};

export const syncReminders = async (): Promise<void> => {
    const data = await loadCompanionData();
    await cancelReminders();
    if (!native() || !data.settings.reminders.enabled) return;
    if (!(await reminderPermissionGranted())) return;
    if (withinQuietHours(data.settings.reminders.time, data.settings.reminders.quietStart, data.settings.reminders.quietEnd)) {
        return;
    }

    await ensureChannel();
    await registerActions();

    const { hour, minute } = parseTime(data.settings.reminders.time);
    const readToday = data.readingDays.includes(todayKey());
    const now = Date.now();
    const notifications: LocalNotificationSchema[] = [];

    for (let offset = 0; offset < WINDOW_DAYS; offset += 1) {
        if (offset === 0 && readToday) continue;
        const date = new Date();
        date.setDate(date.getDate() + offset);
        date.setHours(hour, minute, 0, 0);
        if (date.getTime() <= now + 60_000) continue;
        const body = reminderBody(data.lastRead?.title, offset);
        notifications.push({
            id: BASE_ID + offset,
            title: "PG Companion",
            body,
            largeBody: data.lastRead?.title
                ? `${body}\n\nOpen the guide to continue reading.`
                : "Open the guide to continue reading.",
            channelId: CHANNEL_ID,
            smallIcon: "ic_stat_companion",
            iconColor: "#0f6bff",
            autoCancel: true,
            actionTypeId: ACTION_TYPE,
            extra: { route: data.lastRead?.route ?? "/today", kind: "reading-reminder" },
            isExactNotification: false,
            schedule: {
                at: date,
                allowWhileIdle: true,
            },
        });
    }

    if (notifications.length > 0) {
        await LocalNotifications.schedule({ notifications });
    }
    updateSettings({ lastReminderSync: new Date().toISOString() });
};

export const enableReminders = async (): Promise<boolean> => {
    if (!(await requestReminderPermission())) return false;
    updateSettings({ reminders: { enabled: true } });
    await syncReminders();
    return true;
};

export const disableReminders = async (): Promise<void> => {
    updateSettings({ reminders: { enabled: false } });
    await cancelReminders();
};

export const snoozeReminder = async (): Promise<void> => {
    if (!native()) return;
    const data = await loadCompanionData();
    const { hour, minute } = parseTime(data.settings.reminders.time);
    const date = new Date();
    date.setDate(date.getDate() + 1);
    date.setHours(hour, minute, 0, 0);
    await ensureChannel();
    await LocalNotifications.schedule({
        notifications: [
            {
                id: BASE_ID + WINDOW_DAYS,
                title: "PG Companion",
                body: reminderBody(data.lastRead?.title, 1),
                channelId: CHANNEL_ID,
                smallIcon: "ic_stat_companion",
                iconColor: "#0f6bff",
                autoCancel: true,
                extra: { route: data.lastRead?.route ?? "/today", kind: "reading-reminder" },
                isExactNotification: false,
                schedule: { at: date, allowWhileIdle: true },
            },
        ],
    });
};
