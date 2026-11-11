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

describe("remediation A12: sanitizer bypass corpus", () => {
  const codesFor = (html: string, scopedCss = "") =>
    validateSafeHtmlAndScopedCss({ html, scopedCss, basePath: "test" }).map((d) => d.code);

  test.each([
    ["style breakout in CSS", "<p>ok</p>", ".x{}</style><script>alert(1)</script>"],
    ["unquoted src", '<img src=javascript:alert(1)>', ""],
    ["inline style url", '<div style="background:url(https://evil.test/x.png)">x</div>', ""],
    ["srcset", '<img src="asset://logo" srcset="https://evil.test/x.png 2x">', ""],
    ["image href data", '<svg><image href="data:image/svg+xml;base64,AAAA"></image></svg>', ""],
    ["use href data", '<svg><use href="data:image/svg+xml;base64,AAAA"></use></svg>', ""],
    ["entity-encoded scheme", '<a href="jav&#x61;script:alert(1)">x</a>', ""],
    ["css escape url", "<p>ok</p>", ".x{background:\\75rl(https://evil.test/x.png)}"],
  ])("rejects %s", (_name, html, css) => {
    expect(codesFor(html, css).length).toBeGreaterThan(0);
  });

  test("rejects image-set()", () => {
    const codes = codesFor("<p>ok</p>", ".x{background:image-set(url(https://evil.test/x.png) 1x)}");
    expect(codes).toContain("UNSAFE_CSS_CONSTRUCT_FORBIDDEN");
  });
});
