import { createReportEngine, type ReportEngine } from "../../lib/reportEngineSdk";
import { getPaymentGatewayReportHostConfig } from "./paymentGatewayHostConfig";

let engine: ReportEngine | null = null;

/** One cached host/engine per process, shared by the admin and merchant routes. */
export function getReportEngine(): ReportEngine {
  if (!engine) {
    engine = createReportEngine(getPaymentGatewayReportHostConfig());
  }
  return engine;
}
