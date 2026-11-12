import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tls from 'node:tls'
import { FsBlobStore, type StorageBucketTier } from './shared/blobStore'
import { loadDaemonConfigFromEnv, type ObjectStorageDaemonConfig } from './config'

const VALID_BUCKETS = new Set<StorageBucketTier>(['HOT', 'COLD', 'QUARANTINE'])
const DEFAULT_MAX_BODY_BYTES = 1200 * 1024 * 1024 // the BACKUP_ARTIFACTS namespace allows 1 GiB

/** The identity fields exposed by `tls.TLSSocket#getPeerCertificate()` that the daemon authorizes on. */
export interface PeerCertificateLike {
  subject?: { CN?: string | string[] }
}

/** True when the peer certificate's subject CN is in the allow-list. Missing/empty CNs are always refused. */
export const isAllowedClientIdentity = (
  peer: PeerCertificateLike | undefined,
  allowedClientCns: readonly string[],
): boolean => {
  const rawCn = peer?.subject?.CN
  const cn = Array.isArray(rawCn) ? rawCn[0] : rawCn
  return Boolean(cn && allowedClientCns.includes(cn))
}

const clientCertificateCn = (peer: PeerCertificateLike | undefined): string | undefined => {
  const rawCn = peer?.subject?.CN
  return Array.isArray(rawCn) ? rawCn[0] : rawCn
}

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
  server: http.Server | tls.Server
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
      // mTLS is enforced by the tls front below: Bun 1.4's node:https sockets do
      // not expose getPeerCertificate(), so the decrypted stream is bridged to
      // this inner HTTP server only after the certificate CN has been accepted.
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

  const closeServer = (server: http.Server | tls.Server): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(err)
        else resolve()
      })
    })

  /** Track accepted sockets so shutdown cannot wait forever on a keep-alive or half-open client. */
  const trackSockets = (server: http.Server | tls.Server): Set<net.Socket> => {
    const sockets = new Set<net.Socket>()
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    return sockets
  }

  const hostForUrl = config.bindHost === '0.0.0.0' ? '127.0.0.1' : config.bindHost

  if (!config.requireMtls) {
    const server = http.createServer(handler)
    const sockets = trackSockets(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.bindHost, () => resolve())
    })
    const address = server.address()
    const actualPort = typeof address === 'object' && address ? address.port : config.port
    return {
      server,
      port: actualPort,
      baseUrl: `http://${hostForUrl}:${actualPort}`,
      store,
      close: async () => {
        const closed = closeServer(server)
        for (const socket of sockets) socket.destroy()
        await closed
      },
    }
  }

  // Bun 1.4's node:https server does not expose getPeerCertificate() on the
  // request socket, so mTLS runs on a node:tls front. The front verifies the
  // client certificate and its CN, then bridges the decrypted stream to an
  // inner HTTP server on a private unix socket (loopback port on Windows).
  const socketDir = process.platform === 'win32' ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'pg-object-storage-daemon-'))
  if (socketDir) fs.chmodSync(socketDir, 0o700)
  const inner = http.createServer(handler)
  let upstream: net.NetConnectOpts
  if (socketDir) {
    const socketPath = path.join(socketDir, 'http.sock')
    await new Promise<void>((resolve, reject) => {
      inner.once('error', reject)
      inner.listen(socketPath, () => resolve())
    })
    upstream = { path: socketPath }
  } else {
    await new Promise<void>((resolve, reject) => {
      inner.once('error', reject)
      inner.listen(0, '127.0.0.1', () => resolve())
    })
    const innerAddress = inner.address()
    upstream = { host: '127.0.0.1', port: typeof innerAddress === 'object' && innerAddress ? innerAddress.port : 0 }
  }

  const forbidden = (error: string): string => {
    const body = JSON.stringify({ error })
    return `HTTP/1.1 403 Forbidden\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
  }
  const front = tls.createServer(
    {
      ca: fs.readFileSync(config.tlsCaCertPath!),
      cert: fs.readFileSync(config.tlsServerCertPath!),
      key: fs.readFileSync(config.tlsServerKeyPath!),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
    },
    (socket) => {
      if (!socket.authorized) {
        socket.on('error', () => undefined)
        socket.end(forbidden('MTLS_CLIENT_UNAUTHORIZED'))
        return
      }
      const peer = socket.getPeerCertificate()
      const cn = clientCertificateCn(peer)
      if (!cn || !isAllowedClientIdentity(peer, config.allowedClientCns)) {
        socket.on('error', () => undefined)
        socket.end(forbidden(`MTLS_CLIENT_CN_FORBIDDEN:${cn ?? 'none'}`))
        return
      }
      const backend = net.connect(upstream)
      socket.on('error', () => backend.destroy())
      backend.on('error', () => socket.destroy())
      socket.pipe(backend)
      backend.pipe(socket)
    },
  )
  const frontSockets = trackSockets(front)
  const innerSockets = trackSockets(inner)
  await new Promise<void>((resolve, reject) => {
    front.once('error', reject)
    front.listen(config.port, config.bindHost, () => resolve())
  })
  const address = front.address()
  const actualPort = typeof address === 'object' && address ? address.port : config.port
  return {
    server: front,
    port: actualPort,
    baseUrl: `https://${hostForUrl}:${actualPort}`,
    store,
    close: async () => {
      const frontClosed = closeServer(front)
      const innerClosed = closeServer(inner)
      for (const socket of frontSockets) socket.destroy()
      for (const socket of innerSockets) socket.destroy()
      await Promise.allSettled([frontClosed, innerClosed])
      if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true })
    },
  }
}
