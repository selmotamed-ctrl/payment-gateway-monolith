import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Preferences } from "@capacitor/preferences";
import { sha256 } from "@noble/hashes/sha2.js";
import type { CompanionManifest } from "@/content/types";

const ACTIVE_KEY = "pg.companion.activeContent";
const CONTENT_DIR = "content";

export interface ActiveContentPointer {
    manifest: CompanionManifest;
    path: string;
}

export const sha256Hex = (value: Uint8Array | string): string => {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    return Array.from(sha256(bytes))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
};

export const readActivePointer = async (): Promise<ActiveContentPointer | null> => {
    if (!Capacitor.isNativePlatform()) return null;
    const { value } = await Preferences.get({ key: ACTIVE_KEY });
    if (!value) return null;
    try {
        const pointer = JSON.parse(value) as ActiveContentPointer;
        if (!pointer?.manifest?.contentHash || !pointer.path) return null;
        return pointer;
    } catch {
        await Preferences.remove({ key: ACTIVE_KEY });
        return null;
    }
};

export const readActiveBundleText = async (): Promise<{ text: string; manifest: CompanionManifest } | null> => {
    const pointer = await readActivePointer();
    if (!pointer) return null;
    try {
        const result = await Filesystem.readFile({
            path: pointer.path,
            directory: Directory.Data,
            encoding: Encoding.UTF8,
        });
        if (typeof result.data !== "string") return null;
        const actual = sha256Hex(result.data);
        if (actual !== pointer.manifest.bundleSha256) {
            await clearActiveBundle();
            return null;
        }
        return { text: result.data, manifest: pointer.manifest };
    } catch {
        await clearActiveBundle();
        return null;
    }
};

export const writeActiveBundle = async (
    text: string,
    manifest: CompanionManifest,
): Promise<void> => {
    if (!Capacitor.isNativePlatform()) return;
    const path = `${CONTENT_DIR}/${manifest.contentHash}.json`;
    await Filesystem.mkdir({ path: CONTENT_DIR, directory: Directory.Data, recursive: true });
    await Filesystem.writeFile({
        path,
        directory: Directory.Data,
        data: text,
        encoding: Encoding.UTF8,
        recursive: true,
    });
    await Preferences.set({
        key: ACTIVE_KEY,
        value: JSON.stringify({ manifest, path } satisfies ActiveContentPointer),
    });
};

export const clearActiveBundle = async (): Promise<void> => {
    if (!Capacitor.isNativePlatform()) return;
    const pointer = await readActivePointer();
    await Preferences.remove({ key: ACTIVE_KEY });
    if (pointer?.path) {
        try {
            await Filesystem.deleteFile({ path: pointer.path, directory: Directory.Data });
        } catch {
            // The pointer is already gone; a missing file is harmless.
        }
    }
};
