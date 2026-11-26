import "dotenv/config";
import { client } from "../prisma/client";
import { bootstrapCommunicationSettingsFromEnv } from "../lib/communication/bootstrap";
import { communicationStatus } from "../lib/communication/settings";

/**
 * Operator command: copy the communication environment into Platform Settings when no administrator has configured
 * the key, then print a secret-free readiness summary.
 */
const run = async (): Promise<void> => {
  const result = await bootstrapCommunicationSettingsFromEnv(client as never);
  const status = await communicationStatus(client as never, { force: true });
  process.stdout.write(
    `${JSON.stringify(
      {
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        status: {
          emailConfigured: status.email.configured,
          smsConfigured: status.sms.configured,
          googleConfigured: status.google.configured,
          maintenance: status.maintenance?.code ?? null,
        },
      },
      null,
      2,
    )}\n`,
  );
  await client.$disconnect();
};

await run();
