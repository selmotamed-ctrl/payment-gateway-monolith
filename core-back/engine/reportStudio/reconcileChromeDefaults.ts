import { client } from "../../prisma/client";
import {
  classifyStoredChromeSpec,
  REPORT_ENGINE_VERSION,
} from "../../lib/reportEngineSdk";

export interface RevokedChromeDefault {
  subject: "PLATFORM" | "MERCHANT";
  id: string;
  code: string;
  merchantId?: string | null;
  reason: string;
}

export async function reconcileReportChromeDefaults(): Promise<RevokedChromeDefault[]> {
  const revoked: RevokedChromeDefault[] = [];
  await client.$transaction(async (tx) => {
    const platformDefaults = await tx.reportChromeSpecRecord.findMany({
      where: { isDefaultGlobal: true },
    });
    for (const row of platformDefaults) {
      const compatibility = classifyStoredChromeSpec({
        specJson: row.specJson,
        storedEngineVersion: row.engineVersion,
        storedSpecVersion: row.specSchemaVersion,
      });
      if (compatibility.status === "COMPATIBLE") continue;
      await tx.reportChromeSpecRecord.update({
        where: { id: row.id },
        data: {
          isDefaultGlobal: false,
          defaultRevokedAt: new Date(),
          defaultRevokedReason: compatibility.reasonCode ?? compatibility.status,
        },
      });
      revoked.push({
        subject: "PLATFORM",
        id: row.id,
        code: row.code,
        reason: compatibility.reasonCode ?? compatibility.status,
      });
    }
    const merchantDefaults = await tx.merchantReportChromeSpecRecord.findMany({
      where: { isDefaultForMerchant: true },
    });
    for (const row of merchantDefaults) {
      const compatibility = classifyStoredChromeSpec({
        specJson: row.specJson,
        storedEngineVersion: row.engineVersion,
        storedSpecVersion: row.specSchemaVersion,
      });
      if (compatibility.status === "COMPATIBLE") continue;
      await tx.merchantReportChromeSpecRecord.update({
        where: { id: row.id },
        data: {
          isDefaultForMerchant: false,
          defaultRevokedAt: new Date(),
          defaultRevokedReason: compatibility.reasonCode ?? compatibility.status,
        },
      });
      revoked.push({
        subject: "MERCHANT",
        id: row.id,
        code: row.code,
        merchantId: row.merchantId,
        reason: compatibility.reasonCode ?? compatibility.status,
      });
    }
  });
  if (revoked.length > 0) {
    console.warn(
      `Report engine ${REPORT_ENGINE_VERSION}: revoked ${revoked.length} incompatible chrome default(s)`,
    );
  }
  return revoked;
}
