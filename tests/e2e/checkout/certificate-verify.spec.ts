import { expect, test } from "@playwright/test";

const certificate = {
    certificateId: "PG-AC-ABCDEF01",
    publicId: "opaquePublicId0123456789abcdef",
    status: "valid",
    holderName: "operator",
    trackId: "FOUNDATION",
    trackTitle: "Foundation",
    badgeCode: "FOUNDATION_CERTIFIED",
    earnedAt: "2026-11-23T07:00:00.000Z",
    expiresAt: "2027-11-23T07:00:00.000Z",
    contentVersion: "1.0.0",
};

test("public certificate verification shows a valid certificate", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("locale-name", "en"));
    await page.route("**/api/v1/verify/certificate/**", (route) => route.fulfill({ status: 200, json: certificate }));
    await page.goto("/verify/certificate/opaquePublicId0123456789abcdef");
    await expect(page.getByText("Valid certificate")).toBeVisible();
    await expect(page.getByText("operator")).toBeVisible();
    await expect(page.getByText("PG-AC-ABCDEF01")).toBeVisible();
    await expect(page.getByText("Foundation", { exact: true })).toBeVisible();
});

test("public certificate verification distinguishes expired and revoked certificates", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("locale-name", "en"));
    await page.route("**/api/v1/verify/certificate/**", (route) =>
        route.fulfill({ status: 200, json: { ...certificate, status: "expired" } }),
    );
    await page.goto("/verify/certificate/opaquePublicId0123456789abcdef");
    await expect(page.getByText("Expired certificate")).toBeVisible();
    await expect(page.getByText("This certificate has expired. The holder must recertify to renew it.")).toBeVisible();
    await page.unroute("**/api/v1/verify/certificate/**");
    await page.route("**/api/v1/verify/certificate/**", (route) =>
        route.fulfill({ status: 200, json: { ...certificate, status: "revoked" } }),
    );
    await page.reload();
    await expect(page.getByText("Revoked certificate")).toBeVisible();
    await expect(page.getByText("This certificate was revoked by the issuer and is not valid. Contact the Academy administrator for details.")).toBeVisible();
});

test("public certificate verification reports an invalid link", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("locale-name", "en"));
    await page.route("**/api/v1/verify/certificate/**", (route) =>
        route.fulfill({ status: 404, json: { code: "CERTIFICATE_NOT_FOUND", error: "The certificate could not be verified", status: 404 } }),
    );
    await page.goto("/verify/certificate/opaquePublicId0000000000000000");
    await expect(page.getByText("The certificate could not be verified")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});
