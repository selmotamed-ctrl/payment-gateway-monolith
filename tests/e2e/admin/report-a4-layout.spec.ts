import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * A4/print regression gate for the real client renderer + Paged.js.
 *
 * It fetches a preview bundle from the report engine, renders it through the
 * same SDK the Studio uses, paginates with Paged.js, and checks:
 *  - no visible element crosses the printed sheet boundary;
 *  - landscape/portrait page dimensions match the named page;
 *  - no table continuation loses its header;
 *  - no page overflows vertically;
 *  - KPI grids stay at <= 3 columns and values are not clipped;
 *  - chart rows are centered with at most two charts;
 *  - section titles stay on the same page as their first content.
 *
 * Set REPORT_LAYOUT_PDF=/path/prefix to also export one PDF per locale.
 */

const API = process.env.PG_API_URL ?? "http://127.0.0.1:4101";
const USER = process.env.PG_ADMIN_IDENTIFIER ?? "admin@pg.dev";
const PASS = process.env.PG_ADMIN_PASSWORD ?? "Mayallahhelpme@96";
const SPEC_PATH = process.env.REPORT_LAYOUT_SPEC ?? "/tmp/layout-wide.json";
const ZIP_PATH = process.env.REPORT_LAYOUT_ZIP;
const PREVIEW_MODE = (process.env.REPORT_LAYOUT_MODE === "LIVE" ? "LIVE" : "MOCK") as "MOCK" | "LIVE";

async function session(request: import("@playwright/test").APIRequestContext): Promise<string> {
  if (process.env.PG_TOKEN) return process.env.PG_TOKEN;
  const response = await request.post(`${API}/api/v1/admin/auth/login`, {
    data: { identifier: USER, password: PASS },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.token).toBeTruthy();
  return body.token;
}

test("report pages satisfy A4 containment, headers and orientation", async ({ page, request }) => {
  const token = await session(request);
  const specJson = readFileSync(SPEC_PATH, "utf8");
  const assetsZipBase64 = ZIP_PATH ? readFileSync(ZIP_PATH).toString("base64") : undefined;
  const preview = await request.post(`${API}/api/v1/admin/report-engine/specs/preview`, {
    headers: { authorization: `Bearer ${token}` },
    data: { specJson, mode: PREVIEW_MODE, ...(assetsZipBase64 ? { assetsZipBase64 } : {}) },
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
        const documentHtml = html.replace(
          "</head>",
          '<script src="http://127.0.0.1:5101/report-engine/paged.polyfill.min.js"></script>' +
            '<script src="http://127.0.0.1:5101/report-engine/paged-preview-bridge.js" data-report-token="layout-test"></script></head>',
        );
        document.querySelectorAll("iframe.report-layout-probe").forEach((node) => node.remove());
        const iframe = document.createElement("iframe");
        iframe.className = "report-layout-probe";
        iframe.style.position = "fixed";
        iframe.style.left = "-10000px";
        iframe.style.top = "0";
        iframe.style.width = "1200px";
        iframe.style.height = "1600px";
        iframe.srcdoc = documentHtml;
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
        // The bridge repeats table headers and injects print rules after the
        // final Paged.js pass; give it time to settle.
        await new Promise((resolve) => setTimeout(resolve, 1800));

        const doc = iframe.contentDocument!;
        const pages = [...doc.querySelectorAll<HTMLElement>(".pagedjs_page_content")];
        const pageOf = (element: Element | null): number => {
          const pageElement = element?.closest(".pagedjs_page");
          return pageElement ? pages.findIndex((content) => content.closest(".pagedjs_page") === pageElement) : -1;
        };
        const describe = (element: HTMLElement): string => {
          const cls = typeof element.className === "string" && element.className
            ? `.${element.className.trim().replace(/\s+/g, ".")}`
            : "";
          return `${element.tagName.toLowerCase()}${cls}`;
        };

        const issues: string[] = [];
        const tableHeaderMissing: string[] = [];
        const kpiOverflow: string[] = [];
        const kpiColumns: number[] = [];
        const chartRowIssues: string[] = [];
        const orphanTitles: string[] = [];
        const pageSizes: Array<{
          width: number;
          height: number;
          contentWidth: number;
          sheetWidth: number;
          scrollHeight: number;
          clientHeight: number;
          orientation: string;
        }> = [];

        for (const [index, content] of pages.entries()) {
          const contentRect = content.getBoundingClientRect();
          const pageElement = content.closest(".pagedjs_page") as HTMLElement | null;
          const pageRect = pageElement?.getBoundingClientRect();
          const sheet = content.closest(".pagedjs_sheet") as HTMLElement | null;
          const sheetRect = sheet?.getBoundingClientRect();
          const className = pageElement?.className ?? "";
          pageSizes.push({
            width: pageRect ? Number(pageRect.width.toFixed(1)) : 0,
            height: pageRect ? Number(pageRect.height.toFixed(1)) : 0,
            contentWidth: Number(contentRect.width.toFixed(1)),
            sheetWidth: sheetRect ? Number(sheetRect.width.toFixed(1)) : 0,
            scrollHeight: content.scrollHeight,
            clientHeight: content.clientHeight,
            orientation: className.includes("pagedjs_landscape_page") ? "landscape" : "portrait",
          });

          if (contentRect.width > (sheetRect?.width ?? contentRect.width) + 1) {
            issues.push(`page ${index + 1}: content ${contentRect.width.toFixed(1)} wider than sheet ${sheetRect?.width.toFixed(1)}`);
          }
          if (content.scrollHeight > content.clientHeight + 1) {
            issues.push(`page ${index + 1}: vertical overflow ${content.scrollHeight} > ${content.clientHeight}`);
          }

          for (const element of [...content.querySelectorAll<HTMLElement>("*")]) {
            // SVG children are clipped by the SVG viewport; measure the root SVG.
            if (element.closest("svg") && element.tagName.toLowerCase() !== "svg") continue;
            const rects = [...element.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
            // Ignore Paged.js off-page split clones: only rects starting inside
            // the visible page can be seen by the reader.
            const visible = rects.filter(
              (rect) => rect.left >= contentRect.left - 2 && rect.left < contentRect.right + 2,
            );
            const offender = visible.find(
              (rect) => rect.right > contentRect.right + 1.5 || rect.left < contentRect.left - 1.5,
            );
            if (!offender) continue;
            issues.push(
              `page ${index + 1}: ${describe(element)} left=${offender.left.toFixed(1)} right=${offender.right.toFixed(1)} content=[${contentRect.left.toFixed(1)}, ${contentRect.right.toFixed(1)}]`,
            );
            if (issues.length >= 20) break;
          }

          for (const table of content.querySelectorAll<HTMLTableElement>("table.report-data-table")) {
            if (!table.querySelector("thead")) {
              tableHeaderMissing.push(`page ${index + 1}: table ${table.getAttribute("data-ref") ?? "unknown"}`);
            }
          }

          for (const grid of content.querySelectorAll<HTMLElement>(".report-kpi-grid")) {
            const columns = getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter(Boolean).length;
            kpiColumns.push(columns);
            if (columns > 3) issues.push(`page ${index + 1}: KPI grid has ${columns} columns`);
            for (const value of grid.querySelectorAll<HTMLElement>(".report-kpi-value")) {
              if (value.scrollWidth > value.clientWidth + 1) {
                kpiOverflow.push(`page ${index + 1}: ${value.textContent?.trim()}`);
              }
            }
          }

          for (const row of content.querySelectorAll<HTMLElement>(".report-chart-row")) {
            const children = [...row.children].filter((child) => child.getBoundingClientRect().width > 0);
            if (children.length > 2) chartRowIssues.push(`page ${index + 1}: chart row has ${children.length} charts`);
            const rowRects = [...row.getClientRects()].filter(
              (rect) => rect.left >= contentRect.left - 2 && rect.left < contentRect.right + 2,
            );
            for (const rowRect of rowRects) {
              const rowCenter = rowRect.left + rowRect.width / 2;
              if (Math.abs(rowCenter - (contentRect.left + contentRect.width / 2)) > 2) {
                chartRowIssues.push(`page ${index + 1}: chart row is not centered`);
                break;
              }
            }
          }

          for (const title of content.querySelectorAll<HTMLElement>(".report-section-title")) {
            const section = title.closest(".report-section");
            if (!section) continue;
            const firstContent =
              section.querySelector<HTMLElement>(
                ".report-section-subtitle, .report-kpi-grid, .report-chart-frame, .report-draw-box, .report-data-table tbody tr, .report-html-section > :not(h3)",
              ) ?? null;
            if (!firstContent) continue;
            const titlePage = pageOf(title);
            const contentPage = pageOf(firstContent);
            if (titlePage >= 0 && contentPage >= 0 && titlePage !== contentPage) {
              orphanTitles.push(
                `page ${titlePage + 1} -> ${contentPage + 1}: ${title.textContent?.trim() ?? section.className}`,
              );
            }
          }
        }

        iframe.remove();
        return {
          issues,
          pageCount: pages.length,
          pageSizes,
          tableHeaderMissing,
          kpiOverflow,
          kpiColumns,
          chartRowIssues,
          orphanTitles,
          documentHtml,
        };
      },
      { bundle: payload.bundle, locale },
    );

    expect(result.pageCount, `no pages rendered for ${locale}`).toBeGreaterThan(0);
    expect(result.issues, `${locale} page overflow:\n${result.issues.join("\n")}`).toEqual([]);
    expect(result.tableHeaderMissing, `${locale} missing table headers:\n${result.tableHeaderMissing.join("\n")}`).toEqual([]);
    expect(result.kpiOverflow, `${locale} clipped KPI values:\n${result.kpiOverflow.join("\n")}`).toEqual([]);
    expect(result.kpiColumns.every((columns) => columns <= 3), `${locale} KPI columns: ${result.kpiColumns.join(",")}`).toBe(true);
    expect(result.chartRowIssues, `${locale} chart rows:\n${result.chartRowIssues.join("\n")}`).toEqual([]);
    expect(result.orphanTitles, `${locale} orphan titles:\n${result.orphanTitles.join("\n")}`).toEqual([]);
    for (const [index, pageSize] of result.pageSizes.entries()) {
      expect(pageSize.contentWidth, `${locale} page ${index + 1} content/sheet width`).toBeLessThanOrEqual(
        pageSize.sheetWidth + 1,
      );
      if (pageSize.orientation === "landscape") {
        expect(pageSize.width, `${locale} page ${index + 1} landscape width`).toBeGreaterThan(pageSize.height);
      } else {
        expect(pageSize.height, `${locale} page ${index + 1} portrait height`).toBeGreaterThan(pageSize.width);
      }
    }

    if (process.env.REPORT_LAYOUT_HTML) writeFileSync(process.env.REPORT_LAYOUT_HTML, result.documentHtml);
    if (process.env.REPORT_LAYOUT_PDF) {
      const printPage = await page.context().newPage();
      await printPage.setContent(result.documentHtml, { waitUntil: "load" });
      await printPage.waitForSelector(".pagedjs_page", { timeout: 20_000 });
      await printPage.waitForTimeout(1800);
      await printPage.pdf({
        path: `${process.env.REPORT_LAYOUT_PDF}-${locale}.pdf`,
        preferCSSPageSize: true,
        printBackground: true,
      });
      await printPage.close();
    }
  }
});
