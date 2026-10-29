/**
 * Development-only superusers.
 *
 * Creates (or re-provisions) an admin maker, an admin checker and a merchant
 * admin with every authority, MFA disabled and an ACTIVE status. The command is
 * idempotent and refuses to run in production unless the caller explicitly
 * opts in with --allow-production / DEV_USERS_ALLOW_PRODUCTION=true.
 *
 *   DEV_PASSWORD='DevPassword123!' bun run create-dev-users
 *
 * On a test server that runs NODE_ENV=production:
 *
 *   DEV_USERS_ALLOW_PRODUCTION=true DEV_PASSWORD='DevPassword123!' bun run create-dev-users
 */
import "dotenv/config";
import {
  buildDevAdminUser,
  buildDevMerchantUser,
  devUsersGuardError,
  DEV_APPLICATION_NAME,
  parseDevUsersArgs,
  USAGE,
  type DevAdminUserData,
  type DevMerchantUserData,
} from "./devUsersPlan";

let disconnect: (() => Promise<void>) | undefined;

const main = async (): Promise<void> => {
  const parsed = parseDevUsersArgs(process.argv.slice(2));
  if (!parsed.ok) {
    if (parsed.error === "help") {
      console.log(USAGE);
      return;
    }
    console.error(`create-dev-users: ${parsed.error}\n\n${USAGE}`);
    process.exit(1);
  }

  const { args } = parsed;
  const guardError = devUsersGuardError(process.env.NODE_ENV, args.allowProduction);
  if (guardError) {
    console.error(`create-dev-users: ${guardError}`);
    process.exit(1);
  }

  const [{ Prisma }, { client }, { hashPassword }] = await Promise.all([
    import("../generated/prisma/client"),
    import("../prisma/client"),
    import("../lib/auth"),
  ]);
  disconnect = () => client.$disconnect();
  const passwordHash = await hashPassword(args.password);
  const admin = buildDevAdminUser(args.adminEmail, "COMPLIANCE", passwordHash);
  const checker = buildDevAdminUser(args.checkerEmail, "MLRO", passwordHash);
  const merchantUser = buildDevMerchantUser(args.merchantEmail, passwordHash);

  const result = await client.$transaction(async (tx) => {
    const upsertUser = async (
      data: DevAdminUserData | DevMerchantUserData,
      merchantId: string | null,
      appScopeIds: string[],
    ) => {
      const payload = {
        passwordHash: data.passwordHash,
        role: data.role as never,
        authoritiesMap: data.authoritiesMap,
        isMaker: data.isMaker,
        isChecker: data.isChecker,
        mfaRequired: false,
        mfaSecretCiphertext: null,
        status: "ACTIVE" as const,
        merchantId,
        appScopeIds,
      };
      const existing = await tx.user.findUnique({ where: { email: data.email } });
      if (existing) {
        return tx.user.update({ where: { email: data.email }, data: payload });
      }
      return tx.user.create({ data: { email: data.email, ...payload } });
    };

    const adminRow = await upsertUser(admin, null, []);
    const checkerRow = await upsertUser(checker, null, []);

    let merchant = await tx.merchant.findFirst({
      where: { contactEmail: args.merchantEmail },
      orderBy: { createdAt: "asc" },
    });
    const merchantPayload = {
      legalName: args.merchantName,
      tradeName: args.merchantName,
      status: "ACTIVE" as const,
      kybStatus: "VERIFIED" as const,
      riskTier: "LOW" as const,
      onboardingChannel: "DEVELOPMENT",
      country: "LY",
      contactEmail: args.merchantEmail,
      contactPhone: "+218910000000",
      activatedAt: new Date(),
      negativeBalanceCeiling: new Prisma.Decimal(0),
    };
    if (merchant) {
      merchant = await tx.merchant.update({ where: { id: merchant.id }, data: merchantPayload });
    } else {
      merchant = await tx.merchant.create({ data: merchantPayload });
    }

    let glAccount = await tx.glAccount.findFirst({
      where: { accountType: "MERCHANT_WALLET", ownerId: merchant.id, currency: "LYD" },
      orderBy: { createdAt: "asc" },
    });
    if (!glAccount) {
      glAccount = await tx.glAccount.create({
        data: {
          accountType: "MERCHANT_WALLET",
          ownerId: merchant.id,
          currency: "LYD",
          checkpointBalance: new Prisma.Decimal(0),
        },
      });
    }

    let wallet = await tx.wallet.findFirst({
      where: { merchantId: merchant.id, currency: "LYD" },
      orderBy: { createdAt: "asc" },
    });
    if (wallet) {
      wallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: { glAccountId: glAccount.id, status: "ACTIVE" },
      });
    } else {
      wallet = await tx.wallet.create({
        data: {
          merchantId: merchant.id,
          glAccountId: glAccount.id,
          currency: "LYD",
          status: "ACTIVE",
        },
      });
    }

    let application = await tx.application.findFirst({
      where: { merchantId: merchant.id, name: DEV_APPLICATION_NAME },
      orderBy: { createdAt: "asc" },
    });
    if (application) {
      application = await tx.application.update({
        where: { id: application.id },
        data: { assignedWalletId: wallet.id, status: "ACTIVE" },
      });
    } else {
      application = await tx.application.create({
        data: {
          merchantId: merchant.id,
          name: DEV_APPLICATION_NAME,
          expectedMonthlyVolume: new Prisma.Decimal(0),
          assignedWalletId: wallet.id,
          status: "ACTIVE",
        },
      });
    }

    const merchantRow = await upsertUser(merchantUser, merchant.id, [application.id]);

    return { adminRow, checkerRow, merchantRow, merchant, wallet, application };
  });

  console.log(`Dev admin maker:   ${result.adminRow.email} (COMPLIANCE, all authorities, MFA off)`);
  console.log(`Dev admin checker: ${result.checkerRow.email} (MLRO, all authorities, MFA off)`);
  console.log(`Dev merchant user: ${result.merchantRow.email} (MERCHANT_ADMIN, merchant ${result.merchant.id})`);
  console.log(`Dev merchant:      ${result.merchant.tradeName} (wallet ${result.wallet.id}, application ${result.application.id})`);
  if (process.env.NODE_ENV === "production") {
    console.log("WARNING: production opt-in was used. Remove these accounts before a real production launch.");
  }
  console.log("Sign in to the admin and merchant portals with the emails above and the supplied password.");
};

if (import.meta.main) {
  main()
    .catch((error: unknown) => {
      console.error(`create-dev-users failed: ${(error as Error).message}`);
      process.exit(1);
    })
    .finally(() => disconnect?.().catch(() => undefined));
}
