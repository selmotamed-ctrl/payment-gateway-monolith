#!/usr/bin/env bun
/**
 * Produce a signed content-only update bundle:
 *   release/content-<hash>.json
 *   release/manifest.json
 *
 * The app verifies manifest.signature over bundleSha256 with the pinned
 * Ed25519 public key, then verifies the downloaded bundle's SHA-256.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signAsync } from "@noble/ed25519";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".keys", "content-signing.env");
const bundlePath = join(root, "public", "content", "bundle.json");
const manifestPath = join(root, "public", "content", "manifest.json");
const releaseDir = join(root, "release");

const loadEnvFile = (): void => {
    if (!existsSync(envFile)) return;
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
        const separator = line.indexOf("=");
        if (separator <= 0) continue;
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (!process.env[key]) process.env[key] = value;
    }
};

const fromHex = (value: string): Uint8Array => {
    const clean = value.trim().replace(/^0x/i, "");
    if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new Error("invalid hex key");
    const bytes = new Uint8Array(clean.length / 2);
    for (let index = 0; index < clean.length; index += 2) {
        bytes[index / 2] = Number.parseInt(clean.slice(index, index + 2), 16);
    }
    return bytes;
};

const toHex = (bytes: Uint8Array): string =>
    Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");

loadEnvFile();

const secret = process.env.COMPANION_CONTENT_SIGNING_KEY?.trim();
const baseUrl = process.env.COMPANION_UPDATE_BASE_URL?.trim();
if (!secret) {
    throw new Error(
        "COMPANION_CONTENT_SIGNING_KEY is missing. Run `bun scripts/generate-content-key.ts` and back up .keys.",
    );
}
if (!baseUrl) {
    throw new Error("COMPANION_UPDATE_BASE_URL is missing (for example https://updates.example.internal/companion)");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    schema: number;
    appId: string;
    contentVersion: string;
    contentHash: string;
    bundleSha256: string;
    bundleBytes: number;
    guideSourceSha256: string;
    academyContentHash: string;
    generatedAt: string;
    counts: Record<string, number>;
    bundlePath: string;
};

mkdirSync(releaseDir, { recursive: true });
const bundleName = `content-${manifest.contentHash.slice(0, 16)}.json`;
copyFileSync(bundlePath, join(releaseDir, bundleName));

const signature = await signAsync(
    new TextEncoder().encode(manifest.bundleSha256),
    fromHex(secret),
);

const updateManifest = {
    ...manifest,
    bundleUrl: `${baseUrl.replace(/\/+$/, "")}/${bundleName}`,
    publishedAt: new Date().toISOString(),
    keyId: "content-v1",
    signature: toHex(signature),
};
writeFileSync(join(releaseDir, "manifest.json"), `${JSON.stringify(updateManifest, null, 2)}\n`);

console.log(`Signed content update: ${join(releaseDir, bundleName)}`);
console.log(`Manifest: ${join(releaseDir, "manifest.json")}`);
console.log(`Publish both files under ${baseUrl.replace(/\/+$/, "")}/`);
