import type { FailPhase } from "../../engine/chaos/DefaultRailScenarios";
import type { RailHandler } from "./common";

export interface RailRouteDefinition {
  gatewayCodes: string[];
  method: "GET" | "POST";
  path: string;
  phase: FailPhase;
  handler: RailHandler;
}
