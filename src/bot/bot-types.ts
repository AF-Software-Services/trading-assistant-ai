import type { CurrencyPair } from "../types/market.ts";

// ── Bot type registry ─────────────────────────────────────────────────────────
// To add a new bot type: add an entry to BOT_TYPE_REGISTRY with id, displayName,
// description, and defaultSettings. The engine will pick up the type automatically.

export type BotTypeId = "trendline" | "structure" | "fibonacci";

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
      // 2:1 — matches what both live trendline bots were actually tuned to in practice;
      // the original 3:1 default was never validated, just carried over from before
      // rewardRisk became a per-bot setting.
      rewardRisk:         2.0,
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
      // Off by default — see the Fibonacci bot's identical setting and dxy-filter.ts. Inert
      // regardless unless the DXY filter's own separate master toggle is also enabled.
      useDxyFilter: false,
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
  {
    id:          "fibonacci",
    displayName: "Fibonacci Bot",
    description: "Trades pullbacks into the golden pocket (50-61.8% retracement) of the latest H4 impulse leg, in the direction of the prevailing trend, confirmed by a candlestick reversal — enters on weakness, unlike the trendline bot's breakout entries.",
    defaultSettings: {
      // No continuous confidence gate beyond the spec's own deterministic pass/fail checks
      // (pocket + confirmation + trend + R:R) — kept at 0 so it never adds extra filtering
      // the spec didn't ask for; the field exists for UI consistency with the other bot types.
      minConfidenceScore: 0,
      riskPercent:        1.0,
      rewardRisk:         1.5, // only used by takeProfitMode "fixed_rr" — minReward below is the real gate
      minReward:          1.5, // skip the trade if the chosen TP mode's R:R < this
      pivotLookback:      3,
      minSwingATR:        2.0,
      pocketLow:           0.5,
      pocketHigh:           0.618,
      invalidationLevel:    0.786,
      requireCloseInsidePocket: true,
      stopMode:             "beyond_invalidation",
      stopBufferATR:        0.5,
      takeProfitMode:       "prior_swing",
      // Bot-level "use the filter" switch — off by default per explicit instruction, and
      // inert either way unless the DXY filter's own separate master toggle (also off by
      // default) is enabled too. See src/engines/dxy-filter.ts.
      useDxyFilter:        false,
      allowConcurrentWithTrendlineBot: false,
      maxOpenPositions:    2,
      allowDuplicatePairs: false,
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
  // Test bots are full bot configs used for backtesting only — hidden from the live Bot
  // tab and cron/monitor by default (see listBots's includeTest option), with a manually
  // set startingBalance instead of a real account's balance. Promoting one to a real live
  // bot is just assigning a real accountId and flipping isTest back to false in place.
  isTest:           boolean;
  startingBalance:  number | null;
}

// ── D1 helpers ────────────────────────────────────────────────────────────────

export async function listBots(db: D1Database, opts: { includeTest?: boolean } = {}): Promise<BotInstance[]> {
  const where = opts.includeTest ? '' : 'WHERE is_test = 0';
  const rows = await db.prepare(
    `SELECT * FROM bots ${where} ORDER BY created_at ASC`
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
    `INSERT INTO bots (id, name, type, mode, pairs_json, settings_json, account_id, created_at, is_test, starting_balance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    bot.id,
    bot.name,
    bot.type,
    bot.mode,
    JSON.stringify(bot.pairs),
    JSON.stringify(bot.settings),
    bot.accountId ?? null,
    now,
    bot.isTest ? 1 : 0,
    bot.startingBalance ?? null,
  ).run();
  return { ...bot, createdAt: now };
}

export async function updateBot(
  db: D1Database,
  id: string,
  patch: Partial<Pick<BotInstance, "name" | "mode" | "pairs" | "settings" | "accountId" | "isTest" | "startingBalance">>
): Promise<BotInstance | null> {
  const existing = await getBot(db, id);
  if (!existing) return null;

  const updated: BotInstance = {
    ...existing,
    ...(patch.name            !== undefined ? { name:            patch.name }                              : {}),
    ...(patch.mode            !== undefined ? { mode:            patch.mode }                              : {}),
    ...(patch.pairs           !== undefined ? { pairs:           patch.pairs }                             : {}),
    ...(patch.settings        !== undefined ? { settings:        { ...existing.settings, ...patch.settings } } : {}),
    ...(patch.accountId       !== undefined ? { accountId:       patch.accountId }                         : {}),
    ...(patch.isTest          !== undefined ? { isTest:          patch.isTest }                            : {}),
    ...(patch.startingBalance !== undefined ? { startingBalance: patch.startingBalance }                   : {}),
  };

  await db.prepare(
    `UPDATE bots SET name = ?, mode = ?, pairs_json = ?, settings_json = ?, account_id = ?, is_test = ?, starting_balance = ? WHERE id = ?`
  ).bind(
    updated.name,
    updated.mode,
    JSON.stringify(updated.pairs),
    JSON.stringify(updated.settings),
    updated.accountId ?? null,
    updated.isTest ? 1 : 0,
    updated.startingBalance ?? null,
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
    isTest:          !!(row["is_test"] as number | null),
    startingBalance: (row["starting_balance"] as number | null) ?? null,
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
    isTest:    false,
    startingBalance: null,
    settings: {
      ...getBotTypeDefinition("trendline")!.defaultSettings,
      minConfidenceScore: (legacy?.minConfidenceScore as number) ?? 60,
    },
  });
}
