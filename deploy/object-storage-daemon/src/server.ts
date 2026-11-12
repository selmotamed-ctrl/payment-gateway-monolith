import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import type { TLSSocket } from 'node:tls'
import { FsBlobStore, type StorageBucketTier } from './shared/blobStore'
import { loadDaemonConfigFromEnv, type ObjectStorageDaemonConfig } from './config'

const VALID_BUCKETS = new Set<StorageBucketTier>(['HOT', 'COLD', 'QUARANTINE'])
const DEFAULT_MAX_BODY_BYTES = 1200 * 1024 * 1024 // the BACKUP_ARTIFACTS namespace allows 1 GiB

function parseBucket(raw: string): StorageBucketTier {
  const upper = raw.toUpperCase() as StorageBucketTier
  if (!VALID_BUCKETS.has(upper)) {
    throw new Error(`Invalid storage bucket tier: ${raw}`)
  }
  return upper
}

function decodeRelPath(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.byteLength
      if (total > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes`))
        req.destroy()
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
  })
  res.end(body)
}

export interface RunningObjectStorageDaemon {
  server: http.Server | https.Server
  port: number
  baseUrl: string
  store: FsBlobStore
  close: () => Promise<void>
}

export async function startObjectStorageDaemon(
  customConfig?: Partial<ObjectStorageDaemonConfig> & { maxBodyBytes?: number }
): Promise<RunningObjectStorageDaemon> {
  const config = loadDaemonConfigFromEnv(customConfig)
  const store = new FsBlobStore(config.rootDir)
  const maxBodyBytes = customConfig?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      if (config.requireMtls) {
        const tlsSocket = req.socket as TLSSocket
        if (!tlsSocket.authorized) {
          return sendJson(res, 401, { error: 'MTLS_CLIENT_UNAUTHORIZED' })
        }
        const peer = tlsSocket.getPeerCertificate()
        const rawCn = peer?.subject?.CN
        const cn = Array.isArray(rawCn) ? rawCn[0] : rawCn
        if (!cn || !config.allowedClientCns.includes(cn)) {
          return sendJson(res, 403, { error: `MTLS_CLIENT_CN_FORBIDDEN:${cn ?? 'none'}` })
        }
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const method = req.method ?? 'GET'

      // 1. GET /v1/health
      if (method === 'GET' && url.pathname === '/v1/health') {
        const health = await store.healthCheck()
        return sendJson(res, health.ok ? 200 : 503, health)
      }

      // 2. PUT / GET / HEAD /v1/blobs/:bucket/*relPath
      if (url.pathname.startsWith('/v1/blobs/')) {
        const rest = url.pathname.slice('/v1/blobs/'.length)
        const slashIdx = rest.indexOf('/')
        if (slashIdx <= 0) {
          return sendJson(res, 400, { error: 'MISSING_BUCKET_OR_PATH' })
        }
        const bucket = parseBucket(decodeURIComponent(rest.slice(0, slashIdx)))
        const relPath = decodeRelPath(rest.slice(slashIdx + 1))

        if (method === 'PUT') {
          const body = await readRequestBody(req, maxBodyBytes)
          const expectedSha = req.headers['x-content-sha256']
          if (typeof expectedSha === 'string' && expectedSha.length === 64) {
            const actualSha = createHash('sha256').update(body).digest('hex')
            if (actualSha !== expectedSha) {
              return sendJson(res, 400, { error: 'SHA256_MISMATCH_ON_PUT', expectedSha, actualSha })
            }
          }
          const result = await store.put(bucket, relPath, body)
          return sendJson(res, 201, result)
        }

        if (method === 'HEAD') {
          const st = await store.stat(bucket, relPath)
          if (!st.exists) {
            res.writeHead(404)
            return res.end()
          }
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(st.byteSize),
            'x-blob-byte-size': String(st.byteSize),
          })
          return res.end()
        }

        if (method === 'GET') {
          try {
            const bytes = await store.readBytes(bucket, relPath)
            res.writeHead(200, {
              'content-type': 'application/octet-stream',
              'content-length': String(bytes.byteLength),
            })
            return res.end(bytes)
          } catch (err: any) {
            if (err?.code === 'ENOENT') {
              return sendJson(res, 404, { error: 'BLOB_NOT_FOUND' })
            }
            throw err
          }
        }

        return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', path: url.pathname })
      }

      // 3. POST /v1/trash/:bucket/*relPath
      if (method === 'POST' && url.pathname.startsWith('/v1/trash/')) {
        const rest = url.pathname.slice('/v1/trash/'.length)
        const slashIdx = rest.indexOf('/')
        if (slashIdx <= 0) {
          return sendJson(res, 400, { error: 'MISSING_BUCKET_OR_PATH' })
        }
        const bucket = parseBucket(decodeURIComponent(rest.slice(0, slashIdx)))
        const relPath = decodeRelPath(rest.slice(slashIdx + 1))
        const rawBody = await readRequestBody(req, 4096)
        const parsed = rawBody.byteLength > 0 ? (JSON.parse(rawBody.toString('utf8')) as { trashDateIso?: string }) : {}
        await store.moveToTrash(bucket, relPath, parsed.trashDateIso)
        return sendJson(res, 200, { ok: true })
      }

      // 4. POST /v1/purge-trash
      if (method === 'POST' && url.pathname === '/v1/purge-trash') {
        const rawBody = await readRequestBody(req, 4096)
        const parsed = JSON.parse(rawBody.toString('utf8')) as { cutoffDateIso: string }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(parsed.cutoffDateIso ?? ''))) {
          return sendJson(res, 400, { error: 'INVALID_CUTOFF_DATE' })
        }
        const purgedCount = await store.purgeTrashOlderThan(parsed.cutoffDateIso)
        return sendJson(res, 200, { ok: true, purgedCount })
      }

      // 5. GET /v1/list/:bucket?prefix=...
      if (method === 'GET' && url.pathname.startsWith('/v1/list/')) {
        const bucketRaw = decodeURIComponent(url.pathname.slice('/v1/list/'.length))
        const bucket = parseBucket(bucketRaw)
        const prefix = url.searchParams.get('prefix') ?? ''
        const items = await store.list(bucket, prefix)
        return sendJson(res, 200, { items })
      }

      return sendJson(res, 404, { error: 'ROUTE_NOT_FOUND', path: url.pathname })
    } catch (err: any) {
      const message = err?.message ?? String(err)
      // A path-traversal attempt or an invalid bucket is a client error; an
      // unexpected filesystem failure is a server error.
      const clientError = /Unsafe storage relative path|Invalid storage bucket|Path traversal|exceeds \d+ bytes|INVALID_CUTOFF/.test(message)
      return sendJson(res, clientError ? 400 : 500, { error: message })
    }
  }

  const server = config.requireMtls
    ? https.createServer(
        {
          ca: fs.readFileSync(config.tlsCaCertPath!),
          cert: fs.readFileSync(config.tlsServerCertPath!),
          key: fs.readFileSync(config.tlsServerKeyPath!),
          requestCert: true,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.3',
        },
        handler
      )
    : http.createServer(handler)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.bindHost, () => resolve())
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : config.port
  const protocol = config.requireMtls ? 'https' : 'http'
  const hostForUrl = config.bindHost === '0.0.0.0' ? '127.0.0.1' : config.bindHost

  return {
    server,
    port: actualPort,
    baseUrl: `${protocol}://${hostForUrl}:${actualPort}`,
    store,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
