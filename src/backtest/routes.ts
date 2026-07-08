import { Hono } from "hono";
import type { Env } from "../index.ts";
import { runTrendlineBacktest } from "./runner.ts";
import type { BacktestConfig, BacktestResult } from "./runner.ts";
import { getBotSettings, saveBotSignal } from "../bot/engine.ts";
import type { BotSignal } from "../bot/engine.ts";
import { getBot } from "../bot/bot-types.ts";

function generateUUID(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function buildSummary(signals: BotSignal[], diagnostics: Record<string, number> = {}, log: string[] = []) {
  // Only count executed trades in performance stats — rejected signals are ML data only
  const executed  = signals.filter(s => s.status === 'executed');
  const completed = executed.filter(s => s.outcome !== null);
  const rejected  = signals.filter(s => s.status === 'rejected').length;
  const wins   = completed.filter(s => s.outcome === "tp").length;
  const losses = completed.filter(s => s.outcome === "sl").length;
  const totalPnl = completed.reduce((sum, s) => sum + (s.pnlGbp ?? 0), 0);

  // Max drawdown — running cumulative PnL trough
  let peak = 0, cumPnl = 0, maxDrawdown = 0;
  for (const s of completed) {
    cumPnl += s.pnlGbp ?? 0;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Sharpe — simple ratio of mean / stdev of daily PnL
  const pnls = completed.map(s => s.pnlGbp ?? 0);
  const mean = pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
  const variance = pnls.length > 1
    ? pnls.reduce((sum, p) => sum + (p - mean) ** 2, 0) / (pnls.length - 1)
    : 0;
  const sharpe = variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : 0;

  // By-pair breakdown (executed only)
  const pairs = [...new Set(executed.map(s => s.pair))];
  const byPair: Record<string, { trades: number; wins: number; losses: number; pnlGbp: number }> = {};
  for (const pair of pairs) {
    const pt = completed.filter(s => s.pair === pair);
    byPair[pair] = {
      trades: pt.length,
      wins:   pt.filter(s => s.outcome === "tp").length,
      losses: pt.filter(s => s.outcome === "sl").length,
      pnlGbp: +pt.reduce((sum, s) => sum + (s.pnlGbp ?? 0), 0).toFixed(2),
    };
  }

  return {
    totalTrades: completed.length,
    wins,
    losses,
    winRate: completed.length > 0 ? +(wins / completed.length * 100).toFixed(1) : 0,
    totalPnl: +totalPnl.toFixed(2),
    maxDrawdown: +maxDrawdown.toFixed(2),
    sharpe: +sharpe.toFixed(2),
    byPair,
    diagnostics,
    rejectedSignals: rejected,
    log,
  };
}

export function createBacktestRouter() {
  const router = new Hono<{ Bindings: Env }>();

  // POST /api/v1/backtest/run
  router.post("/api/v1/backtest/run", async (c) => {
    const body = await c.req.json<Partial<BacktestConfig> & { pairs: string[]; fromMs: number; toMs: number; botId?: string }>();

    if (!body.pairs?.length || !body.fromMs || !body.toMs) {
      return c.json({ error: "pairs, fromMs, toMs are required" }, 400);
    }

    // Resolve bot instance settings — bot-level overrides system-level
    const [riskRaw, botSettings, botInstance] = await Promise.all([
      c.env.KV.get("user:risk_settings", "json") as Promise<Record<string, number> | null>,
      getBotSettings(c.env.KV),
      body.botId ? getBot(c.env.DB, body.botId) : Promise.resolve(null),
    ]);

    const botS           = botInstance?.settings ?? {};
    const accountBalance = body.accountBalance ?? riskRaw?.accountBalance ?? 10000;
    const riskPercent    = (botS["riskPercent"] as number | undefined) ?? 1;
    const rewardRisk     = (botS["rewardRisk"]  as number | undefined) ?? 2.5;
    const minScore       = (botS["minConfidenceScore"] as number | undefined) ?? botSettings.minConfidenceScore ?? 65;
    const pairs          = body.pairs;
    const { fromMs, toMs } = body;

    const runId = generateUUID();
    const startedAt = Date.now();

    await c.env.DB.prepare(
      `INSERT INTO backtest_runs (id, started_at, status, config_json) VALUES (?, ?, 'running', ?)`
    ).bind(runId, startedAt, JSON.stringify(body)).run();

    c.executionCtx.waitUntil((async () => {
      try {
        const { signals, diagnostics, log } = await runTrendlineBacktest(
          { pairs, fromMs, toMs, accountBalance, riskPercent, rewardRisk, minScore },
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
