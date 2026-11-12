import type {
  Prisma,
  PrismaClient,
  StorageAvScanStatus,
  StorageNamespace,
  StorageObjectStatus,
} from '../../generated/prisma/client'
import type { StorageBucketTier } from './blobStore'

export type DbTxClient = Prisma.TransactionClient | PrismaClient

export type {
  StorageAvScanStatus,
  StorageBucketTier,
  StorageNamespace,
  StorageObjectStatus,
}

export type StorageHolderType =
  | 'KYB_DOCUMENT'
  | 'RECON_RUN'
  | 'REG_REPORT_SCHEMA'
  | 'REG_REPORT_OUTPUT'
  | 'REPORT_ASSET_ENTRY'
  | 'CATALOG_ASSET'
  | 'RAIL_LOGO'
  | 'DISPUTE_ATTACHMENT'
  | 'AML_CASE_EVIDENCE'

export interface NamespacePolicy {
  namespace: StorageNamespace
  defaultBucket: StorageBucketTier
  allowedMimeTypes: readonly string[]
  maxByteSize: number
  requiresAsyncAvScan: boolean
  defaultRetentionDays: number // Applied ONLY at promote() time, never at stageUpload()
  requiredAuthority: string
  confidentialityTier: 'PUBLIC_BRAND' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED_PII'
}

export const NAMESPACE_POLICIES: Record<StorageNamespace, NamespacePolicy> = {
  KYB_DOCUMENTS: {
    namespace: 'KYB_DOCUMENTS',
    defaultBucket: 'HOT',
    allowedMimeTypes: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
    maxByteSize: 25 * 1024 * 1024,
    requiresAsyncAvScan: true,
    defaultRetentionDays: 365 * 7, // 7 years after activation
    requiredAuthority: 'kyb:read',
    confidentialityTier: 'RESTRICTED_PII',
  },
  RECON_STATEMENTS: {
    namespace: 'RECON_STATEMENTS',
    defaultBucket: 'HOT',
    allowedMimeTypes: ['text/csv', 'text/plain', 'application/xml', 'application/json'],
    maxByteSize: 100 * 1024 * 1024,
    requiresAsyncAvScan: false,
    defaultRetentionDays: 365 * 7,
    requiredAuthority: 'reconciliation:read',
    confidentialityTier: 'CONFIDENTIAL',
  },
  REGULATORY_REPORTS: {
    namespace: 'REGULATORY_REPORTS',
    defaultBucket: 'HOT',
    allowedMimeTypes: [
      'application/pdf',
      'text/csv',
      'application/xml',
      'application/json',
      'text/plain',
      'application/zip',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    maxByteSize: 100 * 1024 * 1024,
    requiresAsyncAvScan: false,
    defaultRetentionDays: 365 * 10,
    requiredAuthority: 'compliance:reports:read',
    confidentialityTier: 'RESTRICTED_PII',
  },
  REPORT_STUDIO_ASSETS: {
    namespace: 'REPORT_STUDIO_ASSETS',
    defaultBucket: 'HOT',
    allowedMimeTypes: [
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/svg+xml',
      'font/ttf',
      'font/woff',
      'font/woff2',
      'application/zip',
    ],
    maxByteSize: 10 * 1024 * 1024,
    requiresAsyncAvScan: false,
    defaultRetentionDays: 365 * 5,
    requiredAuthority: 'reports.studio.read',
    confidentialityTier: 'INTERNAL',
  },
  MERCHANT_STATEMENTS: {
    namespace: 'MERCHANT_STATEMENTS',
    defaultBucket: 'HOT',
    allowedMimeTypes: ['application/pdf', 'text/csv', 'application/json'],
    maxByteSize: 50 * 1024 * 1024,
    requiresAsyncAvScan: false,
    defaultRetentionDays: 365 * 7,
    requiredAuthority: 'reports:read',
    confidentialityTier: 'CONFIDENTIAL',
  },
  DISPUTE_EVIDENCE: {
    namespace: 'DISPUTE_EVIDENCE',
    defaultBucket: 'HOT',
    allowedMimeTypes: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
    maxByteSize: 25 * 1024 * 1024,
    requiresAsyncAvScan: true,
    defaultRetentionDays: 365 * 7,
    requiredAuthority: 'disputes:read',
    confidentialityTier: 'CONFIDENTIAL',
  },
  AML_CASE_ATTACHMENTS: {
    namespace: 'AML_CASE_ATTACHMENTS',
    defaultBucket: 'HOT',
    allowedMimeTypes: ['application/pdf', 'image/png', 'image/jpeg', 'text/csv', 'application/json'],
    maxByteSize: 50 * 1024 * 1024,
    requiresAsyncAvScan: true,
    defaultRetentionDays: 365 * 10,
    requiredAuthority: 'compliance:aml:read',
    confidentialityTier: 'RESTRICTED_PII',
  },
  SYSTEM_BRAND_ASSETS: {
    namespace: 'SYSTEM_BRAND_ASSETS',
    defaultBucket: 'HOT',
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'],
    maxByteSize: 5 * 1024 * 1024,
    requiresAsyncAvScan: false,
    defaultRetentionDays: 365,
    requiredAuthority: 'system:assets:read',
    confidentialityTier: 'PUBLIC_BRAND',
  },
  BACKUP_ARTIFACTS: {
    namespace: 'BACKUP_ARTIFACTS',
    defaultBucket: 'COLD',
    allowedMimeTypes: ['application/octet-stream', 'application/gzip', 'application/json'],
    maxByteSize: 1024 * 1024 * 1024,
    requiresAsyncAvScan: false,
    defaultRetentionDays: 90,
    requiredAuthority: 'system:storage:admin',
    confidentialityTier: 'RESTRICTED_PII',
  },
}

export interface StorageActorContext {
  actorType: 'ADMIN' | 'MERCHANT_USER' | 'SYSTEM_WORKER'
  actorId: string
  merchantId?: string | null
  authorities: readonly string[]
  ipAddress?: string | null
  requestId?: string | null
}

export interface StageUploadInput {
  namespace: StorageNamespace
  data: Uint8Array | Buffer | ReadableStream<Uint8Array>
  originalFilename?: string | null
  claimedMimeType?: string | null
  ownerMerchantId?: string | null
  actor: StorageActorContext
  metadata?: Record<string, unknown>
}

export interface StagedObjectHandle {
  objectId: string
  bucket: StorageBucketTier
  storageKey: string
  sha256Hex: string
  byteSize: bigint
  detectedMimeType: string
  requiresAsyncAvScan: boolean
}

export interface BindLockInput {
  objectId: string
  holderType: StorageHolderType
  holderId: string
  actorId: string
  reason: string
  retentionFloorUntil?: Date | null
  autoPromoteIfNoAvRequired?: boolean
}

export interface ReleaseLockInput {
  objectId: string
  holderType: StorageHolderType
  holderId: string
  actorId: string
  reason: string
}

export interface ReadAuthorizedInput {
  objectId: string
  actor: StorageActorContext
  holderContext?: {
    holderType: StorageHolderType
    holderId: string
  }
}

export interface ReadObjectResult {
  objectId: string
  detectedMimeType: string
  originalFilename: string | null
  byteSize: bigint
  sha256Hex: string
  bytes: Uint8Array
  stream: () => ReadableStream<Uint8Array>
}

export type StorageErrorCode =
  | 'STORAGE_MIME_FORBIDDEN'
  | 'STORAGE_SVG_UNSAFE'
  | 'STORAGE_SIZE_EXCEEDED'
  | 'STORAGE_EMPTY_PAYLOAD'
  | 'STORAGE_OBJECT_NOT_FOUND'
  | 'STORAGE_OBJECT_QUARANTINED'
  | 'STORAGE_OBJECT_STAGING_NOT_READY'
  | 'STORAGE_OBJECT_PURGED'
  | 'STORAGE_ACCESS_DENIED'
  | 'STORAGE_TENANT_MISMATCH'
  | 'STORAGE_INTEGRITY_CORRUPTED'
  | 'STORAGE_LOCKED_CANNOT_DELETE'
  | 'STORAGE_LEGAL_HOLD_ACTIVE'

export class ObjectStorageError extends Error {
  public readonly code: StorageErrorCode
  public readonly httpStatus: number

  constructor(code: StorageErrorCode, message: string, httpStatus = 400) {
    super(message)
    this.name = 'ObjectStorageError'
    this.code = code
    this.httpStatus = httpStatus
  }
}
