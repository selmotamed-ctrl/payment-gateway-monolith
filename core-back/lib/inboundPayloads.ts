function toBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

/**
 * The inbound event parent is narrow; blobs are loaded only for the detail
 * rows or the small batch a worker has claimed.
 */
export async function attachInboundEventPayloads<T extends { id: bigint | string }>(
  db: any,
  events: T[],
): Promise<Array<T & { rawBodyBytes?: unknown; redactedHeadersJson?: unknown }>> {
  if (events.length === 0 || !db.inboundEventPayload?.findMany) {
    return events;
  }
  const ids = events.map((event) => toBigInt(event.id)).filter((id): id is bigint => id !== null);
  if (ids.length === 0) return events;
  const payloads = await db.inboundEventPayload.findMany({
    where: { eventId: { in: ids } },
    select: { eventId: true, rawBodyBytes: true, redactedHeadersJson: true },
  });
  const byId = new Map<string, { rawBodyBytes?: unknown; redactedHeadersJson?: unknown }>(
    payloads.map((payload: any) => [
      String(payload.eventId),
      payload as { rawBodyBytes?: unknown; redactedHeadersJson?: unknown },
    ]),
  );
  return events.map((event) => {
    const payload = byId.get(String(event.id));
    return payload
      ? { ...event, rawBodyBytes: payload.rawBodyBytes, redactedHeadersJson: payload.redactedHeadersJson }
      : event;
  });
}
