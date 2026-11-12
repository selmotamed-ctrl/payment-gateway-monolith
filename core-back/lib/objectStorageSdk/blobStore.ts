import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as https from 'node:https'
import * as http from 'node:http'
import * as path from 'node:path'

/**
 * The bucket tier is part of the public BlobStore contract. It is kept as a
 * local string union (instead of importing the generated Prisma enum) so the
 * standalone `deploy/object-storage-daemon` can share this file without a
 * dependency on `core-back/generated`.
 */
export type StorageBucketTier = 'HOT' | 'COLD' | 'QUARANTINE'

export interface BlobListEntry {
  bucket: StorageBucketTier
  relPath: string
  byteSize: number
  mtimeMs: number
}

export interface BlobHealthReport {
  ok: boolean
  mode: 'FS_LOCAL' | 'REMOTE_MTLS'
  rootDirOrUrl: string
  freeBytes: number
  latencyMs: number
  error?: string
}

export interface BlobStore {
  put(bucket: StorageBucketTier, relPath: string, data: Uint8Array): Promise<{ byteSize: number; sha256Hex: string }>
  readBytes(bucket: StorageBucketTier, relPath: string): Promise<Buffer>
  stat(bucket: StorageBucketTier, relPath: string): Promise<{ exists: boolean; byteSize: number }>
  moveToTrash(bucket: StorageBucketTier, relPath: string, trashDateIso?: string): Promise<void>
  purgeTrashOlderThan(cutoffDateIso: string): Promise<number>
  list(bucket: StorageBucketTier, prefix?: string): Promise<BlobListEntry[]>
  healthCheck(): Promise<BlobHealthReport>
}

const BUCKET_DIRS: Record<StorageBucketTier, string> = {
  HOT: 'hot',
  COLD: 'cold',
  QUARANTINE: 'quarantine',
}

const VALID_BUCKETS = new Set<StorageBucketTier>(['HOT', 'COLD', 'QUARANTINE'])

export function sanitizeRelPath(relPath: string): string {
  const normalized = path.posix.normalize(relPath).replace(/^\/+/, '')
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('..') ||
    normalized.includes('/../') ||
    normalized.includes('\0')
  ) {
    throw new Error(`Unsafe storage relative path rejected: "${relPath}"`)
  }
  return normalized
}

/**
 * 1. FsBlobStore: Direct atomic POSIX storage driver.
 * Used directly by:
 *   - deploy/object-storage-daemon on the dedicated OBJECT_STORAGE_NODE host (/srv/objects)
 *   - core-back in single-host deployments or local dev/test when OBJECT_STORAGE_DAEMON_URL is unset
 */
export class FsBlobStore implements BlobStore {
  public readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir)
    for (const sub of ['hot', 'cold', 'quarantine', 'tmp', '.trash']) {
      fs.mkdirSync(path.join(this.rootDir, sub), { recursive: true })
    }
  }

  private resolveTargetPath(bucket: StorageBucketTier, relPath: string): string {
    const safeRel = sanitizeRelPath(relPath)
    const bucketRoot = path.join(this.rootDir, BUCKET_DIRS[bucket])
    const resolved = path.resolve(bucketRoot, safeRel)
    if (!resolved.startsWith(bucketRoot + path.sep)) {
      throw new Error(`Path traversal outside bucket root rejected: ${relPath}`)
    }
    return resolved
  }

  async put(bucket: StorageBucketTier, relPath: string, data: Uint8Array): Promise<{ byteSize: number; sha256Hex: string }> {
    const targetPath = this.resolveTargetPath(bucket, relPath)
    const tmpPath = path.join(this.rootDir, 'tmp', `${randomUUID()}.part`)
    const sha256Hex = createHash('sha256').update(data).digest('hex')

    await fsp.mkdir(path.dirname(targetPath), { recursive: true })
    const handle = await fsp.open(tmpPath, 'w', 0o640)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }

    await fsp.rename(tmpPath, targetPath)
    return { byteSize: data.byteLength, sha256Hex }
  }

  async readBytes(bucket: StorageBucketTier, relPath: string): Promise<Buffer> {
    const targetPath = this.resolveTargetPath(bucket, relPath)
    return fsp.readFile(targetPath)
  }

  async stat(bucket: StorageBucketTier, relPath: string): Promise<{ exists: boolean; byteSize: number }> {
    const targetPath = this.resolveTargetPath(bucket, relPath)
    try {
      const st = await fsp.stat(targetPath)
      return { exists: st.isFile(), byteSize: st.size }
    } catch {
      return { exists: false, byteSize: 0 }
    }
  }

  async moveToTrash(bucket: StorageBucketTier, relPath: string, trashDateIso?: string): Promise<void> {
    const targetPath = this.resolveTargetPath(bucket, relPath)
    const requested = (trashDateIso ?? new Date().toISOString().slice(0, 10)).replace(/[^0-9-]/g, '')
    const dayFolder = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : new Date().toISOString().slice(0, 10)
    const safeRel = sanitizeRelPath(relPath)
    const trashTarget = path.join(this.rootDir, '.trash', dayFolder, BUCKET_DIRS[bucket], safeRel)
    try {
      await fsp.mkdir(path.dirname(trashTarget), { recursive: true })
      await fsp.rename(targetPath, trashTarget)
    } catch (err: any) {
      if (err?.code === 'ENOENT') return
      throw err
    }
  }

  async purgeTrashOlderThan(cutoffDateIso: string): Promise<number> {
    const trashRoot = path.join(this.rootDir, '.trash')
    let purgedDirs = 0
    let entries: fs.Dirent[] = []
    try {
      entries = await fsp.readdir(trashRoot, { withFileTypes: true })
    } catch {
      return 0
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue
      if (entry.name < cutoffDateIso) {
        await fsp.rm(path.join(trashRoot, entry.name), { recursive: true, force: true })
        purgedDirs++
      }
    }
    return purgedDirs
  }

  async list(bucket: StorageBucketTier, prefix = ''): Promise<BlobListEntry[]> {
    const bucketRoot = path.join(this.rootDir, BUCKET_DIRS[bucket])
    const results: BlobListEntry[] = []
    const cleanPrefix = prefix ? sanitizeRelPath(prefix) : ''

    const walk = async (currentDir: string) => {
      let entries: fs.Dirent[] = []
      try {
        entries = await fsp.readdir(currentDir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name)
        if (entry.isDirectory()) {
          await walk(fullPath)
        } else if (entry.isFile()) {
          const rel = path.relative(bucketRoot, fullPath).split(path.sep).join('/')
          if (!cleanPrefix || rel.startsWith(cleanPrefix)) {
            const st = await fsp.stat(fullPath)
            results.push({
              bucket,
              relPath: rel,
              byteSize: st.size,
              mtimeMs: st.mtimeMs,
            })
          }
        }
      }
    }

    await walk(bucketRoot)
    return results
  }

  async healthCheck(): Promise<BlobHealthReport> {
    const start = performance.now()
    try {
      const probePath = path.join(this.rootDir, 'tmp', `.health-${randomUUID()}`)
      await fsp.writeFile(probePath, 'ok')
      await fsp.unlink(probePath)
      let freeBytes = 10 * 1024 * 1024 * 1024
      if (typeof fsp.statfs === 'function') {
        const st = await fsp.statfs(this.rootDir)
        freeBytes = Number(st.bavail) * Number(st.bsize)
      }
      return {
        ok: true,
        mode: 'FS_LOCAL',
        rootDirOrUrl: this.rootDir,
        freeBytes,
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
      }
    } catch (err: any) {
      return {
        ok: false,
        mode: 'FS_LOCAL',
        rootDirOrUrl: this.rootDir,
        freeBytes: 0,
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
        error: err?.message ?? String(err),
      }
    }
  }
}

/**
 * 2. RemoteMtlsBlobStore: Network-Shared Storage Driver for Multi-Node Clusters.
 * Connects every stateless core-back node (core-1, core-2, ...) and backup-daemon (backup-1)
 * to the dedicated OBJECT_STORAGE_NODE running deploy/object-storage-daemon over mTLS.
 */
export interface RemoteMtlsBlobStoreConfig {
  baseUrl: string // e.g., "https://10.10.14.10:4095" or "http://127.0.0.1:4095" in local tests
  caCertPath?: string | null
  clientCertPath?: string | null
  clientKeyPath?: string | null
  timeoutMs?: number
}

export class RemoteMtlsBlobStore implements BlobStore {
  private readonly baseUrl: URL
  private readonly agent: https.Agent | http.Agent
  private readonly timeoutMs: number

  constructor(config: RemoteMtlsBlobStoreConfig) {
    this.baseUrl = new URL(config.baseUrl.replace(/\/+$/, ''))
    this.timeoutMs = config.timeoutMs ?? 30_000

    if (this.baseUrl.protocol === 'https:') {
      const ca = config.caCertPath && fs.existsSync(config.caCertPath) ? fs.readFileSync(config.caCertPath) : undefined
      const cert =
        config.clientCertPath && fs.existsSync(config.clientCertPath)
          ? fs.readFileSync(config.clientCertPath)
          : undefined
      const key =
        config.clientKeyPath && fs.existsSync(config.clientKeyPath) ? fs.readFileSync(config.clientKeyPath) : undefined
      this.agent = new https.Agent({
        keepAlive: true,
        ca,
        cert,
        key,
        rejectUnauthorized: Boolean(ca),
      })
    } else {
      this.agent = new http.Agent({ keepAlive: true })
    }
  }

  private requestRaw(
    method: string,
    urlPath: string,
    headers: Record<string, string> = {},
    body?: Uint8Array
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const target = new URL(urlPath, this.baseUrl)
      const mod = target.protocol === 'https:' ? https : http
      const req = mod.request(
        target,
        {
          method,
          agent: this.agent,
          headers: {
            ...headers,
            ...(body ? { 'content-length': String(body.byteLength) } : {}),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 500,
              headers: res.headers,
              body: Buffer.concat(chunks),
            })
          })
        }
      )
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy(new Error(`RemoteMtlsBlobStore request timed out after ${this.timeoutMs}ms: ${method} ${urlPath}`))
      })
      if (body) {
        req.write(Buffer.from(body))
      }
      req.end()
    })
  }

  async put(bucket: StorageBucketTier, relPath: string, data: Uint8Array): Promise<{ byteSize: number; sha256Hex: string }> {
    const safeRel = sanitizeRelPath(relPath)
    const sha256Hex = createHash('sha256').update(data).digest('hex')
    const res = await this.requestRaw(
      'PUT',
      `/v1/blobs/${encodeURIComponent(bucket)}/${safeRel}`,
      {
        'content-type': 'application/octet-stream',
        'x-content-sha256': sha256Hex,
      },
      data
    )
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`RemoteMtlsBlobStore PUT failed (${res.statusCode}): ${res.body.toString('utf8')}`)
    }
    return { byteSize: data.byteLength, sha256Hex }
  }

  async readBytes(bucket: StorageBucketTier, relPath: string): Promise<Buffer> {
    const safeRel = sanitizeRelPath(relPath)
    const res = await this.requestRaw('GET', `/v1/blobs/${encodeURIComponent(bucket)}/${safeRel}`)
    if (res.statusCode === 404) {
      const err: any = new Error(`Remote blob not found: ${bucket}/${safeRel}`)
      err.code = 'ENOENT'
      throw err
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`RemoteMtlsBlobStore GET failed (${res.statusCode}): ${res.body.toString('utf8')}`)
    }
    return res.body
  }

  async stat(bucket: StorageBucketTier, relPath: string): Promise<{ exists: boolean; byteSize: number }> {
    const safeRel = sanitizeRelPath(relPath)
    const res = await this.requestRaw('HEAD', `/v1/blobs/${encodeURIComponent(bucket)}/${safeRel}`)
    if (res.statusCode === 404) {
      return { exists: false, byteSize: 0 }
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`RemoteMtlsBlobStore HEAD failed (${res.statusCode})`)
    }
    return {
      exists: true,
      byteSize: Number(res.headers['x-blob-byte-size'] ?? res.headers['content-length'] ?? 0),
    }
  }

  async moveToTrash(bucket: StorageBucketTier, relPath: string, trashDateIso?: string): Promise<void> {
    const safeRel = sanitizeRelPath(relPath)
    const payload = Buffer.from(JSON.stringify({ trashDateIso }), 'utf8')
    const res = await this.requestRaw(
      'POST',
      `/v1/trash/${encodeURIComponent(bucket)}/${safeRel}`,
      { 'content-type': 'application/json' },
      payload
    )
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`RemoteMtlsBlobStore moveToTrash failed (${res.statusCode}): ${res.body.toString('utf8')}`)
    }
  }

  async purgeTrashOlderThan(cutoffDateIso: string): Promise<number> {
    const payload = Buffer.from(JSON.stringify({ cutoffDateIso }), 'utf8')
    const res = await this.requestRaw('POST', `/v1/purge-trash`, { 'content-type': 'application/json' }, payload)
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`RemoteMtlsBlobStore purgeTrashOlderThan failed (${res.statusCode}): ${res.body.toString('utf8')}`)
    }
    const parsed = JSON.parse(res.body.toString('utf8')) as { purgedCount: number }
    return parsed.purgedCount ?? 0
  }

  async list(bucket: StorageBucketTier, prefix = ''): Promise<BlobListEntry[]> {
    const qs = prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''
    const res = await this.requestRaw('GET', `/v1/list/${encodeURIComponent(bucket)}${qs}`)
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`RemoteMtlsBlobStore list failed (${res.statusCode}): ${res.body.toString('utf8')}`)
    }
    const parsed = JSON.parse(res.body.toString('utf8')) as { items: BlobListEntry[] }
    return parsed.items ?? []
  }

  async healthCheck(): Promise<BlobHealthReport> {
    const start = performance.now()
    try {
      const res = await this.requestRaw('GET', '/v1/health')
      if (res.statusCode !== 200) {
        return {
          ok: false,
          mode: 'REMOTE_MTLS',
          rootDirOrUrl: this.baseUrl.toString(),
          freeBytes: 0,
          latencyMs: Math.round((performance.now() - start) * 100) / 100,
          error: `HTTP ${res.statusCode}`,
        }
      }
      const data = JSON.parse(res.body.toString('utf8')) as { ok: boolean; freeBytes: number }
      return {
        ok: Boolean(data.ok),
        mode: 'REMOTE_MTLS',
        rootDirOrUrl: this.baseUrl.toString(),
        freeBytes: Number(data.freeBytes ?? 0),
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
      }
    } catch (err: any) {
      return {
        ok: false,
        mode: 'REMOTE_MTLS',
        rootDirOrUrl: this.baseUrl.toString(),
        freeBytes: 0,
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
        error: err?.message ?? String(err),
      }
    }
  }
}

export interface BlobStoreEnvConfig {
  daemonUrl?: string | null
  caCertPath?: string | null
  clientCertPath?: string | null
  clientKeyPath?: string | null
  timeoutMs?: number
  rootDir?: string | null
  nodeEnv?: string | null
  coreNodeCount?: number
}

export function createBlobStore(config: BlobStoreEnvConfig): BlobStore {
  const daemonUrl = config.daemonUrl?.trim()
  if (daemonUrl) {
    return new RemoteMtlsBlobStore({
      baseUrl: daemonUrl,
      caCertPath: config.caCertPath ?? null,
      clientCertPath: config.clientCertPath ?? null,
      clientKeyPath: config.clientKeyPath ?? null,
      timeoutMs: config.timeoutMs,
    })
  }

  // HARD GUARD: Never allow a production or multi-node core-back instance to silently write to its own local disk!
  const coreNodeCount = config.coreNodeCount ?? 1
  if (config.nodeEnv === 'production' || coreNodeCount > 1) {
    throw new Error(
      'OBJECT_STORAGE_DAEMON_URL_REQUIRED: Shared storage is mandatory. Refusing to store blobs on a core node local disk in production or multi-node mode. Please configure OBJECT_STORAGE_NODE in deploy/deploy.env so all services read and write to the shared storage server.'
    )
  }

  // Allowed ONLY for single-process local development / unit tests
  return new FsBlobStore(config.rootDir?.trim() || '/tmp/pg-object-storage-dev')
}

export function createBlobStoreFromEnv(): BlobStore {
  return createBlobStore({
    daemonUrl: process.env.OBJECT_STORAGE_DAEMON_URL,
    caCertPath: process.env.OBJECT_STORAGE_TLS_CA_PATH,
    clientCertPath: process.env.OBJECT_STORAGE_TLS_CLIENT_CERT_PATH,
    clientKeyPath: process.env.OBJECT_STORAGE_TLS_CLIENT_KEY_PATH,
    timeoutMs: process.env.OBJECT_STORAGE_DAEMON_TIMEOUT_MS ? Number(process.env.OBJECT_STORAGE_DAEMON_TIMEOUT_MS) : undefined,
    rootDir: process.env.OBJECT_STORAGE_ROOT_DIR,
    nodeEnv: process.env.NODE_ENV,
    coreNodeCount: Number(process.env.CLUSTER_CORE_NODE_COUNT ?? '1'),
  })
}

export { VALID_BUCKETS }
