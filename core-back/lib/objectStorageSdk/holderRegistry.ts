import type { PrismaClient } from '../../generated/prisma/client'
import type { StorageHolderType } from './types'

/**
 * Maps every StorageHolderType to a batch existence query used by the daily
 * LockReconciler worker to detect and auto-release dangling locks if a domain
 * row was ever removed outside standard SDK release flows.
 *
 * The exhaustive switch is intentionally not defaulted silently: adding a new
 * StorageHolderType without a registry branch is a compile-time error.
 */
export async function checkHoldersExistInDb(
  prisma: PrismaClient,
  holderType: StorageHolderType,
  holderIds: string[]
): Promise<Set<string>> {
  if (holderIds.length === 0) return new Set()
  // Holder ids are domain UUIDs. A malformed id can never match a row; treat
  // it as missing so the lock reconciler releases it instead of failing the
  // whole batch on a PostgreSQL uuid cast error.
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  holderIds = holderIds.filter((id) => uuidPattern.test(id))
  if (holderIds.length === 0) return new Set()

  switch (holderType) {
    case 'KYB_DOCUMENT': {
      const rows = await prisma.kybDocument.findMany({
        where: { id: { in: holderIds } },
        select: { id: true },
      })
      return new Set(rows.map((r) => r.id))
    }
    case 'RECON_RUN': {
      const rows = await prisma.reconciliationRun.findMany({
        where: { id: { in: holderIds } },
        select: { id: true },
      })
      return new Set(rows.map((r) => r.id))
    }
    case 'REG_REPORT_SCHEMA': {
      const rows = await prisma.regulatoryReportSchema.findMany({
        where: { id: { in: holderIds } },
        select: { id: true },
      })
      return new Set(rows.map((r) => r.id))
    }
    case 'REG_REPORT_OUTPUT': {
      const rows = await prisma.regulatoryReportOutput.findMany({
        where: { id: { in: holderIds } },
        select: { id: true },
      })
      return new Set(rows.map((r) => r.id))
    }
    case 'REPORT_ASSET_ENTRY': {
      const [staffBundles, merchantBundles, entries] = await Promise.all([
        prisma.reportAssetBundle.findMany({
          where: { id: { in: holderIds } },
          select: { id: true },
        }),
        prisma.merchantReportAssetBundle.findMany({
          where: { id: { in: holderIds } },
          select: { id: true },
        }),
        prisma.reportAssetBundleEntry.findMany({
          where: { id: { in: holderIds } },
          select: { id: true },
        }),
      ])
      return new Set([
        ...staffBundles.map((r) => r.id),
        ...merchantBundles.map((r) => r.id),
        ...entries.map((r) => r.id),
      ])
    }
    case 'CATALOG_ASSET': {
      const rows = await prisma.asset.findMany({
        where: { id: { in: holderIds } },
        select: { id: true },
      })
      return new Set(rows.map((r) => r.id))
    }
    case 'RAIL_LOGO': {
      const rows = await prisma.rail.findMany({
        where: { id: { in: holderIds }, logoAssetId: { not: null } },
        select: { id: true },
      })
      return new Set(rows.map((r) => r.id))
    }
    case 'DISPUTE_ATTACHMENT': {
      const rows = await prisma.disputeAttachment.findMany({
        where: { id: { in: holderIds } },
        select: { id: true },
      })
      return new Set(rows.map((r) => r.id))
    }
    case 'AML_CASE_EVIDENCE': {
      const rows = await prisma.amlCaseEvidence.findMany({
        where: { id: { in: holderIds } },
        select: { id: true },
      })
      return new Set(rows.map((r) => r.id))
    }
    default: {
      const unreachable: never = holderType
      throw new Error(`Unhandled StorageHolderType: ${String(unreachable)}`)
    }
  }
}
