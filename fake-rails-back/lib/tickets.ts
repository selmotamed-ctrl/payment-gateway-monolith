import { randomUUID } from "node:crypto";
import { env } from "./env";
import { signJwt, verifyJwt } from "./jwt";

/**
 * Short-lived, purpose-bound tickets (GAP-024). They are signed with the portal secret but
 * carry their own `role`, so neither can be used as a tester session (which requires
 * `FAKE_RAILS_TESTER`) and a tester session cannot be used as either ticket.
 */
export const HOSTED_ACTION_ROLE = "FAKE_RAILS_HOSTED_ACTION";
export const SSE_TICKET_ROLE = "FAKE_RAILS_SSE_TICKET";
export const HOSTED_ACTION_TTL_SECONDS = 15 * 60;
export const SSE_TICKET_TTL_SECONDS = 30;

/** Binds the approve/decline POST to one hosted transaction. */
export const issueHostedActionToken = (transactionId: string): string =>
  signJwt({ sub: transactionId, role: HOSTED_ACTION_ROLE, expiresInSeconds: HOSTED_ACTION_TTL_SECONDS }, env.FAKE_RAILS_JWT_SECRET);

export const verifyHostedActionToken = (token: string | undefined, transactionId: string): boolean => {
  if (!token) return false;
  const payload = verifyJwt(token, env.FAKE_RAILS_JWT_SECRET);
  return payload !== null && payload.role === HOSTED_ACTION_ROLE && payload.sub === transactionId;
};

const usedSseTickets = new Map<string, number>();

/** One-shot ticket for the SSE stream so the portal session token never rides in a URL. */
export const issueSseTicket = (subject: string): string =>
  signJwt({ sub: subject, role: SSE_TICKET_ROLE, jti: randomUUID(), expiresInSeconds: SSE_TICKET_TTL_SECONDS }, env.FAKE_RAILS_JWT_SECRET);

/** Verifies and consumes an SSE ticket (single use). */
export const consumeSseTicket = (ticket: string): boolean => {
  const payload = verifyJwt(ticket, env.FAKE_RAILS_JWT_SECRET);
  if (!payload || payload.role !== SSE_TICKET_ROLE || typeof payload.jti !== "string") return false;
  const now = Date.now();
  for (const [jti, expiresAt] of usedSseTickets) if (expiresAt <= now) usedSseTickets.delete(jti);
  if (usedSseTickets.has(payload.jti)) return false;
  usedSseTickets.set(payload.jti, payload.exp * 1000);
  return true;
};
