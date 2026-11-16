import { describe, expect, test } from "bun:test";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { contentDisposition } from "../lib/contentDisposition";

/**
 * HTTP header values are Latin-1. A download route that put a user-supplied file name straight into
 * `Content-Disposition` threw `ERR_INVALID_CHAR` for any name with a character above U+00FF, so a KYB document,
 * a dispute attachment, AML evidence or a bank statement with an Arabic name could not be downloaded (500).
 */
const ARABIC = "فاتورة العميل.pdf";

describe("contentDisposition", () => {
  test("a plain ASCII name is sent as it is", () => {
    expect(contentDisposition("attachment", "statement-2026-10.csv")).toBe('attachment; filename="statement-2026-10.csv"');
    expect(contentDisposition("inline", "logo.png")).toBe('inline; filename="logo.png"');
  });

  test("a non-ASCII name gets an ASCII fallback and the real name in filename*", () => {
    const value = contentDisposition("attachment", ARABIC, "evidence");
    expect(value).toBe(`attachment; filename="evidence.pdf"; filename*=UTF-8''${encodeURIComponent(ARABIC)}`);
    // Every character of the header is printable ASCII.
    expect(/^[\x20-\x7e]+$/.test(value)).toBe(true);
    // And the receiver gets the original name back.
    expect(decodeURIComponent(value.split("filename*=UTF-8''")[1]!)).toBe(ARABIC);
  });

  test("a mixed name keeps its ASCII part in the fallback", () => {
    const value = contentDisposition("attachment", "invoice-١٢٣-final.pdf");
    expect(value.startsWith('attachment; filename="invoice-_-final.pdf"; filename*=UTF-8\'\'')).toBe(true);
  });

  test.each([
    ['evil".pdf', 'attachment; filename="evil_.pdf"; filename*=UTF-8\'\'evil%22.pdf'],
    ["a\r\nSet-Cookie: x=1.pdf", 'attachment; filename="a  Set-Cookie_ x=1.pdf"; filename*=UTF-8\'\'a%20%20Set-Cookie%3A%20x%3D1.pdf'],
    ["..\\..\\secret.txt", 'attachment; filename="secret.txt"'],
    ["../../etc/passwd", 'attachment; filename="passwd"'],
  ])("a hostile name cannot break out of the header: %j", (name, expected) => {
    const value = contentDisposition("attachment", name);
    expect(value).toBe(expected);
    expect(value).not.toMatch(/[\r\n]/);
  });

  test("an empty or missing name uses the fallback", () => {
    expect(contentDisposition("attachment", null, "evidence")).toBe('attachment; filename="evidence"');
    expect(contentDisposition("attachment", "   ", "statement")).toBe('attachment; filename="statement"');
    expect(contentDisposition("attachment", undefined)).toBe('attachment; filename="download"');
  });

  test("the characters RFC 5987 forbids unencoded are escaped", () => {
    const value = contentDisposition("attachment", "ملف (1)'*.pdf");
    expect(value).toContain("%281%29%27%2A.pdf");
  });

  test("a very long name is cut", () => {
    const value = contentDisposition("attachment", `${"a".repeat(500)}.pdf`);
    expect(value.length).toBeLessThan(260);
  });
});

describe("a real response", () => {
  test("the header is accepted by the HTTP layer and the old form is not", async () => {
    const app = express();
    app.get("/new", (_request, response) => {
      response.setHeader("Content-Disposition", contentDisposition("attachment", ARABIC, "evidence"));
      response.send("ok");
    });
    app.get("/old", (_request, response) => {
      try {
        response.setHeader("Content-Disposition", `attachment; filename="${ARABIC.replace(/["\r\n]/g, "_")}"`);
        response.send("ok");
      } catch (error) {
        response.status(500).send((error as Error).message);
      }
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const fresh = await fetch(`http://127.0.0.1:${port}/new`);
      expect(fresh.status).toBe(200);
      expect(fresh.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent(ARABIC)}`);
      // What every download route did before: the runtime refuses the header.
      const old = await fetch(`http://127.0.0.1:${port}/old`);
      expect(old.status).toBe(500);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("download routes", () => {
  test("no route builds the header from a user-supplied name by hand", async () => {
    for (const file of ["../api/internal/admin.ts", "../api/internal/merchant.ts"]) {
      const source = await Bun.file(new URL(file, import.meta.url)).text();
      // The only hand-written values left are fixed, generated names (report-<id>.docx, statement-<month>.csv).
      const handWritten = [...source.matchAll(/setHeader\("content-disposition", `([^`]*)`/gi)].map((match) => match[1]!);
      for (const value of handWritten) {
        expect(value).toMatch(/^attachment; filename="(report-\$\{id\}\.(docx|xlsx)|statement-\$\{month\}\.csv)"$/);
      }
      expect(source).toContain('import { contentDisposition } from "../../lib/contentDisposition";');
    }
  });
});
