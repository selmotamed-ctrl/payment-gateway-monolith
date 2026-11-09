import { describe, expect, it } from "vitest";
import { buildLocaleOptions } from "../utils/localeMeta";

describe("RE-T18: multi-language prompt options", () => {
  it("offers every supported locale with native name, direction and localized title", () => {
    const options = buildLocaleOptions(["en", "ar", "fr"], { ar: "تقرير اختبار" });
    expect(options.map((option) => option.locale)).toEqual(["en", "ar", "fr"]);
    expect(options[1]).toMatchObject({
      nativeName: "العربية (Arabic)",
      direction: "RTL",
      localizedTitle: "تقرير اختبار",
    });
    expect(options[2]).toMatchObject({ nativeName: "Français (French)", direction: "LTR" });
  });

  it("falls back to the uppercase code and detects Arabic variants as RTL", () => {
    const [option] = buildLocaleOptions(["ar-LY"]);
    expect(option).toMatchObject({ nativeName: "AR-LY", direction: "RTL" });
  });
});
