import { ObjectStorageError } from './types'

const UNSAFE_SVG_PATTERNS: readonly RegExp[] = [
  /<script\b/i,
  /\bon[a-z]+\s*=/i,
  /<foreignObject\b/i,
  /javascript\s*:/i,
  /data\s*:\s*text\/html/i,
  /<iframe\b/i,
  /<embed\b/i,
  /<object\b/i,
  /<use\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i,
]

export function sanitizeAndValidateSvg(rawBytes: Uint8Array): void {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(rawBytes)
  if (!/<svg[\s>]/i.test(text)) {
    throw new ObjectStorageError('STORAGE_MIME_FORBIDDEN', 'Invalid SVG container', 415)
  }
  for (const pattern of UNSAFE_SVG_PATTERNS) {
    if (pattern.test(text)) {
      throw new ObjectStorageError(
        'STORAGE_SVG_UNSAFE',
        `SVG rejected due to forbidden active content matching ${pattern.source}`,
        415
      )
    }
  }
}

export function detectMimeTypeFromMagicBytes(
  header: Uint8Array,
  claimedMimeType?: string | null,
  originalFilename?: string | null
): string {
  if (header.byteLength === 0) {
    throw new ObjectStorageError('STORAGE_EMPTY_PAYLOAD', 'Cannot upload an empty 0-byte payload', 400)
  }

  // 1. PDF: %PDF-
  if (
    header.byteLength >= 5 &&
    header[0] === 0x25 &&
    header[1] === 0x50 &&
    header[2] === 0x44 &&
    header[3] === 0x46 &&
    header[4] === 0x2d
  ) {
    return 'application/pdf'
  }

  // 2. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    header.byteLength >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47 &&
    header[4] === 0x0d &&
    header[5] === 0x0a &&
    header[6] === 0x1a &&
    header[7] === 0x0a
  ) {
    return 'image/png'
  }

  // 3. JPEG: FF D8 FF
  if (header.byteLength >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg'
  }

  // 4. WEBP: RIFF....WEBP
  if (
    header.byteLength >= 12 &&
    header[0] === 0x52 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x46 &&
    header[8] === 0x57 &&
    header[9] === 0x45 &&
    header[10] === 0x42 &&
    header[11] === 0x50
  ) {
    return 'image/webp'
  }

  // 5. GZIP: 1F 8B
  if (header.byteLength >= 2 && header[0] === 0x1f && header[1] === 0x8b) {
    return 'application/gzip'
  }

  // 6. ZIP (report asset bundles, xlsx and docx are zip containers): PK\x03\x04 / PK\x05\x06 / PK\x07\x08
  if (
    header.byteLength >= 4 &&
    header[0] === 0x50 &&
    header[1] === 0x4b &&
    ((header[2] === 0x03 && header[3] === 0x04) ||
      (header[2] === 0x05 && header[3] === 0x06) ||
      (header[2] === 0x07 && header[3] === 0x08))
  ) {
    return 'application/zip'
  }

  // 7. WOFF2: wOF2 (77 4F 46 32), WOFF: wOFF (77 4F 46 46)
  if (
    header.byteLength >= 4 &&
    header[0] === 0x77 &&
    header[1] === 0x4f &&
    header[2] === 0x46 &&
    (header[3] === 0x32 || header[3] === 0x46)
  ) {
    return header[3] === 0x32 ? 'font/woff2' : 'font/woff'
  }

  // 8. TTF: 00 01 00 00
  if (
    header.byteLength >= 4 &&
    header[0] === 0x00 &&
    header[1] === 0x01 &&
    header[2] === 0x00 &&
    header[3] === 0x00
  ) {
    return 'font/ttf'
  }

  // 9. Reject executable headers immediately (ELF, MZ/PE, Mach-O)
  if (
    (header.byteLength >= 4 &&
      header[0] === 0x7f &&
      header[1] === 0x45 &&
      header[2] === 0x4c &&
      header[3] === 0x46) ||
    (header.byteLength >= 2 && header[0] === 0x4d && header[1] === 0x5a) ||
    (header.byteLength >= 4 &&
      [0xfe, 0xce, 0xcf, 0xca].includes(header[0]!) &&
      [0xed, 0xfa].includes(header[1]!))
  ) {
    throw new ObjectStorageError('STORAGE_MIME_FORBIDDEN', 'Executable binary uploads are strictly forbidden', 415)
  }

  // 10. Text-based formats (SVG, XML, JSON, CSV, plain text)
  const sample = new TextDecoder('utf-8', { fatal: false })
    .decode(header.subarray(0, Math.min(header.byteLength, 2048)))
    .trimStart()

  if (sample.startsWith('<svg') || (sample.startsWith('<?xml') && sample.includes('<svg'))) {
    return 'image/svg+xml'
  }
  if (sample.startsWith('<?xml') || sample.startsWith('<Document') || sample.startsWith('<BkToCstmrStmt')) {
    return 'application/xml'
  }
  if (sample.startsWith('{') || sample.startsWith('[')) {
    return 'application/json'
  }

  let binary = false
  const checkLen = Math.min(header.byteLength, 512)
  for (let i = 0; i < checkLen; i++) {
    const b = header[i]!
    if (b === 0x00) {
      binary = true
      break
    }
  }

  if (!binary) {
    const lowerName = (originalFilename ?? '').toLowerCase()
    if (claimedMimeType === 'text/csv' || lowerName.endsWith('.csv') || sample.includes(',')) {
      return 'text/csv'
    }
    return 'text/plain'
  }

  return 'application/octet-stream'
}
