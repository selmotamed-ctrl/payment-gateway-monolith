<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import AppIcon from "@/components/AppIcon.vue";
import PageHeader from "@/components/PageHeader.vue";
import {
    exportData,
    importData,
    resetData,
    setActiveTrack,
    setRole,
    updateSettings,
    useCompanionData,
    type LanguageChoice,
    type ThemeChoice,
} from "@/lib/data";
import { useI18n } from "@/lib/i18n";
import { trackForRole, useContent } from "@/content/store";
import {
    disableReminders,
    enableReminders,
    reminderPermissionGranted,
    syncReminders,
} from "@/lib/reminders";
import { checkForUpdate, resetContentUpdate, updateState, applyAndReload } from "@/lib/updates";
import type { Role } from "@/content/types";

const { data, settings, flush } = useCompanionData();
const { bundle } = useContent();
const { L } = useI18n();

const permission = ref(false);
const reminderError = ref("");
const dataError = ref("");
const importing = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const themes: { value: ThemeChoice; label: string }[] = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "sepia", label: "Sepia" },
];
const roles: { value: Role; label: string }[] = [
    { value: "OPERATOR", label: "Operator" },
    { value: "SUPPORT", label: "Support" },
    { value: "FINANCE", label: "Finance" },
    { value: "COMPLIANCE", label: "Compliance" },
    { value: "MLRO", label: "MLRO" },
    { value: "GATEWAY_ADMIN", label: "Gateway admin" },
    { value: "SECURITY_ADMIN", label: "Security admin" },
];
const appVersion = __APP_VERSION__;
const contentVersion = computed(() => bundle.value?.meta.contentVersion ?? "—");
const contentHash = computed(() => bundle.value?.meta.contentHash.slice(0, 16) ?? "—");
const canCheckUpdates = computed(() => updateState.configured);
const quietWarning = computed(() => {
    const time = settings.value.reminders.time;
    const start = settings.value.reminders.quietStart;
    const end = settings.value.reminders.quietEnd;
    return time >= start || time < end;
});
const roleValue = computed({
    get: () => data.value.role,
    set: (value: Role | "") => {
        setRole(value);
        const track = trackForRole(value);
        if (track) setActiveTrack(track);
    },
});
const themeValue = computed({
    get: () => settings.value.theme,
    set: (value: ThemeChoice) => updateSettings({ theme: value }),
});
const languageValue = computed({
    get: () => settings.value.language,
    set: (value: LanguageChoice) => updateSettings({ language: value }),
});
const fontScale = computed({
    get: () => settings.value.fontScale,
    set: (value: number) => updateSettings({ fontScale: value }),
});
const reminderTime = computed({
    get: () => settings.value.reminders.time,
    set: (value: string) => {
        updateSettings({ reminders: { ...settings.value.reminders, time: value } });
        if (settings.value.reminders.enabled) void syncReminders();
    },
});
const reminderEnabled = computed({
    get: () => settings.value.reminders.enabled,
    set: (value: boolean) => void changeReminders(value),
});

const changeReminders = async (value: boolean): Promise<void> => {
    reminderError.value = "";
    if (value) {
        const ok = await enableReminders();
        permission.value = await reminderPermissionGranted();
        if (!ok) reminderError.value = L("settings.notificationsDenied");
        return;
    }
    await disableReminders();
};

onMounted(async () => {
    permission.value = await reminderPermissionGranted();
});

const exportAll = async (): Promise<void> => {
    dataError.value = "";
    try {
        await flush();
        const json = exportData();
        const fileName = `pg-companion-data-${new Date().toISOString().slice(0, 10)}.json`;
        if (Capacitor.isNativePlatform()) {
            const result = await Filesystem.writeFile({
                path: fileName,
                data: json,
                directory: Directory.Cache,
                encoding: Encoding.UTF8,
            });
            await Share.share({
                title: "PG Companion data",
                text: "Your local reading data",
                files: [result.uri],
            });
        } else {
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = fileName;
            anchor.click();
            URL.revokeObjectURL(url);
        }
    } catch (error) {
        dataError.value = error instanceof Error ? error.message : String(error);
    }
};

const pickImport = (): void => {
    fileInput.value?.click();
};

const onImportFile = async (event: Event): Promise<void> => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    importing.value = true;
    dataError.value = "";
    try {
        const text = await file.text();
        await importData(text);
        window.location.reload();
    } catch (error) {
        dataError.value = error instanceof Error ? error.message : String(error);
    } finally {
        importing.value = false;
    }
};

const resetAll = async (): Promise<void> => {
    if (!window.confirm(L("settings.resetConfirm"))) return;
    await resetData();
    window.location.reload();
};

const checkUpdates = async (): Promise<void> => {
    try {
        await checkForUpdate(true);
    } catch {
        // The state exposes the error to the settings screen.
    }
};

const revertContent = async (): Promise<void> => {
    if (!window.confirm("Revert to the content bundled in the APK?")) return;
    await resetContentUpdate();
};
</script>

<template>
    <div class="page settings-page">
        <PageHeader :title="L('settings.title')" :back-to="null" />

        <section class="settings-section">
            <div class="section-head"><h2>{{ L("settings.reading") }}</h2></div>
            <label class="field">
                <span>{{ L("settings.theme") }}</span>
                <select v-model="themeValue" class="select">
                    <option v-for="theme in themes" :key="theme.value" :value="theme.value">{{ theme.label }}</option>
                </select>
            </label>
            <label class="field">
                <span>{{ L("settings.fontSize") }} · {{ Math.round(fontScale * 100) }}%</span>
                <input v-model.number="fontScale" type="range" min="0.9" max="1.4" step="0.05" />
            </label>
            <label class="switch-row">
                <span>{{ L("settings.serif") }}</span>
                <input type="checkbox" :checked="settings.serif" @change="updateSettings({ serif: ($event.target as HTMLInputElement).checked })" />
            </label>
            <label class="field">
                <span>{{ L("settings.language") }}</span>
                <select v-model="languageValue" class="select">
                    <option value="en">English</option>
                    <option value="ar">العربية</option>
                </select>
            </label>
            <label class="field">
                <span>{{ L("today.pickRole") }}</span>
                <select v-model="roleValue" class="select">
                    <option value="">Everyone</option>
                    <option v-for="role in roles" :key="role.value" :value="role.value">{{ role.label }}</option>
                </select>
            </label>
        </section>

        <section class="settings-section">
            <div class="section-head"><h2>{{ L("settings.reminders") }}</h2></div>
            <label class="switch-row">
                <span>{{ L("settings.remindersOn") }}</span>
                <input v-model="reminderEnabled" type="checkbox" />
            </label>
            <label class="field">
                <span>{{ L("settings.reminderTime") }}</span>
                <input v-model="reminderTime" class="input" type="time" />
            </label>
            <p class="muted small">{{ L("settings.reminderNote") }}</p>
            <p class="muted small">{{ L("settings.quietHours", { start: settings.reminders.quietStart, end: settings.reminders.quietEnd }) }}</p>
            <p v-if="quietWarning" class="notice-text">Your reminder time is inside quiet hours, so it will be skipped. Choose a time outside {{ settings.reminders.quietStart }}–{{ settings.reminders.quietEnd }}.</p>
            <p v-if="reminderError" class="notice-text notice-text--danger">{{ reminderError }}</p>
            <p v-else-if="settings.reminders.enabled && permission" class="notice-text notice-text--success">{{ L("settings.remindersEnabled") }}</p>
            <p v-else-if="settings.reminders.enabled && !permission" class="notice-text notice-text--danger">{{ L("settings.notificationsDenied") }}</p>
        </section>

        <section class="settings-section">
            <div class="section-head"><h2>{{ L("settings.updates") }}</h2></div>
            <template v-if="canCheckUpdates">
                <button type="button" class="btn btn--primary" :disabled="updateState.checking" @click="checkUpdates">
                    {{ updateState.checking ? L("common.loading") : L("settings.checkUpdates") }}
                </button>
                <p v-if="updateState.error" class="notice-text notice-text--danger">{{ updateState.error }}</p>
                <p v-if="updateState.available && !updateState.applied" class="notice-text">{{ L("settings.updateAvailable") }}</p>
                <p v-if="updateState.applied" class="notice-text notice-text--success">{{ L("settings.updateApplied") }}</p>
                <div v-if="updateState.applied" class="hero-actions">
                    <button type="button" class="btn btn--primary" @click="applyAndReload">{{ L("settings.restart") }}</button>
                    <button type="button" class="btn btn--ghost" @click="revertContent">{{ L("settings.revertContent") }}</button>
                </div>
            </template>
            <p v-else class="muted">{{ L("settings.updateUnavailable") }}</p>
        </section>

        <section class="settings-section">
            <div class="section-head"><h2>{{ L("settings.data") }}</h2></div>
            <button type="button" class="btn btn--ghost" @click="exportAll">{{ L("settings.export") }}</button>
            <button type="button" class="btn btn--ghost" :disabled="importing" @click="pickImport">
                {{ importing ? L("common.loading") : L("settings.import") }}
            </button>
            <input ref="fileInput" type="file" accept="application/json,.json" class="visually-hidden" @change="onImportFile" />
            <button type="button" class="btn btn--danger" @click="resetAll">{{ L("settings.reset") }}</button>
            <p v-if="dataError" class="notice-text notice-text--danger">{{ dataError }}</p>
        </section>

        <section class="settings-section about-section">
            <div class="section-head"><h2>{{ L("settings.about") }}</h2></div>
            <p>{{ L("settings.offline") }}</p>
            <dl class="kv-list">
                <div><dt>{{ L("settings.version") }}</dt><dd>{{ appVersion }}</dd></div>
                <div><dt>{{ L("settings.contentVersion") }}</dt><dd>{{ contentVersion }}</dd></div>
                <div><dt>{{ L("settings.contentHash") }}</dt><dd class="mono">{{ contentHash }}</dd></div>
            </dl>
            <p class="small muted">Official certification exams are available only in the live Admin Academy. This app is a private offline companion.</p>
        </section>
    </div>
</template>
