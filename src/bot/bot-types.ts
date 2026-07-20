import type { CurrencyPair } from "../types/market.ts";

// ── Bot type registry ─────────────────────────────────────────────────────────
// To add a new bot type: add an entry to BOT_TYPE_REGISTRY with id, displayName,
// description, and defaultSettings. The engine will pick up the type automatically.

export type BotTypeId = "trendline" | "structure";

export interface BotTypeDefinition {
  id:             BotTypeId;
  displayName:    string;
  description:    string;
  defaultSettings: Record<string, unknown>;
}

export const BOT_TYPE_REGISTRY: BotTypeDefinition[] = [
  {
    id:          "trendline",
    displayName: "Trendline Bot",
    description: "Identifies broken trendlines and trades the retest. Combines multi-timeframe trendline analysis with candlestick confirmation.",
    defaultSettings: {
      minConfidenceScore: 60,
      minTouches:         2,
      riskPercent:        1.0,
      rewardRisk:         3.0,
      // Trade-setup tuning — defaults match the values these were hardcoded to before
      // becoming per-bot settings. See src/engines/trendline.ts DEFAULT_TRENDLINE_TUNABLES.
      slBufferAtr:        0.1,
      breakThresholdAtr:  0.5,
      retestWindowBars:   6,
      retestRecencyBars:  3,
      touchToleranceAtr:  0.3,
      minStopDistAtr:     0.2,
      swingLookback:      5,
      // "rr" = fixed reward:risk multiple of the stop (previous/only behavior).
      // "atLevel" = target the next opposing S/R zone instead, falling back to "rr"
      // when no zone is found ahead or it wouldn't produce a sane R:R.
      tpMode:             "rr",
      // Session filter — all true by default (no filtering, matches previous behavior).
      // Session is derived from the retest candle's UTC hour: see getTradingSession().
      allowAsianSession:  true,
      allowLondonSession: true,
      allowNySession:     true,
      // Require the retest candle to be a bullish/bearish engulfing (or hammer/shooting
      // star) in the break direction, not just a close on the right side of the line.
      // Off by default — matches previous behavior, which never checked this.
      requireCandleConfirmation: false,
    },
  },
  {
    id:          "structure",
    displayName: "Structure Bot",
    description: "Trades support/resistance zone bounces — enters on a candlestick reversal confirming a bounce at a confluence of S/R levels (an Area of Interest), rather than a trendline break.",
    defaultSettings: {
      minConfidenceScore: 60,
      minConfluence:      2,
      riskPercent:        1.0,
      rewardRisk:         3.0,
      // SL distance beyond the AOI's defining swing point, in ATR multiples.
      // See src/engines/structure-signal.ts DEFAULT_STRUCTURE_TUNABLES.
      slBufferAtr:        0.2,
      // "rr" = fixed reward:risk multiple of the stop (default). "atLevel" = target the
      // next opposing S/R zone instead, falling back to "rr" if none is found ahead.
      tpMode:             "rr",
      // Session filter — all true by default, same convention as the trendline bot.
      allowAsianSession:  true,
      allowLondonSession: true,
      allowNySession:     true,
    },
  },
];

export function getBotTypeDefinition(typeId: string): BotTypeDefinition | undefined {
  return BOT_TYPE_REGISTRY.find(t => t.id === typeId);
}

// ── Bot instance (stored in D1 `bots` table) ──────────────────────────────────

export interface BotInstance {
  id:         string;
  name:       string;
  type:       BotTypeId;
  mode:       "off" | "approval" | "autonomous";
  pairs:      CurrencyPair[];    // empty = all PHASE1_PAIRS
  settings:   Record<string, unknown>;
  accountId:  string | null;     // null = no account assigned
  createdAt:  number;
}

// ── D1 helpers ────────────────────────────────────────────────────────────────

export async function listBots(db: D1Database): Promise<BotInstance[]> {
  const rows = await db.prepare(
    `SELECT * FROM bots ORDER BY created_at ASC`
  ).all<Record<string, unknown>>();
  return rows.results.map(rowToBot);
}

export async function getBot(db: D1Database, id: string): Promise<BotInstance | null> {
  const row = await db.prepare(
    `SELECT * FROM bots WHERE id = ?`
  ).bind(id).first<Record<string, unknown>>();
  return row ? rowToBot(row) : null;
}

export async function createBot(db: D1Database, bot: Omit<BotInstance, "createdAt">): Promise<BotInstance> {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO bots (id, name, type, mode, pairs_json, settings_json, account_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    bot.id,
    bot.name,
    bot.type,
    bot.mode,
    JSON.stringify(bot.pairs),
    JSON.stringify(bot.settings),
    bot.accountId ?? null,
    now,
  ).run();
  return { ...bot, createdAt: now };
}

export async function updateBot(
  db: D1Database,
  id: string,
  patch: Partial<Pick<BotInstance, "name" | "mode" | "pairs" | "settings" | "accountId">>
): Promise<BotInstance | null> {
  const existing = await getBot(db, id);
  if (!existing) return null;

  const updated: BotInstance = {
    ...existing,
    ...(patch.name      !== undefined ? { name:      patch.name }                                    : {}),
    ...(patch.mode      !== undefined ? { mode:      patch.mode }                                    : {}),
    ...(patch.pairs     !== undefined ? { pairs:     patch.pairs }                                   : {}),
    ...(patch.settings  !== undefined ? { settings:  { ...existing.settings, ...patch.settings } }   : {}),
    ...(patch.accountId !== undefined ? { accountId: patch.accountId }                               : {}),
  };

  await db.prepare(
    `UPDATE bots SET name = ?, mode = ?, pairs_json = ?, settings_json = ?, account_id = ? WHERE id = ?`
  ).bind(
    updated.name,
    updated.mode,
    JSON.stringify(updated.pairs),
    JSON.stringify(updated.settings),
    updated.accountId ?? null,
    id,
  ).run();

  return updated;
}

export async function deleteBot(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare(`DELETE FROM bots WHERE id = ?`).bind(id).run();
  return (res.meta?.changes ?? 0) > 0;
}

function rowToBot(row: Record<string, unknown>): BotInstance {
  return {
    id:        row["id"]         as string,
    name:      row["name"]       as string,
    type:      row["type"]       as BotTypeId,
    mode:      row["mode"]       as BotInstance["mode"],
    pairs:     JSON.parse(row["pairs_json"]    as string) as CurrencyPair[],
    settings:  JSON.parse(row["settings_json"] as string) as Record<string, unknown>,
    accountId: (row["account_id"] as string | null) ?? null,
    createdAt: row["created_at"] as number,
  };
}

// ── Migration helper: seed the bots table from legacy bot:settings KV ─────────
// Called once on first load when bots table is empty.

export async function seedBotsFromLegacyKV(
  db: D1Database,
  kv: KVNamespace,
): Promise<void> {
  const count = await db.prepare(`SELECT COUNT(*) as c FROM bots`).first<{ c: number }>();
  if ((count?.c ?? 0) > 0) return; // already seeded

  const legacy = await kv.get("bot:settings", "json") as Record<string, unknown> | null;

  await createBot(db, {
    id:        "bot_trendline_1",
    name:      "Trendline Bot",
    type:      "trendline",
    mode:      (legacy?.mode as BotInstance["mode"]) ?? "off",
    pairs:     (legacy?.pairs as CurrencyPair[]) ?? [],
    accountId: null,
    settings: {
      ...getBotTypeDefinition("trendline")!.defaultSettings,
      minConfidenceScore: (legacy?.minConfidenceScore as number) ?? 60,
    },
  });
}
