export interface ObjectStorageDaemonConfig {
  bindHost: string
  port: number
  rootDir: string
  tlsCaCertPath: string | null
  tlsServerCertPath: string | null
  tlsServerKeyPath: string | null
  allowedClientCns: string[]
  requireMtls: boolean
}

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function loadDaemonConfigFromEnv(overrides?: Partial<ObjectStorageDaemonConfig>): ObjectStorageDaemonConfig {
  // Overrides are part of the configuration contract (the tests and embedders use them), so validate the effective
  // values, not only the process environment.
  const tlsCaCertPath = overrides?.tlsCaCertPath ?? (process.env.OBJECT_STORAGE_DAEMON_TLS_CA_PATH?.trim() || null)
  const tlsServerCertPath = overrides?.tlsServerCertPath ?? (process.env.OBJECT_STORAGE_DAEMON_TLS_CERT_PATH?.trim() || null)
  const tlsServerKeyPath = overrides?.tlsServerKeyPath ?? (process.env.OBJECT_STORAGE_DAEMON_TLS_KEY_PATH?.trim() || null)
  const allowedClientCns = overrides?.allowedClientCns
    ?? (process.env.OBJECT_STORAGE_ALLOWED_CLIENT_CNS ?? 'object-storage-client,backup-daemon,backup-client')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  const configuredPaths = [tlsCaCertPath, tlsServerCertPath, tlsServerKeyPath]
  const anyTls = configuredPaths.some(Boolean)
  const allTls = configuredPaths.every(Boolean)
  const explicitRequire = process.env.OBJECT_STORAGE_REQUIRE_MTLS
  const requireMtls = overrides?.requireMtls
    ?? (explicitRequire !== undefined ? bool(explicitRequire, true) : process.env.NODE_ENV === 'production')

  if (anyTls && !allTls) {
    throw new Error(
      'OBJECT_STORAGE_DAEMON_TLS_INCOMPLETE: set all of OBJECT_STORAGE_DAEMON_TLS_CA_PATH, OBJECT_STORAGE_DAEMON_TLS_CERT_PATH and OBJECT_STORAGE_DAEMON_TLS_KEY_PATH, or none with OBJECT_STORAGE_REQUIRE_MTLS=false for local development',
    )
  }
  if (requireMtls && !allTls && overrides?.requireMtls !== false) {
    throw new Error(
      'OBJECT_STORAGE_DAEMON_MTLS_REQUIRED: the shared vault must run with mTLS; supply the CA, server certificate and server key',
    )
  }

  return {
    bindHost: process.env.OBJECT_STORAGE_DAEMON_BIND_HOST ?? '0.0.0.0',
    port: Number(process.env.OBJECT_STORAGE_DAEMON_PORT ?? '4095'),
    rootDir: process.env.OBJECT_STORAGE_ROOT_DIR ?? '/srv/objects',
    tlsCaCertPath,
    tlsServerCertPath,
    tlsServerKeyPath,
    allowedClientCns,
    requireMtls: Boolean(allTls && requireMtls),
    ...overrides,
  }
}
