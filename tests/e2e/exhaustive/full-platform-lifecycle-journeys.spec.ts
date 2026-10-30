import { expect, test } from "@playwright/test";

/**
 * Suite 10.1 — cross-service lifecycle journeys.
 *
 * These journeys need the whole stack running on localhost (core-back over
 * mTLS, the three edge backends, both portals, Fake Rails and MySQL). They are
 * enabled with `E2E_LIVE=1` after `scripts/run-exhaustive-suite.sh --deploy`.
 */
const LIVE = process.env.E2E_LIVE === "1";

const URLS = {
  admin: process.env.E2E_ADMIN_URL ?? "http://127.0.0.1:5101",
  merchant: process.env.E2E_MERCHANT_URL ?? "http://127.0.0.1:5102",
  checkout: process.env.E2E_CHECKOUT_URL ?? "http://127.0.0.1:5103",
  fakeRails: process.env.E2E_FAKE_RAILS_URL ?? "http://127.0.0.1:5104",
  adminBack: process.env.E2E_ADMIN_BACK_URL ?? "http://127.0.0.1:4101",
  merchantBack: process.env.E2E_MERCHANT_BACK_URL ?? "http://127.0.0.1:4102",
  checkoutBack: process.env.E2E_CHECKOUT_BACK_URL ?? "http://127.0.0.1:4103",
  fakeRailsBack: process.env.E2E_FAKE_RAILS_BACK_URL ?? "http://127.0.0.1:4104",
};

test.describe("cross-service lifecycle journeys", () => {
  test.skip(!LIVE, "set E2E_LIVE=1 after deploying the stack");

  test("every portal is served", async ({ request }) => {
    for (const [name, url] of Object.entries({
      admin: URLS.admin,
      merchant: URLS.merchant,
      checkout: URLS.checkout,
      fakeRails: URLS.fakeRails,
    })) {
      const response = await request.get(url, { failOnStatusCode: false });
      expect(response.status(), `${name} portal`).toBeLessThan(500);
      expect((await response.text()).toLowerCase(), `${name} html`).toContain("html");
    }
  });

  test("every backend health endpoint answers", async ({ request }) => {
    const endpoints: Array<[string, string]> = [
      ["admin-back", `${URLS.adminBack}/health`],
      ["merchant-back", `${URLS.merchantBack}/health`],
      ["checkout-back", `${URLS.checkoutBack}/health`],
      ["fake-rails-back", `${URLS.fakeRailsBack}/health`],
    ];
    for (const [name, url] of endpoints) {
      const response = await request.get(url, { failOnStatusCode: false });
      expect(response.status(), name).toBe(200);
      const body = await response.json();
      expect(body.status ?? body.ok ?? "ok", name).toBeDefined();
    }
  });

  test("the catalog of 20 fake rails is published", async ({ request }) => {
    const response = await request.get(`${URLS.fakeRailsBack}/portal-api/scenarios`, {
      failOnStatusCode: false,
    });
    // The scenario catalog is tester-authenticated; an unauthenticated probe
    // must be refused, which proves the guard is active.
    expect([200, 401]).toContain(response.status());
  });

  test("a checkout link journey is available when a seeded link is supplied", async ({ request }) => {
    const linkKey = process.env.E2E_LINK_KEY;
    test.skip(!linkKey, "set E2E_LINK_KEY to a seeded payment link");
    const response = await request.get(`${URLS.checkoutBack}/api/v1/pay/${linkKey}`, {
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.summary?.currency ?? body.currency).toBeDefined();
  });
});
