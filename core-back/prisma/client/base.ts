import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../../generated/prisma/client";
import { env } from "../../lib/env";

console.log("Database config: ", {
    host: env.DATABASE_HOST,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database: env.DATABASE_NAME,
});
const adapter = new PrismaMariaDb({
    host: env.DATABASE_HOST,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database: env.DATABASE_NAME,
    connectionLimit: 10,
    allowPublicKeyRetrieval: true,     
    ssl: false, // Set to true if you are using SSL certificates in prod
});

const client = new PrismaClient({
    adapter: adapter,
});

export const baseClient = client;