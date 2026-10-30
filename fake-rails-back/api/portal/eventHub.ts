import type { Response } from "express";

/**
 * Server-Sent Events hub. Every incoming rail call, injected fault and webhook
 * delivery is broadcast to every connected tester dashboard.
 */

export interface PortalEvent {
  type: string;
  at: string;
  payload: unknown;
}

const clients = new Set<Response>();

export const subscribe = (response: Response): (() => void) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders?.();
  response.write(`event: ready\ndata: ${JSON.stringify({ type: "ready", at: new Date().toISOString() })}\n\n`);
  clients.add(response);
  const heartbeat = setInterval(() => {
    try {
      response.write(`: ping ${Date.now()}\n\n`);
    } catch {
      clients.delete(response);
    }
  }, 15_000);
  heartbeat.unref?.();
  return () => {
    clearInterval(heartbeat);
    clients.delete(response);
  };
};

export const broadcast = (type: string, payload: unknown): void => {
  const event: PortalEvent = { type, at: new Date().toISOString(), payload };
  const frame = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
};

export const clientCount = (): number => clients.size;

export const closeAll = (): void => {
  for (const client of clients) {
    try {
      client.end();
    } catch {
      // ignore
    }
  }
  clients.clear();
};
