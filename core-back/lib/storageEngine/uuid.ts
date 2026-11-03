import { randomBytes } from "node:crypto";

let lastTimestampMs = -1;
let sequence = 0;

/**
 * RFC 9562 UUIDv7: 48-bit big-endian Unix milliseconds, version 7, variant 10,
 * with a 12-bit intra-millisecond counter in `rand_a`. The counter makes ids
 * lexicographically monotonic even when many rows are generated in the same
 * millisecond, which preserves B-Tree insert locality on PostgreSQL.
 */
export const uuidv7 = (nowEpochMs: number = Date.now()): string => {
  const bytes = randomBytes(16);
  const wallClockMs = Math.floor(nowEpochMs);

  if (wallClockMs > lastTimestampMs) {
    lastTimestampMs = wallClockMs;
    sequence = ((bytes[6]! & 0x0f) << 8) | bytes[7]!;
  } else if (sequence < 0xfff) {
    sequence += 1;
  } else {
    lastTimestampMs += 1;
    sequence = 0;
  }

  const timestamp = BigInt(lastTimestampMs);
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Test-only reset of the monotonic generator state. */
export const resetUuidV7State = (): void => {
  lastTimestampMs = -1;
  sequence = 0;
};
