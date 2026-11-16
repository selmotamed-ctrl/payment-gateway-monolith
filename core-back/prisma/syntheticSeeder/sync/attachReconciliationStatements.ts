import type { PrismaClient } from "../../../generated/prisma/client";
import { createObjectStorageSdk } from "../../../lib/objectStorageSdk";

/**
 * The generator creates reconciliation runs and their items synchronously; the
 * statement file itself now belongs in the shared object-storage vault. This
 * enrichment reconstructs a faithful CSV statement from the seeded items and
 * attaches it to each run that has no object yet.
 */
export const attachReconciliationStatements = async (
  prisma: PrismaClient,
  actorId = "synthetic-seeder",
): Promise<{ runs: number }> => {
  const objectStorage = createObjectStorageSdk({ prisma });
  const runs = await prisma.reconciliationRun.findMany({
    where: { storageObjectId: null },
    select: { id: true, fileName: true },
    orderBy: { createdAt: "asc" },
  });

  let attached = 0;
  for (const run of runs) {
    const items = await prisma.reconciliationItem.findMany({
      where: { runId: run.id },
      orderBy: { createdAt: "asc" },
      select: {
        providerReference: true,
        ourReference: true,
        statementAmount: true,
        statementFee: true,
        result: true,
        createdAt: true,
      },
    });
    const lines = ["provider_reference,our_reference,amount,fee,currency,status,settled_at"];
    for (const item of items) {
      lines.push(
        [
          item.providerReference,
          item.ourReference,
          item.statementAmount.toString(),
          item.statementFee.toString(),
          "LYD",
          item.result === "MATCHED" ? "PAID" : "REVIEW",
          item.createdAt.toISOString(),
        ].join(","),
      );
    }
    const bytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    const staged = await objectStorage.workerClient.stageSystemGenerated({
      namespace: "RECON_STATEMENTS",
      data: bytes,
      originalFilename: run.fileName ?? `statement-${run.id}.csv`,
      claimedMimeType: "text/csv",
      ownerMerchantId: null,
      actorId,
      metadata: { synthetic: true, runId: run.id },
    });
    await prisma.$transaction(async (tx) => {
      await tx.reconciliationRun.update({
        where: { id: run.id },
        data: { storageObjectId: staged.objectId },
      });
      await objectStorage.routeClient.bind(tx as never, {
        objectId: staged.objectId,
        holderType: "RECON_RUN",
        holderId: run.id,
        actorId,
        reason: "SYNTHETIC_RECON_STATEMENT",
      });
    });
    attached += 1;
  }
  return { runs: attached };
};
