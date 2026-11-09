import { Preferences } from "@capacitor/preferences";
import { verifyAsync } from "@noble/ed25519";
import { reactive } from "vue";
import { ensureContent, setBundleForTests, validateBundle } from "@/content/store";
import type { CompanionBundle, CompanionManifest } from "@/content/types";
import { sha256Hex, writeActiveBundle, clearActiveBundle } from "./offlineBundle";

const LAST_CHECK_KEY = "pg.companion.lastUpdateCheck";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateManifest extends CompanionManifest {
    bundleUrl: string;
    signature: string;
    publishedAt?: string;
    minAppVersion?: string;
}

export interface UpdateState {
    configured: boolean;
    checking: boolean;
    available: UpdateManifest | null;
    applied: boolean;
    error: string;
    checkedAt: string;
}

const baseUrl = (): string => String(import.meta.env.VITE_COMPANION_UPDATE_URL ?? "").trim();
const publicKey = (): string => String(import.meta.env.VITE_COMPANION_CONTENT_PUBLIC_KEY ?? "").trim();

export const updateState = reactive<UpdateState>({
    configured: Boolean(baseUrl() && publicKey()),
    checking: false,
    available: null,
    applied: false,
    error: "",
    checkedAt: "",
});

const fromHex = (value: string): Uint8Array => {
    const clean = value.trim().replace(/^0x/i, "");
    if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new Error("invalid hex key or signature");
    const bytes = new Uint8Array(clean.length / 2);
    for (let index = 0; index < clean.length; index += 2) {
        bytes[index / 2] = Number.parseInt(clean.slice(index, index + 2), 16);
    }
    return bytes;
};

const manifestUrl = (): string => {
    const base = baseUrl();
    if (!base) throw new Error("content updates are not configured for this build");
    return base.endsWith(".json") ? base : `${base.replace(/\/+$/, "")}/manifest.json`;
};

const verifySignature = async (manifest: UpdateManifest): Promise<void> => {
    const key = publicKey();
    if (!key) throw new Error("content updates are not configured for this build");
    if (!manifest.signature) throw new Error("the update manifest is not signed");
    const ok = await verifyAsync(
        fromHex(manifest.signature),
        new TextEncoder().encode(manifest.bundleSha256),
        fromHex(key),
    );
    if (!ok) throw new Error("the update manifest signature is invalid");
};

const resolveBundleUrl = (manifest: UpdateManifest): string =>
    new URL(manifest.bundleUrl, manifestUrl()).toString();

/**
 * Rollback protection on AUTHENTICATED data. The manifest dates are not signed (the signature covers
 * only the bundle checksum), so an attacker could replay an old genuine bundle with its old signature
 * under a manifest whose `publishedAt` was edited. The bundle's own `meta.generatedAt` is inside the
 * checksummed bytes and cannot be forged, so it is the value compared with the installed content.
 */
export const assertBundleNotOlderThanInstalled = (installedGeneratedAt: string, bundleGeneratedAt: string): void => {
    const installed = Date.parse(installedGeneratedAt);
    const next = Date.parse(bundleGeneratedAt);
    if (!Number.isFinite(next)) throw new Error("the downloaded content has no valid generation date");
    if (Number.isFinite(installed) && next < installed) {
        throw new Error("the downloaded content is older than the installed content");
    }
};

export const checkForUpdate = async (download = true): Promise<UpdateManifest | null> => {
    updateState.checking = true;
    updateState.error = "";
    try {
        if (!updateState.configured) throw new Error("content updates are not configured for this build");
        const response = await fetch(manifestUrl(), { cache: "no-store" });
        if (!response.ok) throw new Error(`update manifest returned ${response.status}`);
        const manifest = (await response.json()) as UpdateManifest;
        if (manifest.schema !== 1 || manifest.appId !== "ly.paymentgateway.companion") {
            throw new Error("the update manifest is for a different app");
        }
        if (!manifest.contentHash || !manifest.bundleSha256 || !manifest.bundleUrl) {
            throw new Error("the update manifest is incomplete");
        }
        await verifySignature(manifest);
        const current = await ensureContent();
        if (manifest.contentHash === current.meta.contentHash) {
            updateState.available = null;
            updateState.checkedAt = new Date().toISOString();
            await Preferences.set({ key: LAST_CHECK_KEY, value: updateState.checkedAt });
            return null;
        }
        const currentPublished = Date.parse(current.meta.generatedAt);
        const nextPublished = Date.parse(manifest.publishedAt ?? manifest.generatedAt);
        if (Number.isFinite(currentPublished) && Number.isFinite(nextPublished) && nextPublished < currentPublished) {
            throw new Error("the update is older than the installed content");
        }
        updateState.available = manifest;
        updateState.checkedAt = new Date().toISOString();
        if (download) await installUpdate(manifest);
        return manifest;
    } catch (error) {
        updateState.error = error instanceof Error ? error.message : String(error);
        throw error;
    } finally {
        updateState.checking = false;
        await Preferences.set({ key: LAST_CHECK_KEY, value: updateState.checkedAt || new Date().toISOString() });
    }
};

export const installUpdate = async (manifest = updateState.available): Promise<CompanionBundle> => {
    if (!manifest) throw new Error("no update is available");
    updateState.error = "";
    try {
        const response = await fetch(resolveBundleUrl(manifest), { cache: "no-store" });
        if (!response.ok) throw new Error(`content download returned ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const text = new TextDecoder().decode(bytes);
        if (sha256Hex(bytes) !== manifest.bundleSha256) {
            throw new Error("downloaded content does not match its signed checksum");
        }
        const bundle = validateBundle(JSON.parse(text));
        if (bundle.meta.contentHash !== manifest.contentHash) {
            throw new Error("downloaded content does not match the signed manifest");
        }
        assertBundleNotOlderThanInstalled((await ensureContent()).meta.generatedAt, bundle.meta.generatedAt);
        await writeActiveBundle(text, manifest);
        setBundleForTests(bundle);
        updateState.available = manifest;
        updateState.applied = true;
        return bundle;
    } catch (error) {
        updateState.error = error instanceof Error ? error.message : String(error);
        throw error;
    }
};

export const maybeAutoCheck = async (): Promise<void> => {
    if (!updateState.configured) return;
    try {
        const { value } = await Preferences.get({ key: LAST_CHECK_KEY });
        if (value && Date.now() - Date.parse(value) < CHECK_INTERVAL_MS) return;
        await checkForUpdate(true);
    } catch {
        // Offline or a broken update source must never block reading.
    }
};

export const resetContentUpdate = async (): Promise<void> => {
    await clearActiveBundle();
    updateState.applied = false;
    updateState.available = null;
    window.location.reload();
};

export const applyAndReload = (): void => {
    window.location.reload();
};
