import { getDb, nowIso } from "../db";
import {
  DEFAULT_SCENARIOS,
  RAIL_DESCRIPTORS,
  canonicalRailCode,
  defaultScenario,
  resolveRail,
  type RailChaosScenarioConfig,
} from "./DefaultRailScenarios";

interface ScenarioRow {
  rail_code: string;
  gateway_code: string;
  config_json: string;
  updated_at: string;
}

const ensureDefaults = (): void => {
  const db = getDb();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO fake_rail_scenarios (rail_code, gateway_code, config_json, updated_at) VALUES (?,?,?,?)",
  );
  for (const scenario of DEFAULT_SCENARIOS) {
    insert.run(scenario.railCode, scenario.gatewayCode, JSON.stringify(scenario), nowIso());
  }
};

export const listScenarios = (): RailChaosScenarioConfig[] => {
  ensureDefaults();
  const rows = getDb()
    .prepare("SELECT * FROM fake_rail_scenarios ORDER BY rail_code ASC")
    .all() as ScenarioRow[];
  return rows.map((row) => JSON.parse(row.config_json) as RailChaosScenarioConfig);
};

export const getScenario = (code: string): RailChaosScenarioConfig => {
  ensureDefaults();
  const canonical = canonicalRailCode(code);
  const row = getDb()
    .prepare("SELECT * FROM fake_rail_scenarios WHERE rail_code = ?")
    .get(canonical) as ScenarioRow | null;
  if (row) return JSON.parse(row.config_json) as RailChaosScenarioConfig;
  const descriptor = resolveRail(code) ?? RAIL_DESCRIPTORS.find((rail) => rail.railCode === canonical);
  return descriptor ? defaultScenario(descriptor) : defaultScenario(RAIL_DESCRIPTORS[0]!);
};

export const saveScenario = (config: RailChaosScenarioConfig): RailChaosScenarioConfig => {
  ensureDefaults();
  const canonical = canonicalRailCode(config.railCode);
  const normalized: RailChaosScenarioConfig = {
    ...config,
    railCode: canonical,
    gatewayCode: resolveRail(canonical)?.gatewayCode ?? config.gatewayCode,
    overallFailureChancePercent: clampPercent(config.overallFailureChancePercent),
  };
  getDb()
    .prepare(
      `INSERT INTO fake_rail_scenarios (rail_code, gateway_code, config_json, updated_at)
       VALUES (?,?,?,?)
       ON CONFLICT(rail_code) DO UPDATE SET gateway_code = excluded.gateway_code,
         config_json = excluded.config_json, updated_at = excluded.updated_at`,
    )
    .run(normalized.railCode, normalized.gatewayCode, JSON.stringify(normalized), nowIso());
  return normalized;
};

export const resetAllScenarios = (): RailChaosScenarioConfig[] => {
  const db = getDb();
  db.exec("DELETE FROM fake_rail_scenarios");
  ensureDefaults();
  return listScenarios();
};

const clampPercent = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
};
