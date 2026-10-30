import "dotenv/config";

const main = async (): Promise<void> => {
  if ((process.env.FAKE_RAILS_ENABLED ?? "false").toLowerCase() !== "true") {
    console.log("seed-fake-rails: FAKE_RAILS_ENABLED is not true; nothing to do.");
    return;
  }
  if (process.env.NODE_ENV === "production" && (process.env.FAKE_RAILS_ALLOW_PRODUCTION ?? "false").toLowerCase() !== "true") {
    throw new Error("refusing to seed fake rails in production; set FAKE_RAILS_ALLOW_PRODUCTION=true to opt in");
  }
  const apiKey = process.env.FAKE_RAILS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("FAKE_RAILS_API_KEY is required when FAKE_RAILS_ENABLED=true");
  }
  const [{ client }, { seedFakeRails }] = await Promise.all([
    import("../prisma/client"),
    import("../prisma/seedFakeRails"),
  ]);
  try {
    const result = await seedFakeRails(client, {
      baseUrl: process.env.FAKE_RAILS_BASE_URL ?? "http://127.0.0.1:4300",
      apiKey,
      hmacSecret: process.env.FAKE_RAILS_HMAC_SECRET,
      publicBaseUrl: process.env.FAKE_RAILS_PUBLIC_BASE_URL,
      namespace: process.env.FAKE_RAILS_NAMESPACE ?? "demo",
    });
    console.log(`Seeded ${result.rails} demo rails on gateway ${result.gatewayId} (version ${result.gatewayVersionId}).`);
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`seed-fake-rails failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
