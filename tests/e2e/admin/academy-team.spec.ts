import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { ADMIN_URL, EMAILS, READY, SKIP_REASON, apiLogin, authHeaders, injectSession, unwrap } from "./academy-live";

test.describe("academy team view (live stack)", () => {
  test.skip(!READY, SKIP_REASON);
  test.use({ baseURL: ADMIN_URL });

  test("a non-SECURITY_ADMIN gets 403 and no Team entry; the route is not reachable", async ({ page, request }) => {
    const session = await apiLogin(request, EMAILS.nonAdmin);
    expect(session.userInfo.role, "PG_ACADEMY_NONADMIN_EMAIL must not be a SECURITY_ADMIN").not.toBe("SECURITY_ADMIN");

    const response = await request.get(`${ADMIN_URL}/api/v1/admin/academy/team`, { headers: authHeaders(session) });
    expect(response.status()).toBe(403);

    await injectSession(page, session);
    await page.goto("/academy");
    await expect(page.getByRole("heading", { name: "My learning" }).first()).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Academy sections" });
    await expect(nav.getByRole("link", { name: "My learning" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Team", exact: true })).toHaveCount(0);

    await page.goto("/academy/team");
    // Route guard redirects away; if the page ever rendered it would show the forbidden notice, never the table.
    await expect(page.getByRole("table", { name: "Academy progress by person" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Team progress" })).toHaveCount(0);
  });

  test("a SECURITY_ADMIN sees the table and exports exactly the visible rows (formulas neutralised)", async ({ page, request }) => {
    const session = await apiLogin(request, EMAILS.securityAdmin);
    expect(session.userInfo.role).toBe("SECURITY_ADMIN");
    const direct = await request.get(`${ADMIN_URL}/api/v1/admin/academy/team`, { headers: authHeaders(session) });
    expect(direct.status()).toBe(200);
    const team = unwrap<{ rows: { email: string }[] }>(await direct.json());
    expect(team.rows.length).toBeGreaterThan(0);

    // Add one crafted row (browser-side only) to prove a formula-looking name is guarded in the CSV.
    const evilName = '=HYPERLINK("http://example.invalid","click")';
    await page.route("**/api/v1/admin/academy/team", async (route) => {
      const upstream = await route.fetch();
      const body = (await upstream.json()) as Record<string, unknown>;
      const data = (body.data && typeof body.data === "object" ? body.data : body) as { rows: Record<string, unknown>[] };
      data.rows = [
        ...data.rows,
        {
          userId: "crafted-formula-row",
          email: "formula.check@example.invalid",
          name: evilName,
          role: "OPERATOR",
          isMaker: false,
          isChecker: false,
          requiredTracks: ["FOUNDATION", "OPERATOR"],
          activeTrack: null,
          lessonsCompleted: 0,
          lessonsRequired: 1,
          labsPassed: 0,
          labsRequired: 1,
          badges: [],
          lastActivityAt: null,
          status: "NOT_STARTED",
        },
      ];
      await route.fulfill({ response: upstream, json: body });
    });

    await injectSession(page, session);
    await page.goto("/academy");
    await page.getByRole("navigation", { name: "Academy sections" }).getByRole("link", { name: "Team", exact: true }).click();
    await expect(page).toHaveURL(/\/academy\/team$/);
    const table = page.getByRole("table", { name: "Academy progress by person" });
    await expect(table).toBeVisible();
    expect(await table.getByRole("row").count()).toBeGreaterThan(team.rows.length); // header + real rows + crafted row

    // Export everything visible.
    const all = page.getByRole("button", { name: /^Export CSV \(\d+\)$/ });
    const total = team.rows.length + 1;
    await expect(all).toHaveText(`Export CSV (${total})`);
    const [download] = await Promise.all([page.waitForEvent("download"), all.click()]);
    expect(download.suggestedFilename()).toMatch(/^academy-team-\d{4}-\d{2}-\d{2}\.csv$/);
    const text = (await readFile(await download.path(), "utf8")).replace(/^﻿/, "");
    const lines = text.trim().split("\r\n");
    expect(lines.length).toBe(total + 1); // header + one line per visible row
    expect(lines[0]).toContain('"Name","Email","Role"');
    // The formula cell is prefixed with an apostrophe and quoted, never a bare leading "=".
    expect(text).toContain(`"'=HYPERLINK(""http://example.invalid"",""click"")"`);
    expect(lines.some((line) => /(^|,)"=/.test(line))).toBe(false);

    // Filtering narrows both the table and the export to the visible rows.
    await page.getByLabel("Search name or email").fill("formula.check@example.invalid");
    const one = page.getByRole("button", { name: "Export CSV (1)" });
    await expect(one).toBeVisible();
    const [filtered] = await Promise.all([page.waitForEvent("download"), one.click()]);
    const filteredLines = (await readFile(await filtered.path(), "utf8")).replace(/^﻿/, "").trim().split("\r\n");
    expect(filteredLines).toHaveLength(2);
    expect(filteredLines[1]).toContain("formula.check@example.invalid");
  });
});
