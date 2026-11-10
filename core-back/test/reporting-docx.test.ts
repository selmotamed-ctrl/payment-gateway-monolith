import { describe, expect, test } from "bun:test";
import { unzipSync, strFromU8 } from "fflate";
import { parseDocxNarrativeSchema, renderRegulatoryDocx } from "../lib/docx/regulatoryDocx";

const schema = parseDocxNarrativeSchema({
  schemaVersion: 1,
  mode: "DOCX",
  title: "Incident report",
  subtitle: "Confidential",
  sections: [
    { key: "summary", title: "Summary", required: true },
    { key: "impact", title: "Impact", headingLevel: 2 },
  ],
  tables: [{ title: "Actions", rowsPath: "actions", columns: [{ key: "title", header: "Action" }, { key: "status", header: "Status" }] }],
});

describe("DOCX regulatory report", () => {
  test("rejects a schema that is not a DOCX narrative definition", () => {
    expect(() => parseDocxNarrativeSchema({ schemaVersion: 1, mode: "XLSX" })).toThrow();
  });

  test("renders escaped paragraphs and a table into a valid OOXML package", () => {
    const result = renderRegulatoryDocx(schema, {
      narrative: { summary: "Gateway <outage> & recovery", impact: "No funds lost" },
      actions: [{ title: "Restore rail", status: "DONE" }],
    });
    expect(result.issues).toEqual([]);
    const files = unzipSync(result.buffer);
    const document = strFromU8(files["word/document.xml"]!);
    expect(document).toContain("Gateway &lt;outage&gt; &amp; recovery");
    expect(document).toContain("<w:tbl>");
    expect(document).toContain("Restore rail");
    expect(files["[Content_Types].xml"]).toBeTruthy();
    expect(files["word/styles.xml"]).toBeTruthy();
  });

  test("reports a required missing section", () => {
    const result = renderRegulatoryDocx(schema, { narrative: {}, actions: [] });
    expect(result.issues.some((issue) => issue.rule === "REQUIRED_SECTION")).toBe(true);
  });
});
