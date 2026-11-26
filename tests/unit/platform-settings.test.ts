import { describe, expect, test } from "vitest";
import { platformSettings } from "../../core-back/prisma/platformSettingsSeed";
import {
    filterSettingEntries,
    mergeSettingEntries,
    selectEffectiveVersion,
    settingPreview,
    settingSectionCounts,
    settingSearchText,
    type PlatformSettingRow,
} from "@/components/builders/model/settingsSearch";
import {
    CREATABLE_SETTING_DEFINITIONS,
    SETTING_SECTIONS,
    SETTING_STATUS_META,
    resolveSettingDefinition,
    settingCatalogDefinitions,
    settingNamespaceFor,
} from "@/components/builders/model/settingsCatalog";
import { resolveSettingNamespace } from "@/components/builders/model/settingsSchemas";
import { appCatalogue } from "@/constants/i18nCatalogue";
import { buildersCatalogue } from "@/constants/i18n/builders";
import { settingsCatalogue } from "@/constants/i18n/settings";

const translate = (key: string): string => {
    const entry = settingsCatalogue[key] ?? buildersCatalogue[key] ?? appCatalogue[key];
    return entry?.[1] ?? key;
};
const hasTranslation = (key: string): boolean => key in settingsCatalogue || key in buildersCatalogue || key in appCatalogue;

const NOW = Date.parse("2026-11-26T00:00:00.000Z");

const row = (key: string, version: number, valueJson: Record<string, unknown>, effectiveFrom = "2026-11-01T00:00:00.000Z"): PlatformSettingRow => ({
    id: `${key}-${version}`,
    key,
    scope: "PLATFORM",
    version,
    valueJson,
    effectiveFrom,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
});

describe("platform settings catalog", () => {
    test("every seeded key has a catalog definition and a typed namespace", () => {
        for (const setting of platformSettings) {
            const definition = settingCatalogDefinitions().find((entry) => entry.key === setting.key);
            expect(definition, setting.key).toBeDefined();
            expect(resolveSettingNamespace(definition!.namespaceId), setting.key).not.toBeNull();
        }
    });

    test("every definition has human-readable metadata and every field has a hint", () => {
        for (const definition of settingCatalogDefinitions()) {
            expect(definition.section, definition.key).toBeTruthy();
            expect(definition.summary.trim().length, definition.key).toBeGreaterThan(10);
            expect(definition.description.trim().length, definition.key).toBeGreaterThan(20);
            expect(definition.readBy.trim().length, definition.key).toBeGreaterThan(3);
            expect(definition.effect.trim().length, definition.key).toBeGreaterThan(3);
            expect(["low", "medium", "high", "critical"], definition.key).toContain(definition.risk);
            expect(definition.riskReason.trim().length, definition.key).toBeGreaterThan(10);
            expect(definition.keywords.length, definition.key).toBeGreaterThan(0);
            const namespace = settingNamespaceFor(definition);
            expect(namespace, definition.key).not.toBeNull();
            for (const field of namespace!.fields) {
                expect(field.label.trim().length, `${definition.key}.${field.key}`).toBeGreaterThan(0);
                expect(field.hint.trim().length, `${definition.key}.${field.key}`).toBeGreaterThan(10);
            }
        }
    });

    test("every section, status and catalog string has an Arabic translation", () => {
        const strings = new Set<string>();
        for (const section of SETTING_SECTIONS) strings.add(section.title).add(section.description);
        for (const status of Object.values(SETTING_STATUS_META)) strings.add(status.label).add(status.description);
        for (const definition of settingCatalogDefinitions()) {
            strings.add(definition.summary).add(definition.description).add(definition.readBy).add(definition.effect).add(definition.riskReason);
            const namespace = settingNamespaceFor(definition);
            if (!namespace) continue;
            strings.add(namespace.title).add(namespace.description);
            for (const field of namespace.fields) {
                strings.add(field.label).add(field.hint);
                if (field.description) strings.add(field.description);
                for (const hint of Object.values(field.optionHints ?? {})) strings.add(hint);
            }
        }
        const missing = [...strings].filter((value) => value.length > 0 && !hasTranslation(value));
        expect(missing).toEqual([]);
    });

    test("known-but-unconfigured runtime settings are visible and safe", () => {
        const entries = mergeSettingEntries([], NOW);
        const failClosed = entries.find((entry) => entry.key === "screening.fail_closed");
        expect(failClosed).toBeDefined();
        expect(failClosed!.displayStatus).toBe("UNCONFIGURED");
        expect(failClosed!.value.failClosed).toBe(true);
        const selfPayment = entries.find((entry) => entry.key === "SELF_PAYMENT_POLICY");
        expect(selfPayment!.value.policy).toBe("BLOCK");
        const holidays = entries.find((entry) => entry.key === "calendar.holidays");
        expect(holidays!.value.holidays).toEqual([]);
        expect(CREATABLE_SETTING_DEFINITIONS.map((definition) => definition.key)).toContain("screening.fail_closed");
    });

    test("decision records and managed settings are honest about their effect", () => {
        const entries = mergeSettingEntries([row("OD-7", 1, { otpPullSeconds: 1200 }), row("checkout.support_config", 1, { enabled: true })], NOW);
        const od7 = entries.find((entry) => entry.key === "OD-7")!;
        expect(od7.displayStatus).toBe("DECISION");
        expect(od7.definition.readBy).toContain("None");
        const support = entries.find((entry) => entry.key === "checkout.support_config")!;
        expect(support.displayStatus).toBe("MANAGED");
        expect(support.readOnly).toBe(true);
        expect(support.definition.managePath).toBe("/settings/checkout-help");
    });

    test("effective, scheduled and latest versions are separated", () => {
        const rows = [
            row("route_health.policy", 1, { mode: "SHADOW" }, "2026-11-01T00:00:00.000Z"),
            row("route_health.policy", 2, { mode: "ENFORCE" }, "2026-11-20T00:00:00.000Z"),
            row("route_health.policy", 3, { mode: "OFF" }, "2026-12-10T00:00:00.000Z"),
        ];
        const versions = selectEffectiveVersion(rows, NOW);
        expect(versions.latest?.version).toBe(3);
        expect(versions.effective?.version).toBe(2);
        expect(versions.scheduled.map((item) => item.version)).toEqual([3]);
        const entry = mergeSettingEntries(rows, NOW).find((item) => item.key === "route_health.policy")!;
        expect(entry.value.mode).toBe("ENFORCE");
        expect(entry.scheduled).toHaveLength(1);
    });

    test("an unregistered key becomes an advanced warning entry", () => {
        const entry = mergeSettingEntries([row("my_feature.enabled", 1, { enabled: true })], NOW).find((item) => item.key === "my_feature.enabled")!;
        expect(entry.displayStatus).toBe("UNREGISTERED");
        expect(entry.definition.section).toBe("advanced");
        expect(entry.readOnly).toBe(false);
    });

    test("search matches names, keys, descriptions, hints and Arabic text", () => {
        const entries = mergeSettingEntries([row("route_health.policy", 1, { mode: "ENFORCE" })], NOW);
        const byName = filterSettingEntries(entries, { query: "fail closed", section: "all", status: "all", translate });
        expect(byName.some((entry) => entry.key === "screening.fail_closed")).toBe(true);
        const byKey = filterSettingEntries(entries, { query: "route_health.policy", section: "all", status: "all", translate });
        expect(byKey[0]?.key).toBe("route_health.policy");
        const byHint = filterSettingEntries(entries, { query: "canary", section: "all", status: "all", translate });
        expect(byHint.some((entry) => entry.key === "route_health.policy")).toBe(true);
        const byArabic = filterSettingEntries(entries, { query: "فحص", section: "all", status: "all", translate });
        expect(byArabic.some((entry) => entry.key === "screening.fail_closed")).toBe(true);
        const bySection = filterSettingEntries(entries, { query: "", section: "risk", status: "all", translate });
        expect(bySection.every((entry) => entry.definition.section === "risk")).toBe(true);
    });

    test("search text includes translated field hints and the value preview never emits raw JSON", () => {
        const entry = mergeSettingEntries([row("route_health.policy", 1, { mode: "ENFORCE", windowSeconds: 900 })], NOW).find((item) => item.key === "route_health.policy")!;
        expect(settingSearchText(entry, translate)).toContain("canary");
        const preview = settingPreview(entry, translate);
        expect(preview).not.toContain("{");
        expect(preview).not.toContain("[");
    });

    test("section counts include all and mark settings that use defaults", () => {
        const counts = settingSectionCounts(mergeSettingEntries([], NOW));
        const all = counts.find((count) => count.id === "all")!;
        expect(all.count).toBeGreaterThan(0);
        expect(all.needsSetup).toBeGreaterThan(0);
        expect(counts.find((count) => count.id === "risk")!.count).toBeGreaterThan(0);
    });

    test("go-live keys resolve to typed aspect editors", () => {
        const entry = mergeSettingEntries([row("gateway.go_live.neompay.executive_acceptance", 1, { signed: true })], NOW).find((item) => item.key === "gateway.go_live.neompay.executive_acceptance")!;
        expect(entry.definition.dynamicFamily).toBe(true);
        expect(entry.namespace?.fields.some((field) => field.key === "signed")).toBe(true);
        expect(resolveSettingDefinition("gateway.go_live.neompay.executive_acceptance").lifecycle).toBe("DYNAMIC");
    });
});
