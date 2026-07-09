import { Hono } from "hono";
import type { Env } from "../index.ts";
import { runTrendlineBacktest, buildSummary } from "./runner.ts";
import type { BacktestConfig, BacktestResult } from "./runner.ts";
import { saveBotSignal } from "../bot/engine.ts";
import { getBot } from "../bot/bot-types.ts";


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

    // Use the bot's exact settings — no fallbacks. A backtest must be identical to a live run.
    const accountBalance    = riskRaw?.accountBalance ?? 1000;
    const riskPercent       = botInstance.settings["riskPercent"]        as number;
    const rewardRisk        = botInstance.settings["rewardRisk"]         as number;
    const minScore          = botInstance.settings["minConfidenceScore"] as number;
    const maxOpenPositions  = botInstance.settings["maxOpenPositions"]   as number;
    const pairs          = body.pairs;
    const { fromMs, toMs } = body;

    const runId = crypto.randomUUID();
    const startedAt = Date.now();

    await c.env.DB.prepare(
      `INSERT INTO backtest_runs (id, started_at, status, config_json) VALUES (?, ?, 'running', ?)`
    ).bind(runId, startedAt, JSON.stringify(body)).run();

    c.executionCtx.waitUntil((async () => {
      try {
        const { signals, diagnostics, log } = await runTrendlineBacktest(
          { pairs, fromMs, toMs, accountBalance, riskPercent, rewardRisk, minScore, maxOpenPositions },
          c.env.TWELVE_DATA_API_KEY,
          (msg) => console.log(`[backtest ${runId}] ${msg}`),
          c.env.KV,
        );

        // Assign runId and save each signal through the bot engine's write path
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
    })());

    return c.json({ runId });
  });

  // GET /api/v1/backtest/runs
  router.get("/api/v1/backtest/runs", async (c) => {
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
  // UI calls this per-pair before running the backtest, so each call is fast (3 API requests).
  router.post("/api/v1/backtest/prefetch", async (c) => {
    const { pair, fromMs, toMs, botType, botId } = await c.req.json<{ pair: string; fromMs: number; toMs: number; botType?: string; botId?: string }>();
    const resolvedType = botId ? (await getBot(c.env.DB, botId))?.type ?? botType : botType;
    if (!pair || !fromMs || !toMs) return c.json({ error: "pair, fromMs, toMs required" }, 400);

    const lookbackMs = 200 * 7 * 24 * 60 * 60 * 1000;
    const fetchFrom  = new Date(fromMs - lookbackMs).toISOString().slice(0, 10);
    const fetchTo    = new Date(toMs).toISOString().slice(0, 10);
    const apiKey     = c.env.TWELVE_DATA_API_KEY;
    const kv         = c.env.KV;

    const results: Record<string, string> = {};

    // Trendline bot needs 4H + daily (for bias filter); structure bot needs all three
    const intervals = resolvedType === "trendline" ? ["1day", "4h"] : ["1week", "1day", "4h"];
    for (const interval of intervals) {
      const cacheKey = `candles_v2:${pair}:${interval}`;
      const cached   = await kv.get(cacheKey, "json") as Array<{ timestamp: number }> | null;
      const lookbackMs = 200 * 7 * 24 * 60 * 60 * 1000;
      const needFrom   = fromMs - lookbackMs;
      const lastTs  = cached?.length ? cached[cached.length - 1]!.timestamp : 0;
      const firstTs = cached?.length ? cached[0]!.timestamp : 0;
      // Cache valid only if it covers both the start (lookback) and end of the requested range
      if (cached?.length && lastTs >= toMs - 7 * 24 * 60 * 60 * 1000 && firstTs <= needFrom + 30 * 24 * 60 * 60 * 1000) {
        results[interval] = "cached"; continue;
      }

      // Fetch with retry on 429
      for (let attempt = 0; attempt < 3; attempt++) {
        const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=${interval}&start_date=${fetchFrom}&end_date=${fetchTo}&outputsize=5000&apikey=${apiKey}`;
        const res = await fetch(url);
        if (res.status === 429) {
          if (attempt < 2) { await new Promise(r => setTimeout(r, 15000)); continue; }
          results[interval] = "rate_limited"; break;
        }
        if (!res.ok) { results[interval] = `error_${res.status}`; break; }
        const data = await res.json() as { values?: Array<Record<string, string>>; message?: string };
        if (!data.values?.length) { results[interval] = "empty"; break; }
        // Convert to Candle[] before storing so fetchCandles can use it directly
        const tf = interval === "1day" ? "D" : interval === "1week" ? "W" : "4H";
        const candles = data.values.map(c => ({
          timestamp: new Date((c["datetime"]!).replace(" ", "T") + ((c["datetime"]!).includes(":") ? "Z" : "T00:00:00Z")).getTime(),
          open: parseFloat(c["open"]!), high: parseFloat(c["high"]!),
          low: parseFloat(c["low"]!),   close: parseFloat(c["close"]!),
          timeframe: tf, pair,
        })).sort((a, b) => a.timestamp - b.timestamp);
        await kv.put(cacheKey, JSON.stringify(candles), { expirationTtl: 86400 });
        results[interval] = `ok_${data.values.length}`;
        // Small pause between intervals within a pair to be polite to the API
        if (interval !== "4h") await new Promise(r => setTimeout(r, 500));
        break;
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
