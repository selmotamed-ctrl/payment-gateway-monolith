import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * A4 containment check for the real client renderer + Paged.js.
 *
 * The test logs into the live admin edge, fetches a mock preview bundle from
 * the report engine, renders it through the same client SDK the Studio uses,
 * paginates it with Paged.js, and asserts that no visible page element crosses
 * the A4 content box. Paged.js keeps off-page split clones; only client rects
 * that start inside the page are considered, so the check measures the pages
 * a user actually sees.
 */

const API = process.env.PG_API_URL ?? "http://127.0.0.1:4101";
const USER = process.env.PG_ADMIN_IDENTIFIER ?? "admin@pg.dev";
const PASS = process.env.PG_ADMIN_PASSWORD ?? "Mayallahhelpme@96";
const SPEC_PATH = process.env.REPORT_LAYOUT_SPEC ?? "/tmp/layout-wide.json";

async function session(request: import("@playwright/test").APIRequestContext): Promise<{ token: string; payload: any }> {
  if (process.env.PG_TOKEN) {
    return { token: process.env.PG_TOKEN, payload: { token: process.env.PG_TOKEN, userInfo: {} } };
  }
  const response = await request.post(`${API}/api/v1/admin/auth/login`, {
    data: { identifier: USER, password: PASS },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.token).toBeTruthy();
  return { token: body.token, payload: body };
}

test("A4 report has no horizontal overflow", async ({ page, request }) => {
  const { token } = await session(request);
  const specJson = readFileSync(SPEC_PATH, "utf8");
  const preview = await request.post(`${API}/api/v1/admin/report-engine/specs/preview`, {
    headers: { authorization: `Bearer ${token}` },
    data: { specJson, mode: "MOCK" },
  });
  expect(preview.ok(), await preview.text()).toBeTruthy();
  const payload = await preview.json();
  expect(payload.bundle).toBeTruthy();

  await page.addInitScript(() => window.localStorage.setItem("locale-name", "en"));
  await page.goto("http://127.0.0.1:5101/");
  await page.waitForLoadState("domcontentloaded");

  const locales = Object.keys(payload.bundle.spec.i18n.locales ?? { en: {} });
  for (const locale of locales) {
    const result = await page.evaluate(
      async ({ bundle, locale }) => {
        const renderer: any = await import("/src/lib/reportEngineSdk/render/reportHtmlRenderer.ts");
        const exporter: any = await import("/src/lib/reportEngineSdk/print/ClientVectorPdfExporter.ts");
        const sections = renderer.renderReportSectionsToHtml({
          bundle,
          locale,
          includeHiddenSections: true,
        });
        const html = exporter.buildPagedMediaHtmlDocument({
          bundle,
          locale,
          renderedSectionsHtml: sections,
          renderedHeaderHtml: renderer.renderChromeHtml({
            chrome: bundle.resolvedHeaderChrome,
            bundle,
            locale,
          }),
          renderedFooterHtml: renderer.renderChromeHtml({
            chrome: bundle.resolvedFooterChrome,
            bundle,
            locale,
          }),
        });
        document.querySelectorAll("iframe.report-layout-probe").forEach((node) => node.remove());
        const iframe = document.createElement("iframe");
        iframe.className = "report-layout-probe";
        iframe.style.position = "fixed";
        iframe.style.left = "-10000px";
        iframe.style.top = "0";
        iframe.style.width = "1200px";
        iframe.style.height = "1600px";
        iframe.srcdoc = html.replace(
          "</head>",
          '<script src="http://127.0.0.1:5101/report-engine/paged.polyfill.min.js"></script></head>',
        );
        document.body.appendChild(iframe);
        await new Promise<void>((resolve) => {
          const started = Date.now();
          const tick = () => {
            const doc = iframe.contentDocument;
            if (doc?.querySelectorAll(".pagedjs_page").length) resolve();
            else if (Date.now() - started > 15_000) resolve();
            else setTimeout(tick, 100);
          };
          tick();
        });
        await new Promise((resolve) => setTimeout(resolve, 800));

        const doc = iframe.contentDocument!;
        const pages = [...doc.querySelectorAll<HTMLElement>(".pagedjs_page_content")];
        const issues: string[] = [];
        const describe = (element: HTMLElement): string => {
          const cls = typeof element.className === "string" && element.className ? `.${element.className.trim().replace(/\s+/g, ".")}` : "";
          return `${element.tagName.toLowerCase()}${cls}`;
        };

        for (const [index, content] of pages.entries()) {
          const contentRect = content.getBoundingClientRect();
          for (const element of [...content.querySelectorAll<HTMLElement>("*")]) {
            const rects = [...element.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
            // Ignore Paged.js off-page clones: only rects that start inside the
            // visible page content can be seen by the reader.
            const visible = rects.filter(
              (rect) => rect.left >= contentRect.left - 2 && rect.left < contentRect.right + 2,
            );
            const offender = visible.find(
              (rect) => rect.right > contentRect.right + 1.5 || rect.left < contentRect.left - 1.5,
            );
            if (!offender) continue;
            issues.push(
              `page ${index + 1}: ${describe(element)} left=${offender.left.toFixed(1)} right=${offender.right.toFixed(1)} content=[${contentRect.left.toFixed(1)}, ${contentRect.right.toFixed(1)}] html=${element.outerHTML.slice(0, 180).replace(/\s+/g, " ")}`,
            );
            if (issues.length >= 20) break;
          }
          if (issues.length >= 20) break;
        }

        const pageCount = pages.length;
        iframe.remove();
        return { issues, pageCount };
      },
      { bundle: payload.bundle, locale },
    );
    expect(result.pageCount, `no pages rendered for ${locale}`).toBeGreaterThan(0);
    expect(result.issues, `${locale} overflow:\n${result.issues.join("\n")}`).toEqual([]);
  }
});
