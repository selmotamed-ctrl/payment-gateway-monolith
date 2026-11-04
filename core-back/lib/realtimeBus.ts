import { invalidationBus, type InvalidationEvent } from "./invalidationBus";
import type { AttemptTransitionEvent } from "../engine/flow/DynamicRailEngine";

/**
 * Cross-node realtime fan-out.
 *
 * The invalidation bus already carries a Redis transport on every core node.
 * Realtime uses dedicated topics on that same bus, so an SSE stream opened on
 * `chk-1` observes a transition processed by `core-2` on another machine.
 */
export const REALTIME_ATTEMPT_TOPIC = "realtime:attempt";
export const REALTIME_POS_TOPIC = "realtime:pos";

export interface RealtimeAttemptEvent extends AttemptTransitionEvent {
  merchantId?: string;
  emittedAt: string;
}

export interface RealtimePosEvent {
  merchantId: string;
  applicationId?: string;
  terminalId?: string;
  screenCode?: string;
  linkId?: string;
  linkKey?: string;
  emittedAt: string;
}

export const publishRealtimeAttempt = async (event: AttemptTransitionEvent): Promise<void> => {
  try {
    await invalidationBus.publish(REALTIME_ATTEMPT_TOPIC, {
      ...event,
      emittedAt: new Date().toISOString(),
    } satisfies RealtimeAttemptEvent);
  } catch {
    // Realtime fan-out is best-effort; the database poll fallback remains.
  }
};

export const subscribeRealtimeAttempt = (
  listener: (event: RealtimeAttemptEvent) => void | Promise<void>,
): (() => void) =>
  invalidationBus.subscribe(REALTIME_ATTEMPT_TOPIC, (event: InvalidationEvent<RealtimeAttemptEvent>) =>
    listener(event.payload),
  );

export const publishRealtimePos = async (event: Omit<RealtimePosEvent, "emittedAt">): Promise<void> => {
  try {
    await invalidationBus.publish(REALTIME_POS_TOPIC, {
      ...event,
      emittedAt: new Date().toISOString(),
    } satisfies RealtimePosEvent);
  } catch {
    // Realtime fan-out is best-effort; the POS stream polls as a fallback.
  }
};

export const subscribeRealtimePos = (
  listener: (event: RealtimePosEvent) => void | Promise<void>,
): (() => void) =>
  invalidationBus.subscribe(REALTIME_POS_TOPIC, (event: InvalidationEvent<RealtimePosEvent>) =>
    listener(event.payload),
  );
