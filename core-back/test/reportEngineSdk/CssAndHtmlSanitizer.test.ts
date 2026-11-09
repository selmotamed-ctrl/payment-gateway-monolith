import { describe, expect, test } from "bun:test";
import {
  sanitizeHtmlForClient,
  validateSafeHtmlAndScopedCss,
} from "../../lib/reportEngineSdk/verifier/CssAndHtmlSanitizer";

describe("RE-T15: HTML/CSS sanitizer", () => {
  test("script tags, event handlers, javascript: URIs and external CSS are rejected", () => {
    const diagnostics = validateSafeHtmlAndScopedCss({
      html: '<div onclick="steal()"><script>alert(1)</script><img src="javascript:alert(1)"></div>',
      scopedCss: '@import url("https://evil.test/x.css"); .x { background: url(https://evil.test/x.png); }',
      basePath: "sections[0]",
    });
    const codes = diagnostics.map((d) => d.code);
    expect(codes).toContain("UNSAFE_HTML_TAG_FORBIDDEN");
    expect(codes).toContain("UNSAFE_HTML_ATTRIBUTE_FORBIDDEN");
    expect(codes).toContain("UNSAFE_CSS_CONSTRUCT_FORBIDDEN");
  });

  test("safe semantic markup passes", () => {
    expect(
      validateSafeHtmlAndScopedCss({
        html: '<section><p>Hello</p><img src="asset://logo" alt="logo" /></section>',
        scopedCss: ".x { color: #111827; }",
        basePath: "sections[0]",
      }),
    ).toEqual([]);
  });

  test("the client sanitizer strips active content (regex fallback path)", () => {
    const sanitized = sanitizeHtmlForClient(
      '<div onclick="x()"><script>alert(1)</script><a href="javascript:alert(1)">x</a><p>ok</p></div>',
    );
    expect(sanitized).not.toContain("<script");
    expect(sanitized).not.toContain("onclick");
    expect(sanitized).not.toContain("javascript:");
    expect(sanitized).toContain("<p>ok</p>");
  });
});
