import { Hono } from "hono";
import type { Env } from "../index.ts";
import { runTrendlineBacktest, runStructureBacktest, buildSummary, fetchCandles, trendbarCacheKey } from "./runner.ts";
import type { BacktestConfig, BacktestResult } from "./runner.ts";
import { saveBotSignal } from "../bot/engine.ts";
import { getBot } from "../bot/bot-types.ts";
import { getAccount, getPrimaryAccountBalance } from "../ctrader/account-types.ts";
import { pickTrendlineTunables } from "../engines/trendline.ts";
import { pickStructureTunables } from "../engines/structure-signal.ts";
import { TradingService } from "../trading/service.ts";


export function createBacktestRouter() {
  const router = new Hono<{ Bindings: Env }>();

  // POST /api/v1/backtest/run
  router.post("/api/v1/backtest/run", async (c) => {
    const body = await c.req.json<Partial<BacktestConfig> & { pairs: string[]; fromMs: number; toMs: number; botId?: string }>();

    if (!body.pairs?.length || !body.fromMs || !body.toMs) {
      return c.json({ error: "pairs, fromMs, toMs are required" }, 400);
    }
    if (!body.botId) return c.json({ error: "botId is required" }, 400);

    const [riskRaw, botInstance] = await Promise.all([
      c.env.KV.get("user:risk_settings", "json") as Promise<Record<string, number> | null>,
      getBot(c.env.DB, body.botId),
    ]);
    if (!botInstance) return c.json({ error: "Bot not found" }, 404);

    // Starting capital is the bot's own linked account's real cTrader balance — falls back to
    // any other connected account's balance, then a safe placeholder if nothing is connected yet.
    const botAccount = botInstance.accountId ? await getAccount(c.env.DB, botInstance.accountId) : null;
    const accountBalance = botAccount?.balance ?? await getPrimaryAccountBalance(c.env.DB) ?? 1000;

    // Execution constraints come from the bot with no fallback — must match the live run exactly.
    // Sizing params (riskPercent, rewardRisk) fall back to global risk settings for bots that
    // pre-date those fields being saved on the bot card.
    const riskPercent        = (botInstance.settings["riskPercent"]  as number | undefined) ?? (riskRaw?.riskPercent  ?? 1);
    const rewardRisk         = (botInstance.settings["rewardRisk"]   as number | undefined) ?? (riskRaw?.rewardRisk   ?? 1.5);
    const minScore           = botInstance.settings["minConfidenceScore"] as number;
    const minConfluence      = (botInstance.settings["minConfluence"] as number | undefined) ?? 2;
    const maxOpenPositions   = botInstance.settings["maxOpenPositions"]   as number;
    const allowDuplicatePairs = botInstance.settings["allowDuplicatePairs"] as boolean;
    const swingLookback      = (botInstance.settings["swingLookback"] as number | undefined) ?? 5;
    // Trade-setup tuning — undefined fields fall back to each engine's own DEFAULT_*_TUNABLES,
    // same as the live bot path in bot/engine.ts.
    const tunables = pickTrendlineTunables(botInstance.settings);
    const structureTunables = pickStructureTunables(botInstance.settings);
    const tpMode = (botInstance.settings["tpMode"] === "atLevel" ? "atLevel" : "rr") as "rr" | "atLevel";
    const requireCandleConfirmation = botInstance.settings["requireCandleConfirmation"] === true;
    const allowedSessions = {
      asian:  botInstance.settings["allowAsianSession"]  !== false,
      london: botInstance.settings["allowLondonSession"] !== false,
      ny:     botInstance.settings["allowNySession"]     !== false,
    };
    const pairs          = body.pairs;
    const { fromMs, toMs } = body;

    const trading = await TradingService.tryConnect(c.env);
    if (!trading) return c.json({ error: "cTrader not connected — backtest needs a live connection to fetch candle history" }, 502);

    const runId = crypto.randomUUID();
    const startedAt = Date.now();

    await c.env.DB.prepare(
      `INSERT INTO backtest_runs (id, started_at, status, config_json) VALUES (?, ?, 'running', ?)`
    ).bind(runId, startedAt, JSON.stringify(body)).run();

    const runBacktest = async () => {
      try {
        const { signals, diagnostics, log } = botInstance.type === "structure"
          ? await runStructureBacktest(
              { pairs, fromMs, toMs, accountBalance, riskPercent, rewardRisk, minScore, minConfluence, maxOpenPositions, allowDuplicatePairs, tunables: structureTunables, tpMode, allowedSessions },
              trading,
              (msg) => console.log(`[backtest ${runId}] ${msg}`),
              c.env.KV,
            )
          : await runTrendlineBacktest(
              { pairs, fromMs, toMs, accountBalance, riskPercent, rewardRisk, minScore, maxOpenPositions, allowDuplicatePairs, swingLookback, tunables, tpMode, requireCandleConfirmation, allowedSessions },
              trading,
              (msg) => console.log(`[backtest ${runId}] ${msg}`),
              c.env.KV,
            );

        for (const signal of signals) {
          signal.backtestRunId = runId;
          await saveBotSignal(c.env.DB, signal);
        }

        const summary = buildSummary(signals, diagnostics, log);
        await c.env.DB.prepare(
          `UPDATE backtest_runs SET status='completed', completed_at=?, summary_json=? WHERE id=?`
        ).bind(Date.now(), JSON.stringify(summary), runId).run();

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await c.env.DB.prepare(
          `UPDATE backtest_runs SET status='failed', completed_at=?, error=? WHERE id=?`
        ).bind(Date.now(), msg, runId).run();
      }
    };

    // Run synchronously rather than via waitUntil() — waitUntil has its own separate,
    // shorter wall-clock cap on background execution (independent of the CPU time limit),
    // and backtests were hitting that cap even when comfortably within the CPU budget.
    // The request just takes as long as the backtest actually takes.
    await runBacktest();

    return c.json({ runId });
  });

  // GET /api/v1/backtest/runs
  router.get("/api/v1/backtest/runs", async (c) => {
    // Self-healing: a run stuck in 'running' for more than 3 minutes almost certainly means
    // the Worker was killed mid-execution (its catch/finally never got to run), not that it's
    // still working — a full parallel-fetch run now finishes in well under a minute.
    await c.env.DB.prepare(
      `UPDATE backtest_runs SET status='failed', completed_at=?, error='Timed out — worker likely killed mid-run'
       WHERE status='running' AND started_at < ?`
    ).bind(Date.now(), Date.now() - 3 * 60 * 1000).run();

    const { results } = await c.env.DB.prepare(
      `SELECT * FROM backtest_runs ORDER BY started_at DESC LIMIT 50`
    ).all();
    return c.json(results.map(r => ({
      ...r,
      config:  r.config_json  ? JSON.parse(r.config_json  as string) : null,
      summary: r.summary_json ? JSON.parse(r.summary_json as string) : null,
    })));
  });

  // GET /api/v1/backtest/runs/:id
  router.get("/api/v1/backtest/runs/:id", async (c) => {
    const id = c.req.param("id");
    const run = await c.env.DB.prepare(`SELECT * FROM backtest_runs WHERE id=?`).bind(id).first();
    if (!run) return c.json({ error: "not found" }, 404);

    const { results: signals } = await c.env.DB.prepare(
      `SELECT * FROM bot_signals WHERE backtest_run_id = ? ORDER BY created_at ASC`
    ).bind(id).all();

    return c.json({
      ...run,
      config:  run.config_json  ? JSON.parse(run.config_json  as string) : null,
      summary: run.summary_json ? JSON.parse(run.summary_json as string) : null,
      trades:  signals.map(s => ({ ...s, reasons: JSON.parse(s.reasons_json as string) })),
    });
  });

  // POST /api/v1/backtest/prefetch — fetch & cache ONE pair synchronously.
  // UI calls this per-pair before running the backtest, so each call is fast.
  router.post("/api/v1/backtest/prefetch", async (c) => {
    const { pair, toMs, botType, botId } = await c.req.json<{ pair: string; fromMs: number; toMs: number; botType?: string; botId?: string }>();
    const resolvedType = botId ? (await getBot(c.env.DB, botId))?.type ?? botType : botType;
    if (!pair || !toMs) return c.json({ error: "pair, fromMs, toMs required" }, 400);

    const trading = await TradingService.tryConnect(c.env);
    if (!trading) return c.json({ error: "cTrader not connected" }, 502);

    const results: Record<string, string> = {};

    // Trendline bot needs 4H + daily (for bias filter); structure bot needs all three
    const timeframes: Array<"4H" | "D" | "W"> = resolvedType === "trendline" ? ["D", "4H"] : ["W", "D", "4H"];
    for (const timeframe of timeframes) {
      const cacheKey = trendbarCacheKey(pair, timeframe);
      const cached   = await c.env.KV.get(cacheKey, "json") as Array<{ timestamp: number }> | null;
      if (cached?.length) { results[timeframe] = "cached"; continue; }

      try {
        const { candles } = await fetchCandles(pair, timeframe, toMs, trading, c.env.KV);
        results[timeframe] = candles.length ? `ok_${candles.length}` : "empty";
      } catch (e) {
        results[timeframe] = `error: ${(e as Error).message}`;
      }
    }

    return c.json({ pair, results });
  });

  // DELETE /api/v1/backtest/runs/:id
  router.delete("/api/v1/backtest/runs/:id", async (c) => {
    const id = c.req.param("id");
    await c.env.DB.prepare(`DELETE FROM bot_signals WHERE backtest_run_id = ?`).bind(id).run();
    await c.env.DB.prepare(`DELETE FROM backtest_runs WHERE id=?`).bind(id).run();
    return c.json({ ok: true });
  });

  return router;
}
