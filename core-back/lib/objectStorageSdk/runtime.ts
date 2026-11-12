import type { PrismaClient } from '../../generated/prisma/client'
import { client } from '../../prisma/client'
import { createObjectStorageSdk, type ObjectStorageSdk } from './index'

/**
 * Binds an SDK to a specific Prisma client when that client exposes the
 * storage control plane. Test doubles (plain objects) get `null`, so a service
 * can keep its legacy code path without opening a real vault.
 */
export const createObjectStorageSdkForClient = (prisma: unknown): ObjectStorageSdk | null => {
  const candidate = prisma as { storageObject?: { create?: unknown } } | null | undefined
  if (!candidate || typeof candidate.storageObject?.create !== 'function') return null
  return createObjectStorageSdk({ prisma: candidate as PrismaClient })
}

let singleton: ObjectStorageSdk | undefined

/**
 * The process-wide object-storage SDK.
 *
 * Routes, workers and reporting services share one blob store, one keyring and
 * one database connection pool. Tests may replace it with `setObjectStorageSdk`.
 */
export const getObjectStorageSdk = (prisma: PrismaClient = client): ObjectStorageSdk => {
  if (!singleton) {
    singleton = createObjectStorageSdk({ prisma })
  }
  return singleton
}

/** Test/CLI hook: install a pre-built SDK (for example one bound to a sandbox database). */
export const setObjectStorageSdk = (sdk: ObjectStorageSdk | undefined): void => {
  singleton = sdk
}
