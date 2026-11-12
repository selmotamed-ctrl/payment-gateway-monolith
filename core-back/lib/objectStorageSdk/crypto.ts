import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { ObjectStorageError } from './types'

export const PGOS_MAGIC = Buffer.from('pgos1', 'ascii') // 5 bytes
export const DEFAULT_CHUNK_SIZE = 65536 // 64 KiB
const GCM_TAG_BYTES = 16

export interface KeyringMaterial {
  activeVersion: number
  keysByVersion: Map<number, Buffer> // 32-byte AES-256 KEKs
}

export class InMemoryKeyProvider {
  private readonly keyring: KeyringMaterial

  constructor(keyring: KeyringMaterial) {
    if (!keyring.keysByVersion.has(keyring.activeVersion)) {
      throw new Error(`Active KEK version ${keyring.activeVersion} is missing from keyring`)
    }
    this.keyring = keyring
  }

  static fromEnv(): InMemoryKeyProvider {
    const rawKeyring = process.env.OBJECT_STORAGE_KEK_KEYRING?.trim()
    const activeVer = Number(process.env.OBJECT_STORAGE_ACTIVE_KEK_VERSION ?? '1')
    const map = new Map<number, Buffer>()

    if (rawKeyring) {
      // Format: "v1:64hexchars,v2:64hexchars"
      for (const entry of rawKeyring.split(',')) {
        const [verPart, hexPart] = entry.trim().split(':')
        if (!verPart || !hexPart) continue
        const version = Number(verPart.replace(/^v/i, ''))
        if (!Number.isInteger(version) || version < 1) {
          throw new Error(`Invalid KEK version in OBJECT_STORAGE_KEK_KEYRING: ${verPart}`)
        }
        const buf = Buffer.from(hexPart, 'hex')
        if (buf.byteLength !== 32) {
          throw new Error(`Invalid KEK length for version ${version}: expected 32 bytes (64 hex chars)`)
        }
        map.set(version, buf)
      }
      if (map.size === 0) {
        throw new Error('OBJECT_STORAGE_KEK_KEYRING did not contain a single v<N>:<64-hex> entry')
      }
    } else {
      // Development-only deterministic fallback. A production deployment must
      // set OBJECT_STORAGE_KEK_KEYRING through the deploy engine.
      const fallback = createHash('sha256')
        .update(process.env.DATABASE_URL ?? 'pg-monolith-default-dev-kek-v1')
        .digest()
      map.set(1, fallback)
    }

    if (!map.has(activeVer)) {
      const available = [...map.keys()].sort((a, b) => a - b)
      if (available.length === 0) {
        throw new Error('OBJECT_STORAGE_ACTIVE_KEK_VERSION is not present in the keyring')
      }
      return new InMemoryKeyProvider({ activeVersion: available[available.length - 1]!, keysByVersion: map })
    }
    return new InMemoryKeyProvider({ activeVersion: activeVer, keysByVersion: map })
  }

  getActiveVersion(): number {
    return this.keyring.activeVersion
  }

  hasVersion(version: number): boolean {
    return this.keyring.keysByVersion.has(version)
  }

  wrapDek(dek: Buffer, objectId: string, keyVersion = this.keyring.activeVersion): {
    kekKeyVersion: number
    wrappedDek: Buffer
    dekNonce: Buffer
  } {
    const kek = this.keyring.keysByVersion.get(keyVersion)
    if (!kek) {
      throw new Error(`KEK version ${keyVersion} not found in keyring`)
    }
    const dekNonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', kek, dekNonce)
    cipher.setAAD(Buffer.from(`dek:${objectId}:v${keyVersion}`, 'utf8'))
    const ct = Buffer.concat([cipher.update(dek), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
      kekKeyVersion: keyVersion,
      wrappedDek: Buffer.concat([ct, tag]),
      dekNonce,
    }
  }

  unwrapDek(wrappedDek: Uint8Array, dekNonce: Uint8Array, objectId: string, keyVersion: number): Buffer {
    const kek = this.keyring.keysByVersion.get(keyVersion)
    if (!kek) {
      throw new ObjectStorageError(
        'STORAGE_INTEGRITY_CORRUPTED',
        `Cannot unwrap DEK: KEK version ${keyVersion} not loaded`,
        500
      )
    }
    if (dekNonce.byteLength !== 12) {
      throw new ObjectStorageError('STORAGE_INTEGRITY_CORRUPTED', 'Malformed DEK nonce length', 500)
    }
    const buf = Buffer.from(wrappedDek)
    if (buf.byteLength < GCM_TAG_BYTES + 32) {
      throw new ObjectStorageError('STORAGE_INTEGRITY_CORRUPTED', 'Malformed wrapped DEK length', 500)
    }
    const ct = buf.subarray(0, buf.byteLength - GCM_TAG_BYTES)
    const tag = buf.subarray(buf.byteLength - GCM_TAG_BYTES)
    try {
      const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(dekNonce))
      decipher.setAAD(Buffer.from(`dek:${objectId}:v${keyVersion}`, 'utf8'))
      decipher.setAuthTag(tag)
      const dek = Buffer.concat([decipher.update(ct), decipher.final()])
      if (dek.byteLength !== 32) {
        throw new Error('unexpected DEK length')
      }
      return dek
    } catch {
      throw new ObjectStorageError('STORAGE_INTEGRITY_CORRUPTED', 'DEK unwrap authentication tag mismatch', 500)
    }
  }
}

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '')
  if (hex.length !== 32 || !/^[0-9a-f]+$/i.test(hex)) {
    return createHash('md5').update(uuid).digest()
  }
  return Buffer.from(hex, 'hex')
}

function buildChunkNonce(streamNoncePrefix: Uint8Array, chunkIndex: number, isFinal: boolean): Buffer {
  const nonce = Buffer.allocUnsafe(12)
  Buffer.from(streamNoncePrefix).copy(nonce, 0, 0, 7)
  nonce.writeUInt32BE(chunkIndex >>> 0, 7)
  nonce.writeUInt8(isFinal ? 1 : 0, 11)
  return nonce
}

function buildChunkAad(objectId: string, chunkIndex: number, isFinal: boolean): Buffer {
  const aad = Buffer.allocUnsafe(21)
  uuidToBytes(objectId).copy(aad, 0, 0, 16)
  aad.writeUInt32BE(chunkIndex >>> 0, 16)
  aad.writeUInt8(isFinal ? 1 : 0, 20)
  return aad
}

export interface EncryptedEnvelopeResult {
  ciphertextBytes: Buffer
  plaintextSha256Hex: string
  plaintextByteSize: bigint
  chunkSizeBytes: number
  chunkCount: number
  kekKeyVersion: number
  wrappedDek: Buffer
  dekNonce: Buffer
  streamNoncePrefix: Buffer
}

export function encryptBufferToPgos1(
  plaintext: Uint8Array,
  objectId: string,
  keyProvider: InMemoryKeyProvider,
  chunkSizeBytes = DEFAULT_CHUNK_SIZE
): EncryptedEnvelopeResult {
  if (plaintext.byteLength === 0) {
    throw new ObjectStorageError('STORAGE_EMPTY_PAYLOAD', 'Cannot encrypt empty 0-byte payload', 400)
  }
  if (chunkSizeBytes < 4096 || chunkSizeBytes > 16 * 1024 * 1024) {
    throw new Error(`Unsupported pgos1 chunk size: ${chunkSizeBytes}`)
  }

  const dek = randomBytes(32)
  const streamNoncePrefix = randomBytes(7)
  const { kekKeyVersion, wrappedDek, dekNonce } = keyProvider.wrapDek(dek, objectId)
  const sha256 = createHash('sha256')
  sha256.update(plaintext)
  const plaintextSha256Hex = sha256.digest('hex')

  const totalChunks = Math.ceil(plaintext.byteLength / chunkSizeBytes)
  const parts: Buffer[] = [PGOS_MAGIC]

  for (let idx = 0; idx < totalChunks; idx++) {
    const start = idx * chunkSizeBytes
    const end = Math.min(start + chunkSizeBytes, plaintext.byteLength)
    const slice = plaintext.subarray(start, end)
    const isFinal = idx === totalChunks - 1

    const nonce = buildChunkNonce(streamNoncePrefix, idx, isFinal)
    const aad = buildChunkAad(objectId, idx, isFinal)
    const cipher = createCipheriv('aes-256-gcm', dek, nonce)
    cipher.setAAD(aad)
    const ct = Buffer.concat([cipher.update(slice), cipher.final()])
    const tag = cipher.getAuthTag()

    const frameHeader = Buffer.allocUnsafe(4)
    frameHeader.writeUInt32BE(slice.byteLength, 0)
    parts.push(frameHeader, ct, tag)
  }

  return {
    ciphertextBytes: Buffer.concat(parts),
    plaintextSha256Hex,
    plaintextByteSize: BigInt(plaintext.byteLength),
    chunkSizeBytes,
    chunkCount: totalChunks,
    kekKeyVersion,
    wrappedDek,
    dekNonce,
    streamNoncePrefix,
  }
}

export function decryptPgos1ToBuffer(params: {
  ciphertext: Uint8Array
  objectId: string
  kekKeyVersion: number
  wrappedDek: Uint8Array
  dekNonce: Uint8Array
  streamNoncePrefix: Uint8Array
  expectedChunkCount: number
  expectedByteSize: bigint
  expectedSha256Hex: string
  keyProvider: InMemoryKeyProvider
}): Buffer {
  const {
    ciphertext,
    objectId,
    kekKeyVersion,
    wrappedDek,
    dekNonce,
    streamNoncePrefix,
    expectedChunkCount,
    expectedByteSize,
    expectedSha256Hex,
    keyProvider,
  } = params

  const buf = Buffer.from(ciphertext)
  if (buf.byteLength < PGOS_MAGIC.byteLength) {
    throw new ObjectStorageError('STORAGE_INTEGRITY_CORRUPTED', 'Ciphertext shorter than pgos1 magic header', 500)
  }
  const magic = buf.subarray(0, PGOS_MAGIC.byteLength)
  if (!magic.equals(PGOS_MAGIC)) {
    throw new ObjectStorageError('STORAGE_INTEGRITY_CORRUPTED', 'Invalid pgos1 magic header', 500)
  }

  const dek = keyProvider.unwrapDek(wrappedDek, dekNonce, objectId, kekKeyVersion)
  let offset = PGOS_MAGIC.byteLength
  let chunkIdx = 0
  let sawFinalChunk = false
  const plaintextChunks: Buffer[] = []
  const sha256 = createHash('sha256')

  while (offset < buf.byteLength) {
    if (offset + 4 > buf.byteLength) {
      throw new ObjectStorageError('STORAGE_INTEGRITY_CORRUPTED', 'Truncated frame header in pgos1 stream', 500)
    }
    const plainLen = buf.readUInt32BE(offset)
    offset += 4
    if (plainLen > 16 * 1024 * 1024) {
      throw new ObjectStorageError('STORAGE_INTEGRITY_CORRUPTED', 'Frame length exceeds the pgos1 maximum', 500)
    }
    const frameEnd = offset + plainLen + GCM_TAG_BYTES
    if (frameEnd > buf.byteLength) {
      throw new ObjectStorageError('STORAGE_INTEGRITY_CORRUPTED', 'Truncated ciphertext frame in pgos1 stream', 500)
    }

    const ctSlice = buf.subarray(offset, offset + plainLen)
    const tagSlice = buf.subarray(offset + plainLen, frameEnd)
    offset = frameEnd

    const isFinal = offset === buf.byteLength
    const nonce = buildChunkNonce(streamNoncePrefix, chunkIdx, isFinal)
    const aad = buildChunkAad(objectId, chunkIdx, isFinal)

    let decryptedChunk: Buffer
    try {
      const decipher = createDecipheriv('aes-256-gcm', dek, nonce)
      decipher.setAAD(aad)
      decipher.setAuthTag(tagSlice)
      decryptedChunk = Buffer.concat([decipher.update(ctSlice), decipher.final()])
    } catch {
      throw new ObjectStorageError(
        'STORAGE_INTEGRITY_CORRUPTED',
        `GCM authentication failed at chunk ${chunkIdx} of object ${objectId}`,
        500
      )
    }

    plaintextChunks.push(decryptedChunk)
    sha256.update(decryptedChunk)
    if (isFinal) {
      sawFinalChunk = true
    }
    chunkIdx++
  }

  if (!sawFinalChunk || chunkIdx !== expectedChunkCount) {
    throw new ObjectStorageError(
      'STORAGE_INTEGRITY_CORRUPTED',
      `Chunk count mismatch on object ${objectId}: expected ${expectedChunkCount}, got ${chunkIdx}`,
      500
    )
  }

  const fullPlaintext = Buffer.concat(plaintextChunks)
  if (BigInt(fullPlaintext.byteLength) !== expectedByteSize) {
    throw new ObjectStorageError(
      'STORAGE_INTEGRITY_CORRUPTED',
      `Plaintext size mismatch on object ${objectId}: expected ${expectedByteSize}, got ${fullPlaintext.byteLength}`,
      500
    )
  }

  const computedSha = sha256.digest('hex')
  if (computedSha !== expectedSha256Hex) {
    throw new ObjectStorageError(
      'STORAGE_INTEGRITY_CORRUPTED',
      `Plaintext SHA-256 mismatch on object ${objectId}: expected ${expectedSha256Hex}, got ${computedSha}`,
      500
    )
  }

  return fullPlaintext
}
