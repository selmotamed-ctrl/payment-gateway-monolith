import { promises as nodeFs } from "node:fs";
import { join } from "node:path";
import type { ArtifactRepository } from "./artifactStore";
import { openToBuffer, sealBuffer, signText, verifyTextSignature } from "./cryptoEnvelope";
import { errorMessage, tempSibling } from "./util";

export const CATALOG_KEY = "catalog/catalog.json.enc";
const CATALOG_SEAL = { target: "catalog", id: "catalog.json" } as const;

/** The mirror the CatalogStore talks to; implemented over the storage tiers. */
export interface CatalogMirror {
  upload(catalogJson: string): Promise<void>;
  download(): Promise<string | null>;
}

/**
 * Keeps an encrypted, HMAC-signed copy of catalog.json on every storage tier.
 * If the backup host is destroyed, a replacement daemon pointed at the same
 * tiers recovers its run/drill history and policy from here on first start.
 */
export class RepositoryCatalogMirror implements CatalogMirror {
  constructor(
    private readonly repository: ArtifactRepository,
    private readonly master: Buffer,
    private readonly stagingDir: string,
  ) {}

  public async upload(catalogJson: string): Promise<void> {
    await nodeFs.mkdir(this.stagingDir, { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({ catalog: catalogJson, signature: signText(catalogJson, this.master) });
    const tmp = tempSibling(join(this.stagingDir, "catalog.json.enc"));
    try {
      await sealBuffer(Buffer.from(payload, "utf8"), tmp, { master: this.master, ...CATALOG_SEAL });
      await this.repository.putFile(CATALOG_KEY, tmp);
    } finally {
      await nodeFs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  /** The newest readable, correctly signed catalog from any tier; null when none exists or none verifies. */
  public async download(): Promise<string | null> {
    await nodeFs.mkdir(this.stagingDir, { recursive: true, mode: 0o700 });
    for (const store of this.repository.stores) {
      const tmp = tempSibling(join(this.stagingDir, `catalog-${store.id}.enc`));
      try {
        if (!(await store.exists(CATALOG_KEY))) continue;
        await store.getFile(CATALOG_KEY, tmp);
        const plain = await openToBuffer(tmp, { master: this.master, ...CATALOG_SEAL });
        const envelope = JSON.parse(plain.toString("utf8")) as { catalog?: string; signature?: string };
        if (typeof envelope.catalog === "string" && typeof envelope.signature === "string" && verifyTextSignature(envelope.catalog, envelope.signature, this.master)) {
          return envelope.catalog;
        }
      } catch (error) {
        void errorMessage(error); // try the next tier
      } finally {
        await nodeFs.rm(tmp, { force: true }).catch(() => undefined);
      }
    }
    return null;
  }
}
