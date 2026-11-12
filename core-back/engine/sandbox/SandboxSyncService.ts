import { client } from "../../prisma/client";
import type { SessionClaims } from "../../lib/auth";
import { ApiError } from "../../lib/error";
import { isSandboxPlane } from "../../lib/plane";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sandboxRoleFor = (role: string): "GATEWAY_ADMIN" | "SECURITY_ADMIN" | "FINANCE" | "OPERATOR" | "COMPLIANCE"
  | "MLRO" | "SUPPORT" | "MERCHANT_ADMIN" | "MERCHANT_STAFF" | "MERCHANT_CASHIER" => {
  if (role.startsWith("MERCHANT_")) {
    return role === "MERCHANT_STAFF" || role === "MERCHANT_CASHIER" ? role : "MERCHANT_ADMIN";
  }
  const staff = ["GATEWAY_ADMIN", "SECURITY_ADMIN", "FINANCE", "OPERATOR", "COMPLIANCE", "MLRO", "SUPPORT"] as const;
  return (staff as readonly string[]).includes(role) ? (role as (typeof staff)[number]) : "SUPPORT";
};

const authoritiesMapOf = (claims: SessionClaims): Record<string, true> =>
  Object.fromEntries(claims.authorities.map((authority) => [authority, true as const]));

/**
 * Auto-provisions a log-in session's Sandbox Workspace on its first sandbox
 * request. The JWT was signed by the Live core with the same `KMS_MASTER_KEY`,
 * so no query against the Live database is needed: the claims carry the user,
 * merchant, role, authorities and application scopes.
 */
export async function ensureSandboxPrincipalProvisioned(claims: SessionClaims) {
  const existingUser = await client.user.findUnique({ where: { id: claims.sub } });
  if (existingUser) {
    if (!claims.merchantId) return existingUser;
    const wallet = await client.wallet.findFirst({ where: { merchantId: claims.merchantId }, select: { id: true } });
    if (wallet) return existingUser;
  }

  return client.$transaction(async (tx) => {
    if (claims.merchantId) {
      if (!UUID_PATTERN.test(claims.merchantId)) {
        throw new ApiError(403, "SANDBOX_PRINCIPAL_INVALID", "The session merchant id is not a UUID");
      }
      const existingMerchant = await tx.merchant.findUnique({ where: { id: claims.merchantId } });
      if (!existingMerchant) {
        const suffix = claims.merchantId.slice(0, 8);
        await tx.merchant.create({
          data: {
            id: claims.merchantId,
            legalName: `Sandbox Merchant (${suffix})`,
            tradeName: `Sandbox Store (${suffix})`,
            registrationNo: `SBX-REG-${suffix}`,
            taxId: `SBX-TAX-${suffix}`,
            contactEmail: `sandbox+${suffix}@merchant.internal`,
            contactPhone: "0910000000",
            status: "ACTIVE",
            kybStatus: "VERIFIED",
            riskTier: "LOW",
            onboardingChannel: "SANDBOX",
            country: "LY",
          },
        });
      } else if (existingMerchant.status !== "ACTIVE") {
        await tx.merchant.update({ where: { id: claims.merchantId }, data: { status: "ACTIVE" } });
      }

      let wallet = await tx.wallet.findFirst({ where: { merchantId: claims.merchantId } });
      if (!wallet) {
        const glAccount = await tx.glAccount.create({
          data: {
            accountType: "MERCHANT_WALLET",
            ownerId: claims.merchantId,
            env: "SANDBOX",
            currency: "LYD",
            shardCount: 1,
          },
        });
        wallet = await tx.wallet.create({
          data: {
            merchantId: claims.merchantId,
            glAccountId: glAccount.id,
            currency: "LYD",
            status: "ACTIVE",
            env: "SANDBOX",
          },
        });
      } else if (wallet.status !== "ACTIVE") {
        wallet = await tx.wallet.update({ where: { id: wallet.id }, data: { status: "ACTIVE" } });
      }

      const application = await tx.application.findFirst({ where: { merchantId: claims.merchantId } });
      if (!application) {
        await tx.application.create({
          data: {
            merchantId: claims.merchantId,
            name: "Default Sandbox Application",
            businessUseDescription: "Auto-provisioned sandbox application for Fake Rails testing",
            assignedWalletId: wallet.id,
            status: "ACTIVE",
            env: "SANDBOX",
            sandboxInspectorMode: "OPEN_IN_SANDBOX",
          },
        });
      } else if (application.status !== "ACTIVE" || application.env !== "SANDBOX") {
        await tx.application.update({
          where: { id: application.id },
          data: { status: "ACTIVE", env: "SANDBOX" },
        });
      }
    }

    const role = sandboxRoleFor(claims.role);
    const data = {
      email: `sandbox+${claims.sub}@sandbox.internal`,
      role,
      merchantId: claims.merchantId ?? null,
      authoritiesMap: authoritiesMapOf(claims),
      appScopeIds: claims.appScopeIds,
      status: "ACTIVE" as const,
      mfaRequired: false,
      phone: null,
      passwordHash: null,
      isMaker: true,
      isChecker: true,
    };
    return tx.user.upsert({
      where: { id: claims.sub },
      create: { id: claims.sub, ...data },
      update: {
        role,
        merchantId: claims.merchantId ?? null,
        authoritiesMap: authoritiesMapOf(claims),
        appScopeIds: claims.appScopeIds,
        status: "ACTIVE",
      },
    });
  });
}

/**
 * Resets a merchant's Sandbox Workspace: deletes its sandbox attempts, attempt
 * groups and payment links. Ledger rows are immutable and intentionally kept;
 * the sandbox wallet's balance therefore still reflects the removed attempts.
 */
export async function resetMerchantSandboxWorkspace(merchantId: string): Promise<{
  ok: true;
  merchantId: string;
  deletedAttempts: number;
  deletedLinks: number;
}> {
  if (!isSandboxPlane()) {
    throw new ApiError(403, "SANDBOX_RESET_FORBIDDEN_ON_LIVE", "Workspace reset is only permitted on the Sandbox plane");
  }
  try {
    return await client.$transaction(async (tx) => {
      const deletedAttempts = await tx.paymentAttempt.deleteMany({ where: { merchantId, env: "SANDBOX" } });
      const links = await tx.paymentLink.findMany({
        where: { env: "SANDBOX", application: { merchantId } },
        select: { id: true },
      });
      let deletedLinks = 0;
      for (const link of links) {
        await tx.attemptGroup.deleteMany({ where: { linkId: link.id } });
        const deleted = await tx.paymentLink.deleteMany({ where: { id: link.id } });
        deletedLinks += deleted.count;
      }
      return { ok: true as const, merchantId, deletedAttempts: deletedAttempts.count, deletedLinks };
    });
  } catch (error) {
    const code = String((error as { code?: string }).code ?? "");
    if (code === "P2003") {
      throw new ApiError(
        409,
        "SANDBOX_RESET_CONFLICT",
        "The sandbox workspace still has dependent records (for example disputes) that block a reset",
      );
    }
    throw error;
  }
}
