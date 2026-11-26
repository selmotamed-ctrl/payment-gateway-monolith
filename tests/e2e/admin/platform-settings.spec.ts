import { expect, test } from "@playwright/test";
import { ADMIN_KEY, adminSession, seedSession } from "../fixtures";

const json = (status: number, body: unknown) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const session = {
    ...adminSession,
    userInfo: {
        ...adminSession.userInfo,
        authoritiesMap: {
            ...adminSession.userInfo.authoritiesMap,
            "settings:read": true,
            "settings:write": true,
            "settings.read": true,
            "settings.write": true,
        },
    },
};

const row = (key: string, version: number, valueJson: Record<string, unknown>, effectiveFrom: string, updatedAt = "2026-11-20T09:00:00.000Z") => ({
    id: `${key}-${version}`,
    key,
    scope: "PLATFORM",
    version,
    valueJson,
    effectiveFrom,
    createdAt: effectiveFrom,
    updatedAt,
});

const rows = [
    row("route_health.policy", 1, {
        enabled: true,
        mode: "SHADOW",
        sampleBucketSeconds: 300,
        windowSeconds: 900,
        minOutcomes: 10,
        degradeErrorRate: 0.3,
        openErrorRate: 0.6,
        degradeConsecutive: 3,
        openConsecutive: 6,
        recoverDegradedProbes: 2,
        recoverOpenProbes: 3,
        openCooldownSeconds: 300,
        probeIntervalSeconds: 60,
        probeBackoffMaxSeconds: 900,
        canaryPercent: 5,
        canaryMaxAmount: null,
        degradedRecoverMinOutcomes: 10,
        degradedRecoverErrorRate: 0.1,
        overrideDefaultExpiryDays: 7,
        overrideMaxExpiryDays: 30,
        overrideReviewHours: 24,
    }, "2026-11-01T00:00:00.000Z"),
    row("route_health.policy", 2, { mode: "ENFORCE", enabled: true, canaryPercent: 10 }, "2026-11-20T00:00:00.000Z"),
    row("route_health.policy", 3, { mode: "OFF", enabled: false }, "2026-12-10T00:00:00.000Z"),
    row("OD-7", 1, { otpPullSeconds: 1200, redirectSeconds: 1800, qrDisplaySeconds: 900, pushApprovalSeconds: 900 }, "2026-11-02T00:00:00.000Z"),
    row("checkout.support_config", 1, { enabled: true, show_platform_contact: true, faq_items: [] }, "2026-11-03T00:00:00.000Z"),
    row("my_feature.enabled", 1, { enabled: true }, "2026-11-04T00:00:00.000Z"),
];

let lastSettingsPut: Record<string, unknown> | null = null;

const summary = {
    summary: {
        keys: 4,
        versions: 6,
        scopes: { PLATFORM: 6 },
        futureEffective: 1,
        updatedLast24h: 3,
    },
};

test.beforeEach(async ({ page }) => {
    lastSettingsPut = null;
    await seedSession(page, ADMIN_KEY, session);
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() === "PUT" && url.pathname.endsWith("/settings")) {
            lastSettingsPut = route.request().postDataJSON() as Record<string, unknown>;
            await route.fulfill(json(200, { settings: [{ key: "screening.fail_closed", version: 1 }] }));
            return;
        }
        if (url.pathname.endsWith("/settings/communication/status")) {
            await route.fulfill(json(200, {
                status: {
                    email: { enabled: true, configured: false, source: "NONE", missingFields: ["smtpHost", "fromEmail"], lastTestAt: null, lastTestStatus: null, lastTestError: null, lastDeliveryAt: null, lastDeliveryStatus: null, consecutiveFailures: 0 },
                    sms: { enabled: false, configured: false, source: "NONE", missingFields: ["webhookUrl"], lastTestAt: null, lastTestStatus: null, lastTestError: null, lastDeliveryAt: null, lastDeliveryStatus: null, consecutiveFailures: 0 },
                    google: { enabled: false, configured: false, source: "NONE", missingFields: ["clientId"], lastTestAt: null, lastTestStatus: null, lastTestError: null, lastDeliveryAt: null, lastDeliveryStatus: null, consecutiveFailures: 0 },
                    maintenance: { active: true, code: "COMMUNICATION_EMAIL_UNCONFIGURED", message: "Email delivery is not configured." },
                },
            }));
            return;
        }
        if (url.pathname.endsWith("/settings/summary")) {
            await route.fulfill(json(200, summary));
            return;
        }
        if (url.pathname.endsWith("/settings")) {
            await route.fulfill(json(200, { settings: rows }));
            return;
        }
        await route.fulfill(json(200, {}));
    });
});

test("sections, search and honest statuses render", async ({ page }) => {
    await page.goto("/settings/platform");
    await expect(page.getByRole("heading", { name: "Platform Settings" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /All settings/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Payments & routing/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Payments & routing" })).toBeVisible();

    const results = page.locator("#pg-settings-results");
    await page.getByRole("textbox", { name: "Search settings" }).fill("fail closed");
    await expect(results.getByText("Screening fail-closed switch")).toBeVisible();
    await expect(results.getByText("Route health policy")).not.toBeVisible();

    await page.getByRole("textbox", { name: "Search settings" }).fill("");
    await page.getByRole("tab", { name: /Risk & screening/ }).click();
    await expect(results.getByText("Screening fail-closed switch")).toBeVisible();
    await expect(results.getByText("Route health policy")).not.toBeVisible();

    await page.getByRole("tab", { name: /All settings/ }).click();
    await expect(results.getByText("Recorded decision").first()).toBeVisible();
    await expect(results.getByText("Unregistered", { exact: true }).first()).toBeVisible();
    await expect(results.getByText("Managed elsewhere")).toBeVisible();
});

test("the drawer explains a setting and separates current from scheduled versions", async ({ page }) => {
    await page.goto("/settings/platform");
    const results = page.locator("#pg-settings-results");
    await page.getByRole("textbox", { name: "Search settings" }).fill("canary");
    await results.getByRole("button", { name: /Route health policy/ }).click();
    await expect(page.getByRole("heading", { name: "Route health policy" })).toBeVisible();
    await expect(page.getByText("Read by", { exact: true })).toBeVisible();
    await expect(page.getByText("Takes effect", { exact: true })).toBeVisible();
    await expect(page.getByText(/Route health worker, gateway probes/)).toBeVisible();
    await expect(page.getByText("Scheduled", { exact: true }).first()).toBeVisible();

    await page.getByRole("tab", { name: "Value" }).click();
    await expect(page.getByText("Share of traffic sent to a degraded route for observation. 5 = 5%.")).toBeVisible();
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByText("Compare with current").first()).toBeVisible();
});

test("unconfigured and managed settings stay explicit", async ({ page }) => {
    await page.goto("/settings/platform");
    const results = page.locator("#pg-settings-results");
    await page.getByRole("textbox", { name: "Search settings" }).fill("fail closed");
    await results.getByRole("button", { name: /Screening fail-closed switch/ }).click();
    await expect(page.getByText("No value is stored yet. The platform is using the built-in default shown below; saving creates the first version.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save new version" })).toBeVisible();
    await page.getByRole("complementary", { name: /Screening fail-closed switch/ }).getByLabel("Close").click();

    await page.getByRole("textbox", { name: "Search settings" }).fill("checkout support");
    await results.getByRole("button", { name: /Checkout support configuration/ }).click();
    await expect(page.getByRole("complementary", { name: /Checkout support configuration/ }).getByText("Managed elsewhere").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Open the owning screen" }).first()).toHaveAttribute("href", "/settings/checkout-help");
});

test("saving an unconfigured switch sends a typed value, checklist and change note", async ({ page }) => {
    await page.goto("/settings/platform");
    const results = page.locator("#pg-settings-results");
    await page.getByRole("textbox", { name: "Search settings" }).fill("fail closed");
    await results.getByRole("button", { name: /Screening fail-closed switch/ }).click();
    await page.getByRole("tab", { name: "Value" }).click();
    const drawer = page.getByRole("complementary", { name: /Screening fail-closed switch/ });
    await drawer.getByRole("checkbox").first().click();
    await page.getByRole("textbox", { name: "Change note" }).fill("Emergency screening outage drill");
    for (const label of ["Key and scope verified", "Value schema reviewed", "Effective date reviewed", "Immutable-version impact acknowledged"]) {
        await page.getByRole("checkbox", { name: label }).check();
    }
    await page.getByRole("button", { name: "Save new version" }).click();
    await expect.poll(() => lastSettingsPut).not.toBeNull();
    expect(lastSettingsPut).toMatchObject({
        settings: { "screening.fail_closed": { failClosed: false } },
        reason: "Emergency screening outage drill",
        checklist: ["KEY_SCOPE_VERIFIED", "VALUE_SCHEMA_REVIEWED", "EFFECTIVE_DATE_REVIEWED", "IMMUTABLE_VERSION_ACKNOWLEDGED"],
    });
});

test("deep links open a section and a setting", async ({ page }) => {
    await page.goto("/settings/platform?section=risk&open=screening.fail_closed");
    await expect(page.getByRole("tab", { name: /Risk & screening/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Screening fail-closed switch" })).toBeVisible();
});

test("the settings workspace does not overflow a phone viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings/platform");
    await expect(page.getByRole("textbox", { name: "Search settings" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /All settings/ })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
});

test("the communication tab shows readiness and opens the typed channel settings", async ({ page }) => {
    await page.goto("/settings/platform");
    await page.getByRole("tab", { name: "Communication" }).click();
    await expect(page.getByText("Merchant registration and sign-in are in maintenance")).toBeVisible();
    await expect(page.getByText("Email delivery is not configured.")).toBeVisible();
    await expect(page.getByText("Google sign-in has no delivery test.")).toBeVisible();

    await page.getByRole("button", { name: "Edit setting" }).first().click();
    await expect(page.getByRole("heading", { name: "Email delivery (SMTP)" })).toBeVisible();
    await expect(page.getByText("Using default").first()).toBeVisible();
    await page.getByRole("tab", { name: "Value" }).click();
    await expect(page.getByLabel("SMTP host")).toBeVisible();
});
