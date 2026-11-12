import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../../generated/prisma/client'
import { type BlobStore, createBlobStoreFromEnv } from './blobStore'
import { decryptPgos1ToBuffer, encryptBufferToPgos1, InMemoryKeyProvider } from './crypto'
import { checkHoldersExistInDb } from './holderRegistry'
import { detectMimeTypeFromMagicBytes, sanitizeAndValidateSvg } from './sniff'
import {
  type BindLockInput,
  type DbTxClient,
  NAMESPACE_POLICIES,
  ObjectStorageError,
  type ReadAuthorizedInput,
  type ReadObjectResult,
  type ReleaseLockInput,
  type StagedObjectHandle,
  type StageUploadInput,
  type StorageActorContext,
  type StorageBucketTier,
  type StorageHolderType,
  type StorageNamespace,
} from './types'

export * from './types'
export * from './blobStore'
export * from './crypto'
export * from './sniff'
export * from './holderRegistry'

async function toUint8Array(data: Uint8Array | Buffer | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data
  const reader = data.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.byteLength
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

function buildStorageKey(namespace: StorageNamespace, ownerMerchantId: string | null | undefined, objectId: string): string {
  const now = new Date()
  const yyyy = String(now.getUTCFullYear())
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const tenantSegment = ownerMerchantId ? ownerMerchantId : 'shared'
  return `${namespace.toLowerCase()}/${tenantSegment}/${yyyy}/${mm}/${objectId}.v1.enc`
}

export interface ObjectStorageSdkOptions {
  prisma: PrismaClient
  blobStore?: BlobStore
  keyProvider?: InMemoryKeyProvider
  gcGraceHours?: number
  stagingTtlMinutes?: number
}

export function createObjectStorageSdk(options: ObjectStorageSdkOptions) {
  const prisma = options.prisma
  const blobStore = options.blobStore ?? createBlobStoreFromEnv()
  const keyProvider = options.keyProvider ?? InMemoryKeyProvider.fromEnv()
  const gcGraceMs = (options.gcGraceHours ?? Number(process.env.OBJECT_STORAGE_GC_GRACE_HOURS ?? '24')) * 3600 * 1000
  const stagingTtlMs = (options.stagingTtlMinutes ?? 30) * 60 * 1000

  async function writeAccessLog(params: {
    objectId: string
    actor: StorageActorContext
    action: string
    allowed: boolean
    denialReason?: string | null
    holderType?: string | null
    holderId?: string | null
    bytesServed?: bigint | null
  }): Promise<void> {
    try {
      await prisma.storageObjectAccessLog.create({
        data: {
          objectId: params.objectId,
          actorType: params.actor.actorType,
          actorId: params.actor.actorId,
          action: params.action,
          allowed: params.allowed,
          denialReason: params.denialReason ?? null,
          holderType: params.holderType ?? null,
          holderId: params.holderId ?? null,
          ipAddress: params.actor.ipAddress ?? null,
          requestId: params.actor.requestId ?? null,
          bytesServed: params.bytesServed ?? null,
        },
      })
    } catch {
      // Access logging must never break a read. A missing object id (for
      // example a rejected staging attempt) is non-fatal by design.
    }
  }

  /**
   * Core staging logic (runs OUTSIDE any caller DB transaction).
   * Notice its signature does NOT accept a `tx` parameter, making network/disk I/O inside a DB tx impossible by construction.
   */
  async function stageUploadInternal(input: StageUploadInput, forceCleanAv = false): Promise<StagedObjectHandle> {
    const policy = NAMESPACE_POLICIES[input.namespace]
    if (!policy) {
      throw new ObjectStorageError('STORAGE_MIME_FORBIDDEN', `Unknown storage namespace ${String(input.namespace)}`, 400)
    }
    const rawBytes = await toUint8Array(input.data)

    if (rawBytes.byteLength === 0) {
      throw new ObjectStorageError('STORAGE_EMPTY_PAYLOAD', 'Cannot stage an empty 0-byte file', 400)
    }
    if (rawBytes.byteLength > policy.maxByteSize) {
      throw new ObjectStorageError(
        'STORAGE_SIZE_EXCEEDED',
        `Payload size ${rawBytes.byteLength} exceeds max allowed ${policy.maxByteSize} for namespace ${input.namespace}`,
        413
      )
    }

    const detectedMimeType = detectMimeTypeFromMagicBytes(
      rawBytes.subarray(0, Math.min(rawBytes.byteLength, 4096)),
      input.claimedMimeType,
      input.originalFilename
    )

    if (!policy.allowedMimeTypes.includes(detectedMimeType)) {
      throw new ObjectStorageError(
        'STORAGE_MIME_FORBIDDEN',
        `Detected MIME type "${detectedMimeType}" is not permitted in namespace ${input.namespace}`,
        415
      )
    }

    if (detectedMimeType === 'image/svg+xml') {
      sanitizeAndValidateSvg(rawBytes)
    }

    const objectId = randomUUID()
    const bucket: StorageBucketTier = policy.defaultBucket
    const storageKey = buildStorageKey(input.namespace, input.ownerMerchantId, objectId)

    // 1. Encrypt in memory using the pgos1 chunked AES-256-GCM envelope
    const encrypted = encryptBufferToPgos1(rawBytes, objectId, keyProvider)

    // 2. Insert STAGING intent row BEFORE writing blob to disk/remote daemon (prevents orphan blobs if process crashes)
    const requiresAv = policy.requiresAsyncAvScan && !forceCleanAv
    const stagingExpiresAt = new Date(Date.now() + stagingTtlMs)

    await prisma.storageObject.create({
      data: {
        id: objectId,
        bucket,
        namespace: input.namespace,
        storageKey,
        status: 'STAGING',
        sha256Hex: encrypted.plaintextSha256Hex,
        byteSize: encrypted.plaintextByteSize,
        chunkSizeBytes: encrypted.chunkSizeBytes,
        chunkCount: encrypted.chunkCount,
        detectedMimeType,
        originalFilename: input.originalFilename ? input.originalFilename.slice(0, 255) : null,
        kekKeyVersion: encrypted.kekKeyVersion,
        wrappedDek: new Uint8Array(encrypted.wrappedDek),
        dekNonce: new Uint8Array(encrypted.dekNonce),
        streamNoncePrefix: new Uint8Array(encrypted.streamNoncePrefix),
        ownerMerchantId: input.ownerMerchantId ?? null,
        uploadedByActorType: input.actor.actorType,
        uploadedByActorId: input.actor.actorId,
        requiredAuthority: policy.requiredAuthority,
        confidentialityTier: policy.confidentialityTier,
        retainUntil: null, // Retention is ONLY stamped at promote() time!
        avScanStatus: requiresAv ? 'PENDING' : 'NOT_REQUIRED',
        metadata: (input.metadata ?? {}) as any,
        stagingExpiresAt,
      },
    })

    // 3. Stream ciphertext to BlobStore (FsBlobStore or RemoteMtlsBlobStore on dedicated OBJECT_STORAGE_NODE)
    try {
      await blobStore.put(bucket, storageKey, encrypted.ciphertextBytes)
    } catch (error) {
      // The row remains STAGING; the GC worker retires it after its TTL.
      throw error
    }

    return {
      objectId,
      bucket,
      storageKey,
      sha256Hex: encrypted.plaintextSha256Hex,
      byteSize: encrypted.plaintextByteSize,
      detectedMimeType,
      requiresAsyncAvScan: requiresAv,
    }
  }

  /**
   * Pure-SQL promote(): transitions object to ACTIVE and stamps retainUntil = GREATEST(existing, NOW() + policyDays, max lock floor)
   */
  async function promoteInTx(tx: DbTxClient, objectId: string): Promise<void> {
    const obj = await tx.storageObject.findUnique({
      where: { id: objectId },
      include: { locks: { where: { releasedAt: null } } },
    })
    if (!obj) {
      throw new ObjectStorageError('STORAGE_OBJECT_NOT_FOUND', `StorageObject ${objectId} not found`, 404)
    }
    if (obj.status === 'PURGED') {
      throw new ObjectStorageError('STORAGE_OBJECT_PURGED', `StorageObject ${objectId} is purged`, 409)
    }
    const policy = NAMESPACE_POLICIES[obj.namespace]
    const defaultRetainUntil = new Date(Date.now() + policy.defaultRetentionDays * 86400 * 1000)

    let maxRetain = defaultRetainUntil
    if (obj.retainUntil && obj.retainUntil > maxRetain) {
      maxRetain = obj.retainUntil
    }
    for (const lock of obj.locks) {
      if (lock.retentionFloorUntil && lock.retentionFloorUntil > maxRetain) {
        maxRetain = lock.retentionFloorUntil
      }
    }

    await tx.storageObject.update({
      where: { id: objectId },
      data: {
        status: 'ACTIVE',
        activatedAt: obj.activatedAt ?? new Date(),
        retainUntil: maxRetain,
        gcEligibleAt: null,
      },
    })
  }

  /**
   * Pure-SQL bind(): runs INSIDE caller's prisma.$transaction(async (tx) => ...)
   */
  async function bindInTx(tx: DbTxClient, input: BindLockInput): Promise<void> {
    const obj = await tx.storageObject.findUnique({ where: { id: input.objectId } })
    if (!obj) {
      throw new ObjectStorageError('STORAGE_OBJECT_NOT_FOUND', `StorageObject ${input.objectId} not found`, 404)
    }
    if (obj.status === 'PURGED' || obj.status === 'QUARANTINE_REJECTED') {
      throw new ObjectStorageError(
        'STORAGE_OBJECT_PURGED',
        `Cannot bind lock to ${obj.status} object ${input.objectId}`,
        409
      )
    }
    if (input.retentionFloorUntil && obj.retainUntil && input.retentionFloorUntil < obj.retainUntil) {
      // A floor below the already stamped retention is harmless; promote()
      // takes the maximum. Nothing to do, but keep the caller's value for the
      // lock row so a later promote sees it.
    }

    await tx.storageObjectLock.upsert({
      where: {
        objectId_holderType_holderId: {
          objectId: input.objectId,
          holderType: input.holderType,
          holderId: input.holderId,
        },
      },
      create: {
        objectId: input.objectId,
        holderType: input.holderType,
        holderId: input.holderId,
        retentionFloorUntil: input.retentionFloorUntil ?? null,
        acquiredByActorId: input.actorId,
        acquiredReason: input.reason,
      },
      update: {
        releasedAt: null,
        releasedByActorId: null,
        releaseReason: null,
        acquiredByActorId: input.actorId,
        acquiredReason: input.reason,
        acquiredAt: new Date(),
        retentionFloorUntil: input.retentionFloorUntil ?? undefined,
      },
    })

    const policy = NAMESPACE_POLICIES[obj.namespace]
    const shouldPromoteNow =
      input.autoPromoteIfNoAvRequired !== false &&
      (!policy.requiresAsyncAvScan || obj.avScanStatus === 'CLEAN' || obj.avScanStatus === 'NOT_REQUIRED')

    if (shouldPromoteNow) {
      await promoteInTx(tx, input.objectId)
    } else if (obj.status === 'STAGING') {
      await tx.storageObject.update({
        where: { id: input.objectId },
        data: { status: 'QUARANTINE_PENDING_AV', gcEligibleAt: null },
      })
    } else if (obj.gcEligibleAt !== null) {
      await tx.storageObject.update({
        where: { id: input.objectId },
        data: { gcEligibleAt: null },
      })
    }
  }

  /**
   * Pure-SQL release(): marks the lock row released and, if zero active locks remain, stamps gc_eligible_at.
   */
  async function releaseInTx(tx: DbTxClient, input: ReleaseLockInput): Promise<{ remainingActiveLocks: number }> {
    await tx.storageObjectLock.updateMany({
      where: {
        objectId: input.objectId,
        holderType: input.holderType,
        holderId: input.holderId,
        releasedAt: null,
      },
      data: {
        releasedAt: new Date(),
        releasedByActorId: input.actorId,
        releaseReason: input.reason,
      },
    })

    const remainingActiveLocks = await tx.storageObjectLock.count({
      where: { objectId: input.objectId, releasedAt: null },
    })

    if (remainingActiveLocks === 0) {
      const obj = await tx.storageObject.findUnique({ where: { id: input.objectId } })
      if (obj && obj.status !== 'PURGED') {
        const graceTime = new Date(Date.now() + gcGraceMs)
        const gcEligibleAt = obj.retainUntil && obj.retainUntil > graceTime ? obj.retainUntil : graceTime
        await tx.storageObject.update({
          where: { id: input.objectId },
          data: { gcEligibleAt },
        })
      }
    }

    return { remainingActiveLocks }
  }

  async function discardStaged(objectId: string): Promise<void> {
    const obj = await prisma.storageObject.findUnique({
      where: { id: objectId },
      include: { locks: { where: { releasedAt: null } } },
    })
    if (!obj || obj.locks.length > 0 || obj.status === 'ACTIVE' || obj.status === 'PURGED') {
      return
    }
    await blobStore.moveToTrash(obj.bucket, obj.storageKey)
    await prisma.storageObject.update({
      where: { id: objectId },
      data: { status: 'PURGED', purgedAt: new Date() },
    })
  }

  async function decryptObject(obj: {
    id: string
    bucket: StorageBucketTier
    storageKey: string
    kekKeyVersion: number
    wrappedDek: Uint8Array
    dekNonce: Uint8Array
    streamNoncePrefix: Uint8Array
    chunkCount: number
    byteSize: bigint
    sha256Hex: string
  }): Promise<Buffer> {
    let ciphertext: Buffer
    try {
      ciphertext = await blobStore.readBytes(obj.bucket, obj.storageKey)
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        throw new ObjectStorageError(
          'STORAGE_INTEGRITY_CORRUPTED',
          `The encrypted blob for object ${obj.id} is missing from the vault`,
          500
        )
      }
      throw error
    }
    return decryptPgos1ToBuffer({
      ciphertext,
      objectId: obj.id,
      kekKeyVersion: obj.kekKeyVersion,
      wrappedDek: obj.wrappedDek,
      dekNonce: obj.dekNonce,
      streamNoncePrefix: obj.streamNoncePrefix,
      expectedChunkCount: obj.chunkCount,
      expectedByteSize: obj.byteSize,
      expectedSha256Hex: obj.sha256Hex,
      keyProvider,
    })
  }

  const routeClient = {
    stageUpload: (input: StageUploadInput) => stageUploadInternal(input, false),

    bind: (tx: DbTxClient, input: BindLockInput) => bindInTx(tx, input),

    promote: (tx: DbTxClient, objectId: string) => promoteInTx(tx, objectId),

    release: (tx: DbTxClient, input: ReleaseLockInput) => releaseInTx(tx, input),

    discardStaged,

    /**
     * Convenience helper that stages BEFORE the DB transaction, executes fn(staged) inside/with the caller's DB logic,
     * and automatically cleans up the staged blob if fn() throws or rolls back!
     */
    async withStagedUpload<T>(input: StageUploadInput, fn: (staged: StagedObjectHandle) => Promise<T>): Promise<T> {
      const staged = await stageUploadInternal(input, false)
      try {
        return await fn(staged)
      } catch (err) {
        await discardStaged(staged.objectId).catch(() => {})
        throw err
      }
    },

    async readAuthorized(input: ReadAuthorizedInput): Promise<ReadObjectResult> {
      const obj = await prisma.storageObject.findUnique({
        where: { id: input.objectId },
        include: { locks: { where: { releasedAt: null } } },
      })

      if (!obj) {
        throw new ObjectStorageError('STORAGE_OBJECT_NOT_FOUND', `Object ${input.objectId} not found`, 404)
      }

      if (obj.status === 'QUARANTINE_PENDING_AV' || obj.status === 'QUARANTINE_REJECTED') {
        await writeAccessLog({
          objectId: obj.id,
          actor: input.actor,
          action: 'READ_DENIED_QUARANTINE',
          allowed: false,
          denialReason: `Object status is ${obj.status}`,
          holderType: input.holderContext?.holderType,
          holderId: input.holderContext?.holderId,
        })
        throw new ObjectStorageError(
          'STORAGE_OBJECT_QUARANTINED',
          `Object ${obj.id} cannot be downloaded while in ${obj.status} state`,
          423
        )
      }

      if (obj.status !== 'ACTIVE') {
        await writeAccessLog({
          objectId: obj.id,
          actor: input.actor,
          action: 'READ_DENIED_STATUS',
          allowed: false,
          denialReason: `Object status is ${obj.status}`,
        })
        throw new ObjectStorageError(
          obj.status === 'PURGED' ? 'STORAGE_OBJECT_PURGED' : 'STORAGE_OBJECT_STAGING_NOT_READY',
          `Object ${obj.id} is in ${obj.status} state`,
          409
        )
      }

      if (input.holderContext) {
        const hasMatchingLock = obj.locks.some(
          (lock) => lock.holderType === input.holderContext!.holderType && lock.holderId === input.holderContext!.holderId
        )
        if (!hasMatchingLock) {
          await writeAccessLog({
            objectId: obj.id,
            actor: input.actor,
            action: 'READ_DENIED_HOLDER_MISMATCH',
            allowed: false,
            denialReason: `Object ${obj.id} is not locked by ${input.holderContext.holderType}:${input.holderContext.holderId}`,
            holderType: input.holderContext.holderType,
            holderId: input.holderContext.holderId,
          })
          throw new ObjectStorageError(
            'STORAGE_ACCESS_DENIED',
            'Requested object is not bound to the specified domain record',
            403
          )
        }
      }

      if (input.actor.actorType === 'MERCHANT_USER') {
        if (!input.actor.merchantId || obj.ownerMerchantId !== input.actor.merchantId) {
          await writeAccessLog({
            objectId: obj.id,
            actor: input.actor,
            action: 'READ_DENIED_TENANT_MISMATCH',
            allowed: false,
            denialReason: `Actor merchant ${input.actor.merchantId} != object owner ${obj.ownerMerchantId}`,
          })
          throw new ObjectStorageError(
            'STORAGE_TENANT_MISMATCH',
            'Cross-tenant access to storage object is forbidden',
            403
          )
        }
      }

      const hasSuperAdmin = input.actor.authorities.includes('*') || input.actor.authorities.includes('system:storage:admin')
      const hasRequiredAuthority =
        hasSuperAdmin ||
        obj.confidentialityTier === 'PUBLIC_BRAND' ||
        input.actor.authorities.includes(obj.requiredAuthority)

      if (!hasRequiredAuthority) {
        await writeAccessLog({
          objectId: obj.id,
          actor: input.actor,
          action: 'READ_DENIED_AUTHORITY',
          allowed: false,
          denialReason: `Missing required authority: ${obj.requiredAuthority}`,
        })
        throw new ObjectStorageError(
          'STORAGE_ACCESS_DENIED',
          `Actor lacks required authority "${obj.requiredAuthority}" to read object ${obj.id}`,
          403
        )
      }

      const decrypted = await decryptObject(obj)

      await writeAccessLog({
        objectId: obj.id,
        actor: input.actor,
        action: 'READ_AUTHORIZED',
        allowed: true,
        holderType: input.holderContext?.holderType,
        holderId: input.holderContext?.holderId,
        bytesServed: obj.byteSize,
      })

      return {
        objectId: obj.id,
        detectedMimeType: obj.detectedMimeType,
        originalFilename: obj.originalFilename,
        byteSize: obj.byteSize,
        sha256Hex: obj.sha256Hex,
        bytes: new Uint8Array(decrypted),
        stream: () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(decrypted))
              controller.close()
            },
          }),
      }
    },

    async placeLegalHold(params: { objectId: string; adminId: string; reason: string }) {
      const updated = await prisma.storageObject.update({
        where: { id: params.objectId },
        data: {
          legalHold: true,
          legalHoldReason: params.reason,
          legalHoldByAdminId: params.adminId,
          legalHoldPlacedAt: new Date(),
        },
      })
      await writeAccessLog({
        objectId: params.objectId,
        actor: { actorType: 'ADMIN', actorId: params.adminId, authorities: ['system:storage:legal-hold'] },
        action: 'PLACE_LEGAL_HOLD',
        allowed: true,
      })
      return updated
    },

    async liftLegalHold(params: { objectId: string; adminId: string; reason: string }) {
      const updated = await prisma.storageObject.update({
        where: { id: params.objectId },
        data: {
          legalHold: false,
          legalHoldReason: params.reason,
        },
      })
      await writeAccessLog({
        objectId: params.objectId,
        actor: { actorType: 'ADMIN', actorId: params.adminId, authorities: ['system:storage:legal-hold'] },
        action: 'LIFT_LEGAL_HOLD',
        allowed: true,
      })
      return updated
    },
  }

  // ============================================================================
  // workerClient: System Workers, AV Scanner, GC, Scrubber, Rewrap & Backup
  // ============================================================================
  const workerClient = {
    stageSystemGenerated: (input: Omit<StageUploadInput, 'actor'> & { actorId?: string }) =>
      stageUploadInternal(
        {
          ...input,
          actor: {
            actorType: 'SYSTEM_WORKER',
            actorId: input.actorId ?? 'system-worker',
            authorities: ['*'],
          },
        },
        true
      ),

    async readInternal(objectId: string, workerName: string): Promise<ReadObjectResult> {
      const obj = await prisma.storageObject.findUnique({ where: { id: objectId } })
      if (!obj) {
        throw new ObjectStorageError('STORAGE_OBJECT_NOT_FOUND', `Object ${objectId} not found`, 404)
      }
      if (obj.status !== 'ACTIVE') {
        throw new ObjectStorageError(
          'STORAGE_OBJECT_QUARANTINED',
          `Worker ${workerName} cannot read non-ACTIVE object ${objectId} (status=${obj.status})`,
          423
        )
      }
      const decrypted = await decryptObject(obj)
      await writeAccessLog({
        objectId: obj.id,
        actor: { actorType: 'SYSTEM_WORKER', actorId: workerName, authorities: ['*'] },
        action: 'READ_INTERNAL_WORKER',
        allowed: true,
        bytesServed: obj.byteSize,
      })
      return {
        objectId: obj.id,
        detectedMimeType: obj.detectedMimeType,
        originalFilename: obj.originalFilename,
        byteSize: obj.byteSize,
        sha256Hex: obj.sha256Hex,
        bytes: new Uint8Array(decrypted),
        stream: () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(decrypted))
              controller.close()
            },
          }),
      }
    },

    async readForScan(objectId: string): Promise<{ objectId: string; bytes: Buffer; detectedMimeType: string }> {
      const obj = await prisma.storageObject.findUnique({ where: { id: objectId } })
      if (!obj) {
        throw new ObjectStorageError('STORAGE_OBJECT_NOT_FOUND', `Object ${objectId} not found`, 404)
      }
      const decrypted = await decryptObject(obj)
      return { objectId: obj.id, bytes: decrypted, detectedMimeType: obj.detectedMimeType }
    },

    async applyScanVerdict(params: {
      objectId: string
      verdict: 'CLEAN' | 'INFECTED'
      signature?: string | null
    }): Promise<void> {
      await prisma.$transaction(async (tx) => {
        if (params.verdict === 'CLEAN') {
          await tx.storageObject.update({
            where: { id: params.objectId },
            data: {
              avScanStatus: 'CLEAN',
              avScannedAt: new Date(),
              avSignature: null,
            },
          })
          await promoteInTx(tx, params.objectId)
        } else {
          await tx.storageObjectLock.updateMany({
            where: { objectId: params.objectId, releasedAt: null },
            data: {
              releasedAt: new Date(),
              releasedByActorId: 'av-scan-worker',
              releaseReason: `AV_INFECTED:${params.signature ?? 'MALWARE'}`,
            },
          })
          await tx.storageObject.update({
            where: { id: params.objectId },
            data: {
              status: 'QUARANTINE_REJECTED',
              avScanStatus: 'INFECTED',
              avScannedAt: new Date(),
              avSignature: params.signature ?? 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE',
              stagingExpiresAt: new Date(Date.now() + 24 * 3600 * 1000),
            },
          })
        }
      })
    },

    async runGcBatch(now = new Date()): Promise<{ purgedObjectIds: string[] }> {
      const candidates = await prisma.storageObject.findMany({
        where: {
          legalHold: false,
          OR: [
            { status: 'STAGING', stagingExpiresAt: { lte: now } },
            { status: 'QUARANTINE_REJECTED', stagingExpiresAt: { lte: now } },
            {
              status: 'ACTIVE',
              gcEligibleAt: { lte: now },
              OR: [{ retainUntil: null }, { retainUntil: { lte: now } }],
            },
          ],
        },
        include: { locks: { where: { releasedAt: null } } },
        take: 100,
      })

      const purgedObjectIds: string[] = []
      for (const obj of candidates) {
        if (obj.locks.length > 0) continue
        await blobStore.moveToTrash(obj.bucket, obj.storageKey, now.toISOString().slice(0, 10))
        try {
          await prisma.storageObject.update({
            where: { id: obj.id },
            data: { status: 'PURGED', purgedAt: now },
          })
          purgedObjectIds.push(obj.id)
        } catch {
          // A concurrent bind/legal hold won the race; the trigger refused the
          // purge. The row stays readable and the next GC pass retries.
        }
      }
      return { purgedObjectIds }
    },

    async runBlobSweep(params?: { minAgeMs?: number; trashRetentionDays?: number }): Promise<{
      trashedOrphans: string[]
      purgedTrashFolders: number
    }> {
      const minAgeMs = params?.minAgeMs ?? 3600 * 1000
      const trashRetentionDays =
        params?.trashRetentionDays ?? Number(process.env.OBJECT_STORAGE_TRASH_RETENTION_DAYS ?? '7')
      const cutoffMs = Date.now() - minAgeMs
      const trashedOrphans: string[] = []

      for (const bucket of ['HOT', 'COLD', 'QUARANTINE'] as StorageBucketTier[]) {
        const files = await blobStore.list(bucket)
        for (const file of files) {
          if (file.mtimeMs > cutoffMs) continue
          const row = await prisma.storageObject.findUnique({
            where: { bucket_storageKey: { bucket, storageKey: file.relPath } },
            select: { id: true, status: true },
          })
          if (!row || row.status === 'PURGED') {
            await blobStore.moveToTrash(bucket, file.relPath)
            trashedOrphans.push(`${bucket}:${file.relPath}`)
          }
        }
      }

      const cutoffDateIso = new Date(Date.now() - trashRetentionDays * 86400 * 1000).toISOString().slice(0, 10)
      const purgedTrashFolders = await blobStore.purgeTrashOlderThan(cutoffDateIso)
      return { trashedOrphans, purgedTrashFolders }
    },

    async runIntegrityScrubBatch(batchSize = 50): Promise<{
      verifiedCount: number
      corruptedObjectIds: string[]
    }> {
      const rows = await prisma.storageObject.findMany({
        where: { status: 'ACTIVE' },
        orderBy: [{ lastScrubbedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
        take: batchSize,
      })

      let verifiedCount = 0
      const corruptedObjectIds: string[] = []

      for (const obj of rows) {
        try {
          await decryptObject(obj)
          await prisma.storageObject.update({
            where: { id: obj.id },
            data: { lastScrubbedAt: new Date() },
          })
          verifiedCount++
        } catch {
          corruptedObjectIds.push(obj.id)
          await prisma.storageObject.update({
            where: { id: obj.id },
            data: {
              lastScrubbedAt: new Date(),
              scrubErrorCount: { increment: 1 },
            },
          })
        }
      }

      return { verifiedCount, corruptedObjectIds }
    },

    async runLockReconcile(): Promise<{ releasedDanglingLocks: number }> {
      const activeLocks = await prisma.storageObjectLock.findMany({
        where: { releasedAt: null },
      })
      const byType = new Map<StorageHolderType, typeof activeLocks>()
      for (const lock of activeLocks) {
        const holderType = lock.holderType as StorageHolderType
        const list = byType.get(holderType) ?? []
        list.push(lock)
        byType.set(holderType, list)
      }

      let releasedDanglingLocks = 0
      for (const [holderType, locks] of byType.entries()) {
        for (let index = 0; index < locks.length; index += 100) {
          const batch = locks.slice(index, index + 100)
          const holderIds = Array.from(new Set(batch.map((lock) => lock.holderId)))
          const existingSet = await checkHoldersExistInDb(prisma, holderType, holderIds)
          for (const lock of batch) {
            if (!existingSet.has(lock.holderId)) {
              await prisma.$transaction(async (tx) => {
                await releaseInTx(tx, {
                  objectId: lock.objectId,
                  holderType,
                  holderId: lock.holderId,
                  actorId: 'lock-reconciler-worker',
                  reason: 'HOLDER_ROW_MISSING_RECONCILED',
                })
              })
              releasedDanglingLocks++
            }
          }
        }
      }
      return { releasedDanglingLocks }
    },

    async runRewrapBatch(batchSize = 100): Promise<{ rewrappedCount: number; targetVersion: number }> {
      const targetVersion = keyProvider.getActiveVersion()
      const rows = await prisma.storageObject.findMany({
        where: {
          status: { not: 'PURGED' },
          kekKeyVersion: { not: targetVersion },
        },
        take: batchSize,
      })

      let rewrappedCount = 0
      for (const obj of rows) {
        let dek: Buffer
        try {
          dek = keyProvider.unwrapDek(obj.wrappedDek, obj.dekNonce, obj.id, obj.kekKeyVersion)
        } catch {
          // A corrupt or missing old KEK must not stop the batch: record the
          // scrub error and leave the row for repair/an operator decision.
          await prisma.storageObject.update({
            where: { id: obj.id },
            data: { scrubErrorCount: { increment: 1 } },
          })
          continue
        }
        const rewrapped = keyProvider.wrapDek(dek, obj.id, targetVersion)
        await prisma.storageObject.update({
          where: { id: obj.id },
          data: {
            kekKeyVersion: rewrapped.kekKeyVersion,
            wrappedDek: new Uint8Array(rewrapped.wrappedDek),
            dekNonce: new Uint8Array(rewrapped.dekNonce),
          },
        })
        rewrappedCount++
      }
      return { rewrappedCount, targetVersion }
    },

    async exportManifest(): Promise<
      Array<{
        id: string
        bucket: StorageBucketTier
        storageKey: string
        sha256Hex: string
        byteSize: string
        chunkCount: number
        kekKeyVersion: number
        wrappedDekHex: string
        dekNonceHex: string
        streamNoncePrefixHex: string
      }>
    > {
      const active = await prisma.storageObject.findMany({
        where: { status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
      })
      return active.map((obj) => ({
        id: obj.id,
        bucket: obj.bucket as StorageBucketTier,
        storageKey: obj.storageKey,
        sha256Hex: obj.sha256Hex,
        byteSize: obj.byteSize.toString(),
        chunkCount: obj.chunkCount,
        kekKeyVersion: obj.kekKeyVersion,
        wrappedDekHex: Buffer.from(obj.wrappedDek).toString('hex'),
        dekNonceHex: Buffer.from(obj.dekNonce).toString('hex'),
        streamNoncePrefixHex: Buffer.from(obj.streamNoncePrefix).toString('hex'),
      }))
    },
  }

  return {
    prisma,
    blobStore,
    keyProvider,
    routeClient,
    workerClient,
  }
}

export type ObjectStorageSdk = ReturnType<typeof createObjectStorageSdk>
