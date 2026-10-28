/**
 * First-administrator bootstrap.
 *
 * The seed creates the role catalogue with `passwordHash = null` and status
 * `INVITED`; there is deliberately no self-service activation. This CLI (run on
 * the core host, which is the only host with database access) sets a real
 * credential so an operator can sign in for the first time:
 *
 *   bun run create-admin --email admin@example.com --password 'Str0ngPassw0rd!'
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... bun run create-admin
 *
 * It is idempotent: running it again re-provisions the password/status of the
 * same email. Pass --mfa only when SMS delivery is configured (the MFA code is
 * delivered through the notification queue).
 */
import { hashPassword } from "../lib/auth";
import { client } from "../prisma/client";
import {
  buildAdminUserData,
  parseCreateAdminArgs,
  USAGE,
} from "./createAdminPlan";

const main = async (): Promise<void> => {
  const parsed = parseCreateAdminArgs(process.argv.slice(2));
  if (!parsed.ok) {
    if (parsed.error === "help") {
      console.log(USAGE);
      return;
    }
    console.error(`create-admin: ${parsed.error}\n\n${USAGE}`);
    process.exit(1);
  }

  const { args } = parsed;
  const data = buildAdminUserData(args, await hashPassword(args.password));
  const existing = await client.user.findUnique({ where: { email: data.email } });

  if (existing) {
    const updated = await client.user.update({
      where: { email: data.email },
      data: {
        passwordHash: data.passwordHash,
        status: "ACTIVE",
        mfaRequired: data.mfaRequired,
        mfaSecretCiphertext: null,
        ...(args.roleProvided
          ? {
              role: data.role,
              authoritiesMap: data.authoritiesMap,
              isMaker: data.isMaker,
              isChecker: data.isChecker,
            }
          : {}),
      },
    });
    console.log(
      `Updated ${updated.email} (role ${updated.role}, status ${updated.status}, mfa ${updated.mfaRequired ? "required" : "off"}).`,
    );
  } else {
    const created = await client.user.create({ data });
    console.log(
      `Created ${created.email} (role ${created.role}, status ${created.status}, mfa ${created.mfaRequired ? "required" : "off"}).`,
    );
  }

  console.log("Sign in at the admin portal. Rotate this password after the first login.");
};

if (import.meta.main) {
  main()
    .catch((error: unknown) => {
      console.error(`create-admin failed: ${(error as Error).message}`);
      process.exit(1);
    })
    .finally(() => client.$disconnect().catch(() => undefined));
}
