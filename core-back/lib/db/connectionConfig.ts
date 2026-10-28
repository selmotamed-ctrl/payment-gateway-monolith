/**
 * Turns `DATABASE_URL` into the config the MariaDB driver expects.
 *
 * MySQL 8 defaults new accounts to `caching_sha2_password`. Over a non-TLS
 * connection the first (uncached) login must fetch the server's RSA public key,
 * and the driver refuses that unless `allowPublicKeyRetrieval` is enabled. The
 * flag is not a Prisma connection-string parameter, so it is set on the pool
 * config here; migrations keep using the Prisma CLI, which handles it natively.
 */
export interface MariaDbPoolConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  allowPublicKeyRetrieval: boolean;
  connectionLimit?: number;
  acquireTimeout?: number;
}

export const isMysqlUrl = (databaseUrl: string): boolean => {
  try {
    const { protocol } = new URL(databaseUrl);
    return protocol === "mysql:" || protocol === "mariadb:";
  } catch {
    return false;
  }
};

export const buildMariaDbPoolConfig = (databaseUrl: string): MariaDbPoolConfig => {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) {
    throw new Error("DATABASE_URL is missing a database name");
  }
  const limit = url.searchParams.get("connectionLimit") ?? url.searchParams.get("connection_limit");
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    allowPublicKeyRetrieval: true,
    ...(limit ? { connectionLimit: Number(limit) } : {}),
  };
};
