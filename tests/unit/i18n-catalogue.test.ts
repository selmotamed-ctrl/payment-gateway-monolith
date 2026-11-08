import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { analyse, type Catalogue } from "./helpers/i18nScan";
import { appCatalogue as adminApp } from "../../admin-front/src/constants/i18nCatalogue";
import { academyCatalogue } from "../../admin-front/src/constants/i18nAcademy";
import { commerceCatalogue } from "../../admin-front/src/constants/i18n/commerce";
import { ledgerOpsCatalogue } from "../../admin-front/src/constants/i18n/ledgerOps";
import { formsCatalogue } from "../../admin-front/src/constants/i18n/forms";
import { buildersCatalogue } from "../../admin-front/src/constants/i18n/builders";
import { appCatalogue as merchantApp } from "../../merchant-front/src/constants/i18nCatalogue";
import { landingCatalogue } from "../../merchant-front/src/constants/landingCatalogue";
import { appCatalogue as checkoutApp } from "../../checkout-front/src/constants/i18nCatalogue";

/**
 * The English text IS the translation key, so the catalogues have two failure modes that nothing else catches:
 *
 * 1. A key defined in two catalogue files with different Arabic. The app spreads the files into one object, so the
 *    LAST one silently wins on every page (the academy showed "5 أدنى" - "minimum" - for "5 min" because the cost
 *    model builder defined `min` too). This must stay at zero; a word that needs two renderings needs two keys.
 * 2. A literal `t("...")` key with no catalogue entry falls back to English in the Arabic UI (`missingWarn` is
 *    off, so it is invisible). A baseline records today's gaps; it may only SHRINK. Add the Arabic entry and
 *    delete the line from the baseline (`UPDATE_I18N_BASELINE=1 bun run test:unit` rewrites it).
 */
const ROOT = join(__dirname, "..", "..");
const fronts: Array<{ name: string; src: string; catalogues: Catalogue[] }> = [
  {
    name: "admin-front",
    src: join(ROOT, "admin-front", "src"),
    catalogues: [
      { name: "i18nCatalogue", entries: adminApp },
      { name: "i18nAcademy", entries: academyCatalogue },
      { name: "commerce", entries: commerceCatalogue },
      { name: "ledgerOps", entries: ledgerOpsCatalogue },
      { name: "forms", entries: formsCatalogue },
      { name: "builders", entries: buildersCatalogue },
    ],
  },
  {
    name: "merchant-front",
    src: join(ROOT, "merchant-front", "src"),
    catalogues: [
      { name: "landingCatalogue", entries: landingCatalogue },
      { name: "i18nCatalogue", entries: merchantApp },
    ],
  },
  { name: "checkout-front", src: join(ROOT, "checkout-front", "src"), catalogues: [{ name: "i18nCatalogue", entries: checkoutApp }] },
];

const baselinePath = (front: string): string => join(__dirname, "fixtures", `i18n-missing-${front}.json`);

for (const front of fronts) {
  describe(`${front.name} catalogues`, () => {
    const { missing, conflicts } = analyse(front.src, front.catalogues);

    test("no key has two different Arabic values", () => {
      expect(conflicts).toEqual([]);
    });

    test("untranslated literal keys never grow beyond the baseline, and the baseline stays honest", () => {
      if (process.env.UPDATE_I18N_BASELINE === "1") {
        mkdirSync(dirname(baselinePath(front.name)), { recursive: true });
        writeFileSync(baselinePath(front.name), `${JSON.stringify(missing, null, 2)}\n`);
      }
      expect(existsSync(baselinePath(front.name))).toBe(true);
      const baseline = new Set(JSON.parse(readFileSync(baselinePath(front.name), "utf8")) as string[]);
      const added = missing.filter((key) => !baseline.has(key));
      expect(added, "new t() keys need an Arabic entry in the catalogue").toEqual([]);
      const stale = [...baseline].filter((key) => !missing.includes(key));
      expect(stale, "translated (or removed) keys: delete them from the baseline").toEqual([]);
    });
  });
}
