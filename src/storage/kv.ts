import type { CurrencyPair, Timeframe } from "../types/market.ts";
import type { MarketStructure, SupportResistanceZone, TrendAnalysis } from "../types/trading.ts";

// Typed key system
type KVKey =
  | "app_config"
  | "provider_config"
  | `analysis_cache:${string}`
  | `last_scan:${string}`;

export interface AppConfig {
  provider: string;
  accountSize: number;
  maxLossPerTrade: number;
  maxOpenRecommendations: number;
  maxTotalOpenRisk: number;
  minRewardRisk: number;
  minConfidenceScore: number;
  enabledPairs: CurrencyPair[];
  sessionTimezone: string;
}

export interface CachedAnalysis {
  pair: CurrencyPair;
  timeframe: Timeframe;
  structure: MarketStructure;
  zones: SupportResistanceZone[];
  trend: TrendAnalysis;
  cachedAt: number;
}

const DEFAULT_CONFIG: AppConfig = {
  provider: "mock",
  accountSize: 10_000,
  maxLossPerTrade: 100,
  maxOpenRecommendations: 3,
  maxTotalOpenRisk: 300,
  minRewardRisk: 3.0,
  minConfidenceScore: 75,
  enabledPairs: ["EUR/USD", "GBP/USD", "GBP/CAD", "USD/JPY", "EUR/GBP", "AUD/USD"],
  sessionTimezone: "Europe/London",
};

function key(k: KVKey): string {
  return k;
}

export async function getConfig(kv: KVNamespace): Promise<AppConfig> {
  const raw = await kv.get(key("app_config"), "json") as AppConfig | null;
  return raw ?? DEFAULT_CONFIG;
}

export async function setConfig(kv: KVNamespace, config: AppConfig): Promise<void> {
  await kv.put(key("app_config"), JSON.stringify(config));
}

export async function getCachedAnalysis(
  kv: KVNamespace,
  pair: CurrencyPair
): Promise<CachedAnalysis | null> {
  const cacheKey: KVKey = `analysis_cache:${pair}`;
  const raw = await kv.get(key(cacheKey), "json") as CachedAnalysis | null;
  return raw;
}

export async function setCachedAnalysis(
  kv: KVNamespace,
  pair: CurrencyPair,
  analysis: CachedAnalysis,
  ttlSeconds: number = 3600
): Promise<void> {
  const cacheKey: KVKey = `analysis_cache:${pair}`;
  await kv.put(key(cacheKey), JSON.stringify(analysis), { expirationTtl: ttlSeconds });
}

export async function getLastScanTime(
  kv: KVNamespace,
  sessionName: string
): Promise<number | null> {
  const scanKey: KVKey = `last_scan:${sessionName}`;
  const raw = await kv.get(key(scanKey));
  return raw ? parseInt(raw, 10) : null;
}

export async function setLastScanTime(
  kv: KVNamespace,
  sessionName: string,
  timestamp: number
): Promise<void> {
  const scanKey: KVKey = `last_scan:${sessionName}`;
  await kv.put(key(scanKey), String(timestamp));
}
