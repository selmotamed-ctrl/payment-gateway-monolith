import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request storage telemetry. The read helper records which store served a
 * query and the middleware exposes it as `x-pg-served-by` so a two-machine
 * gate can prove replica routing without parsing logs.
 */
export interface StorageTelemetryContext {
  response?: { setHeader(name: string, value: string): unknown };
  servedBy?: string;
  minLsn?: string;
}

export const storageTelemetry = new AsyncLocalStorage<StorageTelemetryContext>();

export const recordReadSource = (servedBy: string, minLsn?: string): void => {
  const store = storageTelemetry.getStore();
  if (!store) return;
  store.servedBy = servedBy;
  if (minLsn) store.minLsn = minLsn;
  store.response?.setHeader("x-pg-served-by", servedBy);
  if (minLsn) store.response?.setHeader("x-pg-min-lsn", minLsn);
};
