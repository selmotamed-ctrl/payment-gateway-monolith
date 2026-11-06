#!/usr/bin/env bun
/**
 * Create the Ed25519 key used to sign content-only updates.
 * The private key is stored in companion-app/.keys (0600, gitignored);
 * only the public key is printed. BACK UP .keys.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicKeyAsync, utils } from "@noble/ed25519";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keyDir = join(root, ".keys");
const envFile = join(keyDir, "content-signing.env");
const publicFile = join(root, "public", "content", "public-key.txt");

const toHex = (bytes: Uint8Array): string =>
    Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");

if (existsSync(envFile)) {
    console.log(`Content signing key already exists at ${envFile}. Back it up; not overwriting.`);
    process.exit(0);
}

mkdirSync(keyDir, { recursive: true });
chmodSync(keyDir, 0o700);

const secret = utils.randomSecretKey();
const publicKey = await getPublicKeyAsync(secret);
const env = [
    `COMPANION_CONTENT_SIGNING_KEY=${toHex(secret)}`,
    `COMPANION_CONTENT_PUBLIC_KEY=${toHex(publicKey)}`,
    "",
].join("\n");
writeFileSync(envFile, env, { mode: 0o600 });
writeFileSync(publicFile, `${toHex(publicKey)}\n`, { mode: 0o644 });
chmodSync(envFile, 0o600);

console.log(`Created content signing key at ${envFile}`);
console.log(`Pin this public key in the Android build: ${toHex(publicKey)}`);
console.log("BACK UP companion-app/.keys now. Losing it means future content updates cannot be signed.");
