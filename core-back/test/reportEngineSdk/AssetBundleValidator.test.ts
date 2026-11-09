import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import {
  extractZipAssetFiles,
  verifyExtractedAssetsAgainstSpec,
} from "../../lib/reportEngineSdk/verifier/AssetBundleValidator";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
]);

async function zipOf(files: Record<string, Buffer | string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("RE-T14: asset bundle validation", () => {
  test("a valid PNG + safe SVG bundle is accepted", async () => {
    const zipBuffer = await zipOf({
      "logo.png": PNG,
      "mark.svg": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" /></svg>',
    });
    const extracted = await extractZipAssetFiles({
      zipBuffer,
      maxZipBytes: 5 * 1024 * 1024,
      maxSingleAssetBytes: 1024 * 1024,
    });
    expect(extracted.diagnostics).toEqual([]);
    const verified = verifyExtractedAssetsAgainstSpec({
      requiredAssets: [
        { asset_key: "logo", file_name: "logo.png", mime_type: "image/png", purpose: "VISUAL_IMAGE" },
        { asset_key: "mark", file_name: "mark.svg", mime_type: "image/svg+xml", purpose: "VISUAL_IMAGE" },
      ],
      extractedFilesByName: extracted.filesByName,
      maxSingleAssetBytes: 1024 * 1024,
    });
    expect(verified.diagnostics).toEqual([]);
    expect(verified.validAssets.map((asset) => asset.assetKey)).toEqual(["logo", "mark"]);
  });

  test("an unsafe SVG is rejected", async () => {
    const zipBuffer = await zipOf({
      "evil.svg": '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    });
    const extracted = await extractZipAssetFiles({
      zipBuffer,
      maxZipBytes: 5 * 1024 * 1024,
      maxSingleAssetBytes: 1024 * 1024,
    });
    const verified = verifyExtractedAssetsAgainstSpec({
      requiredAssets: [
        { asset_key: "evil", file_name: "evil.svg", mime_type: "image/svg+xml", purpose: "VISUAL_IMAGE" },
      ],
      extractedFilesByName: extracted.filesByName,
      maxSingleAssetBytes: 1024 * 1024,
    });
    expect(verified.validAssets).toEqual([]);
    expect(verified.diagnostics.some((d) => d.code === "UNSAFE_HTML_TAG_FORBIDDEN")).toBe(true);
  });

  test("path traversal and magic-byte mismatches are rejected", async () => {
    const extracted = await extractZipAssetFiles({
      zipBuffer: await zipOf({ "fake.png": Buffer.from("not-a-png") }),
      maxZipBytes: 5 * 1024 * 1024,
      maxSingleAssetBytes: 1024 * 1024,
    });
    const verified = verifyExtractedAssetsAgainstSpec({
      requiredAssets: [
        { asset_key: "fake", file_name: "fake.png", mime_type: "image/png", purpose: "VISUAL_IMAGE" },
        { asset_key: "escape", file_name: "../escape.png", mime_type: "image/png", purpose: "VISUAL_IMAGE" },
      ],
      extractedFilesByName: extracted.filesByName,
      maxSingleAssetBytes: 1024 * 1024,
    });
    expect(verified.diagnostics.some((d) => d.code === "ASSET_PATH_TRAVERSAL_DETECTED")).toBe(true);
    expect(verified.diagnostics.some((d) => d.code === "ASSET_MAGIC_BYTE_MISMATCH")).toBe(true);
  });
});
