import { describe, expect, test } from "vitest";
import { sanitizeReportCss } from "../sanitizer/ClientDomSanitizer";

describe("client report CSS sanitizer", () => {
  test("strips style breakout, imports and non-data URLs", () => {
    const css = sanitizeReportCss(
      ".x{color:red}</style><script>alert(1)</script>@import url(https://evil.test/x.css);.y{background:url(https://evil.test/x.png)}",
    );
    expect(css).not.toContain("</style>");
    expect(css).not.toContain("@import");
    expect(css).not.toContain("evil.test");
  });

  test("keeps data image URLs used by report assets", () => {
    const css = sanitizeReportCss(".logo{background:url(data:image/png;base64,AAAA)}");
    expect(css).toContain("data:image/png;base64");
  });
});
