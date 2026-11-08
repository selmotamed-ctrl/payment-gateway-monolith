import { describe, expect, test } from "vitest";
import {
  buildEvidenceSubmission,
  emptyEvidenceForm,
  evidenceDocumentLinks,
  evidenceHiddenKeys,
  parseDocumentUrls,
  validateEvidenceForm,
} from "@/pages/disputes/evidenceModel";
import { describeSeverityInputs } from "@/pages/aml/cases/severityInputs";
import { listVersionChips } from "@/pages/aml/screenings/listVersions";

describe("dispute evidence mapping", () => {
  test("form -> request body (evidence keys, notes at top level, no empty keys)", () => {
    const body = buildEvidenceSubmission({
      receiptRef: " RRN-123 ",
      customerProofSummary: "Payer confirmed by SMS",
      merchantResponse: "",
      documentUrls: "https://example.com/a.pdf\n https://example.com/b.pdf \nhttps://example.com/a.pdf",
      notes: "  See attached  ",
    });
    expect(body).toEqual({
      evidence: {
        receiptRef: "RRN-123",
        customerProofSummary: "Payer confirmed by SMS",
        documentUrls: ["https://example.com/a.pdf", "https://example.com/b.pdf"],
      },
      notes: "See attached",
    });
    expect(buildEvidenceSubmission({ ...emptyEvidenceForm(), receiptRef: "X" })).toEqual({ evidence: { receiptRef: "X" } });
  });

  test("validation", () => {
    expect(validateEvidenceForm(emptyEvidenceForm())).toEqual([{ field: "form", code: "EMPTY" }]);
    expect(validateEvidenceForm({ ...emptyEvidenceForm(), notes: "ok" })).toEqual([]);
    expect(validateEvidenceForm({ ...emptyEvidenceForm(), notes: "x".repeat(2001) })).toContainEqual({ field: "notes", code: "TOO_LONG" });
    expect(validateEvidenceForm({ ...emptyEvidenceForm(), documentUrls: "ftp://x.example\nnot a url" })).toEqual([
      { field: "documentUrls", code: "INVALID_URL", value: "ftp://x.example" },
      { field: "documentUrls", code: "INVALID_URL", value: "not a url" },
    ]);
    const many = Array.from({ length: 11 }, (_, i) => `https://e.example/${i}`).join("\n");
    expect(validateEvidenceForm({ ...emptyEvidenceForm(), documentUrls: many })).toContainEqual({ field: "documentUrls", code: "TOO_MANY_URLS" });
    expect(parseDocumentUrls("a, b\n\n c")).toEqual(["a", "b", "c"]);
  });

  test("stored evidence: links and hidden keys (legacy documentUrl / summary)", () => {
    const stored = {
      receiptRef: "R1",
      documentUrls: ["https://e.example/a", "javascript:alert(1)"],
      documentUrl: "https://e.example/legacy",
      summary: "dup",
      notes: "dup",
      submittedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(evidenceDocumentLinks(stored)).toEqual(["https://e.example/a", "https://e.example/legacy"]);
    expect(evidenceHiddenKeys(stored)).toEqual(["documentUrls", "documentUrl", "summary"]);
    expect(evidenceHiddenKeys({ summary: "only" })).toEqual(["documentUrls", "documentUrl"]);
    expect(evidenceDocumentLinks(null)).toEqual([]);
  });
});

describe("AML severity inputs", () => {
  test("rule-engine trail becomes steps", () => {
    const view = describeSeverityInputs([
      { source: "MERCHANT_RISK_TIER_HIGH", effect: "Merchant risk tier HIGH", from: "MEDIUM", to: "HIGH" },
      { source: "SCREENING_POTENTIAL_PEP", effect: "Potential PEP match", from: null, to: "HIGH" },
    ]);
    expect(view).toEqual({
      kind: "steps",
      steps: [
        { source: "MERCHANT_RISK_TIER_HIGH", label: "Merchant Risk Tier High", effect: "Merchant risk tier HIGH", from: "MEDIUM", to: "HIGH" },
        { source: "SCREENING_POTENTIAL_PEP", label: "Screening Potential PEP", effect: "Potential PEP match", from: null, to: "HIGH" },
      ],
    });
  });

  test("free-form objects and other arrays are generic, empties are empty", () => {
    expect(describeSeverityInputs({ screening_id: "s1", highest_score: 98 })).toMatchObject({ kind: "generic" });
    expect(describeSeverityInputs([{ screening: "s1", score: 90 }])).toMatchObject({ kind: "generic" });
    for (const value of [null, undefined, {}, []]) expect(describeSeverityInputs(value)).toEqual({ kind: "empty" });
  });
});

describe("AML screening list versions", () => {
  test("object of list -> version", () => {
    expect(listVersionChips({ sanctions: "v2026.10", adverse_media: "v2026.09", ofac: "2026-01" })).toEqual([
      { list: "Sanctions", version: "v2026.10" },
      { list: "Adverse Media", version: "v2026.09" },
      { list: "OFAC", version: "2026-01" },
    ]);
  });

  test("tolerated shapes", () => {
    expect(listVersionChips(["un", "eu"])).toEqual([{ list: "UN", version: "" }, { list: "EU", version: "" }]);
    expect(listVersionChips({ pep: { version: "7" } })).toEqual([{ list: "PEP", version: "7" }]);
    expect(listVersionChips([{ list: "local_cbl", version: "3" }])).toEqual([{ list: "Local CBL", version: "3" }]);
    expect(listVersionChips(null)).toEqual([]);
    expect(listVersionChips({})).toEqual([]);
  });
});
