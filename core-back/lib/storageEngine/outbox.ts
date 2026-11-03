import type { OutboxEnvelope } from "./ports";

type OutboxCreateData = {
  topic: string;
  aggregateType: string;
  aggregateId: string;
  merchantId?: string | null;
  payloadJson: unknown;
  createdAt?: Date;
};

export interface OutboxWriteClient {
  outboxEvent?: OutboxWriterLike;
}

export interface OutboxWriterLike {
  create(args: { data: OutboxCreateData }): Promise<unknown>;
  createMany?(args: { data: OutboxCreateData[] }): Promise<unknown>;
}

export const enqueueOutboxEvent = async (
  db: unknown,
  event: OutboxEnvelope,
  now: Date = new Date(),
): Promise<void> => {
  const candidate = db as any;
  const model = candidate?.outboxEvent ?? candidate;
  if (!model || typeof model.create !== "function") {
    return;
  }
  await model.create({
    data: {
      topic: event.topic,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      merchantId: event.merchantId ?? null,
      payloadJson: event.payload,
      createdAt: now,
    },
  });
};

export const enqueueOutboxEvents = async (
  db: unknown,
  events: readonly OutboxEnvelope[],
  now: Date = new Date(),
): Promise<void> => {
  if (events.length === 0) {
    return;
  }
  const candidate = db as any;
  const model = candidate?.outboxEvent ?? candidate;
  if (!model) {
    return;
  }
  if (typeof model.createMany === "function") {
    await model.createMany({
      data: events.map((event) => ({
        topic: event.topic,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        merchantId: event.merchantId ?? null,
        payloadJson: event.payload,
        createdAt: now,
      })),
    });
    return;
  }
  for (const event of events) {
    await enqueueOutboxEvent(db, event, now);
  }
};
