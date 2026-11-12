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

export function loadDaemonConfigFromEnv(overrides?: Partial<ObjectStorageDaemonConfig>): ObjectStorageDaemonConfig {
  const tlsCaCertPath = process.env.OBJECT_STORAGE_DAEMON_TLS_CA_PATH?.trim() || null
  const tlsServerCertPath = process.env.OBJECT_STORAGE_DAEMON_TLS_CERT_PATH?.trim() || null
  const tlsServerKeyPath = process.env.OBJECT_STORAGE_DAEMON_TLS_KEY_PATH?.trim() || null
  const allowedClientCns = (process.env.OBJECT_STORAGE_ALLOWED_CLIENT_CNS ?? 'object-storage-client,backup-daemon,backup-client')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  return {
    bindHost: process.env.OBJECT_STORAGE_DAEMON_BIND_HOST ?? '0.0.0.0',
    port: Number(process.env.OBJECT_STORAGE_DAEMON_PORT ?? '4095'),
    rootDir: process.env.OBJECT_STORAGE_ROOT_DIR ?? '/srv/objects',
    tlsCaCertPath,
    tlsServerCertPath,
    tlsServerKeyPath,
    allowedClientCns,
    // mTLS is mandatory unless every TLS setting is absent (explicit local
    // development only; the deploy engine always supplies the three files).
    requireMtls: Boolean(tlsCaCertPath && tlsServerCertPath && tlsServerKeyPath),
    ...overrides,
  }
}
