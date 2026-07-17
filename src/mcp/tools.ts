import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CurrencyPair, Timeframe } from "../types/market.ts";
import { PHASE1_PAIRS, ALL_TRADEABLE_PAIRS } from "../types/market.ts";
import { createMarketDataProvider } from "../providers/factory.ts";
import { calculateATR } from "../engines/trend.ts";
import { detectTrendlineSignal, getDailyBias, detectTrendlineOverlays } from "../engines/trendline.ts";
import { fetchNewsForPair } from "../providers/news.ts";
import {
  createJournalEntry,
  updateJournalOutcome,
  getJournalEntries,
  getJournalStats,
  buildFeaturesFromContext,
} from "../storage/journal.ts";
import {
  getBotSignals,
  updateBotSignalStatus,
  executeSignal,
  runBotScan,
} from "../bot/engine.ts";
import { listBots, updateBot } from "../bot/bot-types.ts";
import type { BotInstance } from "../bot/bot-types.ts";
import { TradingService } from "../trading/service.ts";
import { getPrimaryAccountBalance } from "../ctrader/account-types.ts";

// Re-export Env shape expected by tools
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
  MARKET_DATA_PROVIDER: string;
  CTRADER_CLIENT_ID: string;
  CTRADER_CLIENT_SECRET: string;
  CTRADER_ACCOUNT_ID: string;
}


function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function json(data: unknown) {
  return text(JSON.stringify(data, null, 2));
}

const PAIR_ENUM = z.enum(ALL_TRADEABLE_PAIRS as [CurrencyPair, ...CurrencyPair[]]);

// Candle data now rides on a live cTrader connection rather than an independent data
// vendor, so it can't be built once at registration time — connect fresh per tool call.
async function getProvider(env: Env) {
  const trading = await TradingService.tryConnect(env);
  if (!trading) throw new Error("cTrader not connected");
  return createMarketDataProvider({ provider: env.MARKET_DATA_PROVIDER, trading });
}

export function registerTools(server: McpServer, env: Env): void {

  // ── 1. analyse_pair ─────────────────────────────────────────────────────────
  server.tool(
    "analyse_pair",
    "Analyse a currency pair using the trendline bot strategy: detects 4H trendline break+retest setups with daily bias filter. Returns a live signal if conditions are met — identical logic to what the live bot and backtests use. Position sizing uses the real connected cTrader account balance.",
    {
      pair:        PAIR_ENUM,
      riskPercent: z.number().min(0.1).max(10).optional().describe("Override only — normally read from saved settings"),
      rewardRisk:  z.number().min(1).max(10).optional().describe("Override only — normally read from saved settings"),
    },
    async ({ pair, riskPercent, rewardRisk }) => {
      const [savedSettings, resolvedBalance] = await Promise.all([
        env.KV.get("user:risk_settings", "json") as Promise<{ riskPercent?: number; rewardRisk?: number } | null>,
        getPrimaryAccountBalance(env.DB),
      ]);
      const resolvedRiskPct = riskPercent    ?? savedSettings?.riskPercent;
      const rrRatio         = rewardRisk     ?? savedSettings?.rewardRisk ?? 3.0;
      const riskAmount      = resolvedBalance && resolvedRiskPct
        ? resolvedBalance * (resolvedRiskPct / 100) : undefined;

      const provider = await getProvider(env);
      const [candles4H, candlesD, tick] = await Promise.all([
        provider.getCandles(pair as CurrencyPair, "4H",   200),
        provider.getCandles(pair as CurrencyPair, "D",     30),
        provider.getLatestPrice(pair as CurrencyPair),
      ]);

      const atr4H      = calculateATR(candles4H);
      const dailyBias  = getDailyBias(candlesD);
      const tlSignal   = detectTrendlineSignal(candles4H, rrRatio, 5, candlesD);
      const tlOverlays = detectTrendlineOverlays(candles4H);

      const lots = tlSignal && riskAmount
        ? Math.floor((riskAmount / (Math.abs(tlSignal.entryPrice - tlSignal.stopLoss) * (pair.includes("JPY") ? 1000 : 100000))) * 100) / 100
        : null;

      const status = tlSignal
        ? `SIGNAL: ${tlSignal.direction.toUpperCase()} @ ${tlSignal.entryPrice} (score ${tlSignal.score})`
        : `No signal — daily bias: ${dailyBias}`;

      return json({
        pair,
        currentPrice: tick.mid,
        atr:          +atr4H.toFixed(5),
        analysedAt:   new Date().toISOString(),
        status,
        dailyBias,
        signal: tlSignal ? {
          direction:   tlSignal.direction,
          entryPrice:  tlSignal.entryPrice,
          stopLoss:    tlSignal.stopLoss,
          takeProfit:  tlSignal.takeProfit,
          lots,
          score:       tlSignal.score,
          reasons:     tlSignal.reasons,
          actionLine:  tlSignal.actionLine,
          safetyLine:  tlSignal.safetyLine,
          breakIndex:  tlSignal.breakIndex,
          retestIndex: tlSignal.retestIndex,
        } : null,
        trendlineOverlays: tlOverlays,
        riskSettings: {
          accountBalance: resolvedBalance ?? null,
          riskPercent:    resolvedRiskPct ?? null,
          maxRiskAmount:  riskAmount ?? null,
          rewardRisk:     rrRatio,
          warning: !resolvedBalance
            ? "No connected cTrader account with a known balance — connect an account in the Accounts tab."
            : !resolvedRiskPct
            ? "No risk % saved — call set_risk_settings to enable position sizing."
            : null,
        },
      });
    }
  );

  // ── 2. get_risk_settings ─────────────────────────────────────────────────────
  server.tool(
    "get_risk_settings",
    "Read the user's current risk settings: real connected cTrader account balance, risk per trade %, and minimum R:R ratio. Call this if you need to know the user's current settings without running a full analysis.",
    {},
    async () => {
      const [settings, accountBalance] = await Promise.all([
        env.KV.get("user:risk_settings", "json") as Promise<{ riskPercent?: number; rewardRisk?: number } | null>,
        getPrimaryAccountBalance(env.DB),
      ]);
      const riskPercent = settings?.riskPercent ?? null;
      const rewardRisk  = settings?.rewardRisk  ?? 1.2;
      const maxRisk = accountBalance && riskPercent
        ? accountBalance * (riskPercent / 100) : null;
      return json({
        configured: accountBalance != null && riskPercent != null,
        accountBalance,
        riskPercent,
        rewardRisk,
        maxRiskPerTrade: maxRisk,
        summary: maxRisk
          ? `Account £${accountBalance?.toLocaleString()}, risking ${riskPercent}% (£${maxRisk.toFixed(2)}) per trade, min R:R ${rewardRisk}`
          : !accountBalance
          ? "No connected cTrader account with a known balance — connect an account in the Accounts tab."
          : "No risk % saved — call set_risk_settings.",
      });
    }
  );

  // ── 3. set_risk_settings ─────────────────────────────────────────────────────
  server.tool(
    "set_risk_settings",
    "Save the user's risk per trade % and minimum R:R ratio, applied to all future analyses. Account balance is not settable — it's always read live from the connected cTrader account. Only saves fields that are provided — omit a field to leave it unchanged.",
    {
      riskPercent: z.number().min(0.1).max(10).optional().describe("Risk per trade as % of account"),
      rewardRisk:  z.number().min(1).max(10).optional().describe("Minimum R:R ratio (default 1.2)"),
    },
    async ({ riskPercent, rewardRisk }) => {
      const existing = await env.KV.get("user:risk_settings", "json") as
        { riskPercent?: number; rewardRisk?: number } | null ?? {};
      const updated = {
        ...existing,
        ...(riskPercent !== undefined && { riskPercent }),
        ...(rewardRisk  !== undefined && { rewardRisk }),
      };
      await env.KV.put("user:risk_settings", JSON.stringify(updated));
      const accountBalance = await getPrimaryAccountBalance(env.DB);
      const maxRisk = accountBalance && updated.riskPercent
        ? accountBalance * (updated.riskPercent / 100) : null;
      return json({
        saved: true,
        settings: { ...updated, accountBalance },
        maxRiskPerTrade: maxRisk,
        summary: maxRisk
          ? `Saved: ${updated.riskPercent}% risk on account £${accountBalance?.toLocaleString()} = £${maxRisk.toFixed(2)} per trade, R:R ${updated.rewardRisk ?? 1.2}`
          : "Saved risk %, but no connected account balance yet — connect an account in the Accounts tab to enable position sizing.",
      });
    }
  );



  // ── 14. open_chart ───────────────────────────────────────────────────────────
  server.tool(
    "open_chart",
    "Return a URL to open the trading chart UI for a specific pair and timeframe, along with a brief analysis summary.",
    {
      pair:      PAIR_ENUM.optional().default("EUR/USD"),
      timeframe: z.enum(["1H", "4H", "D", "W"]).optional().default("1H"),
    },
    async ({ pair, timeframe }) => {
      const p  = (pair      ?? "EUR/USD") as CurrencyPair;
      const tf = (timeframe ?? "1H")      as Timeframe;

      const encodedPair = encodeURIComponent(p);
      const chartUrl = `https://trading-assistant-ai.andrew-dobson.workers.dev/?pair=${encodedPair}&timeframe=${tf}`;

      const provider = await getProvider(env);
      const [candles4H, candlesD] = await Promise.all([
        provider.getCandles(p, "4H",   200),
        provider.getCandles(p, "D",     30),
      ]);
      const dailyBias = getDailyBias(candlesD);
      const tlSignal  = detectTrendlineSignal(candles4H, 3.0, 5, candlesD);

      const lines = [
        `Chart URL: ${chartUrl}`,
        ``,
        `=== ${p} — Trendline Analysis ===`,
        `Daily Bias: ${dailyBias.toUpperCase()}`,
        tlSignal
          ? `Signal: ${tlSignal.direction.toUpperCase()} @ ${tlSignal.entryPrice} | SL ${tlSignal.stopLoss} | TP ${tlSignal.takeProfit} (score ${tlSignal.score})`
          : `No trendline signal — waiting for break+retest setup`,
        ``,
        `Open the chart link above to view candlesticks and trendline overlays.`,
      ];

      return text(lines.join("\n"));
    }
  );

  // ── 15. get_news ─────────────────────────────────────────────────────────────
  server.tool(
    "get_news",
    "Get recent news headlines and sentiment for a currency pair, pulled from DailyFX and ForexLive RSS feeds. Cached 1 hour. Use this to provide fundamental context alongside technical analysis — upcoming central bank decisions, economic data releases, and macro themes affecting the pair.",
    {
      pair: z.enum(PHASE1_PAIRS as [CurrencyPair, ...CurrencyPair[]]).describe("Currency pair"),
    },
    async ({ pair }) => {
      const news = await fetchNewsForPair(pair, env.KV);
      const sentimentLine = `Overall news sentiment for ${pair}: ${news.sentiment.overall.toUpperCase()} (${news.sentiment.bullish} bullish, ${news.sentiment.bearish} bearish, ${news.sentiment.neutral} neutral across ${news.items.length} headlines).`;
      const headlines = news.items.map((item, i) => {
        const ago = item.pubDate
          ? (() => {
              const ms = Date.now() - new Date(item.pubDate).getTime();
              const h = Math.floor(ms / 3_600_000);
              const d = Math.floor(h / 24);
              return d > 0 ? `${d}d ago` : h > 0 ? `${h}h ago` : "< 1h ago";
            })()
          : "";
        return `${i + 1}. [${item.sentiment.toUpperCase()}] ${item.title} (${item.source}${ago ? `, ${ago}` : ""})`;
      }).join("\n");
      return json({
        pair,
        sentimentSummary: sentimentLine,
        sentiment: news.sentiment,
        headlines: news.items.map(i => ({
          title: i.title,
          source: i.source,
          pubDate: i.pubDate,
          sentiment: i.sentiment,
          link: i.link,
          description: i.description,
        })),
        formattedHeadlines: headlines,
        cachedAt: news.cachedAt,
        note: "News is cached for 1 hour. Sentiment is derived from keywords in headlines — treat as a rough directional guide, not a precise score.",
      });
    }
  );

  // ── 16. log_trade ────────────────────────────────────────────────────────────
  server.tool(
    "log_trade",
    "Record a trade entry in the journal with full ML feature capture. Call this when the user confirms they are taking a trade. Captures signal context, zone data, timing, and candle snapshots automatically. Returns the journal entry ID for later outcome tracking.",
    {
      pair:             PAIR_ENUM,
      direction:        z.enum(["buy", "sell"]),
      entryPrice:       z.number().describe("Actual entry price"),
      stopLoss:         z.number().describe("Stop loss price"),
      target:           z.number().describe("Take profit / target price"),
      timeframe:        z.string().optional().describe("Entry timeframe e.g. 4H, D"),
      confidence:       z.number().min(0).max(100).optional().describe("Signal confidence 0-100"),
      recommendationId: z.string().optional().describe("ID from analyse_pair if available"),
      notes:            z.string().optional(),
      // Feature context from analysis
      mtfScore:         z.number().optional(),
      mtfAligned:       z.boolean().optional(),
      signalType:       z.string().optional(),
      signalConfidence: z.number().optional(),
      zoneStrength:     z.number().optional(),
      zoneType:         z.string().optional(),
      zoneTimeframe:    z.string().optional(),
      aoiConfirmed:     z.boolean().optional(),
      rrRatio:          z.number().optional(),
      atrPips:          z.number().optional(),
      stopPips:         z.number().optional(),
      swingStructure:   z.string().optional(),
      trendStrength:    z.number().optional(),
      newsSentiment:    z.string().optional(),
      newsCount:        z.number().optional(),
      totalScore:       z.number().optional(),
    },
    async ({
      pair, direction, entryPrice, stopLoss, target, timeframe,
      confidence, recommendationId, notes,
      ...featureCtx
    }) => {
      // Fetch recent candles for snapshot
      let candles4h: Array<{ open: number; high: number; low: number; close: number }> = [];
      let candlesD:  Array<{ open: number; high: number; low: number; close: number }> = [];
      try {
        const provider = await getProvider(env);
        const raw4h = await provider.getCandles(pair, "4H", 20);
        const rawD  = await provider.getCandles(pair, "D", 10);
        candles4h = raw4h.map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close }));
        candlesD  = rawD.map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close }));
      } catch { /* candle snapshot is best-effort */ }

      const features = buildFeaturesFromContext({ ...featureCtx, candles4h, candlesD });
      const now = new Date();

      const id = await createJournalEntry(env.DB, {
        recommendationId: recommendationId ?? null,
        pair,
        direction,
        timeframe: timeframe ?? "4H",
        entryPrice,
        stopLoss,
        target,
        confidence: confidence ?? features.totalScore,
        session: features.session,
        dayOfWeek: now.getUTCDay(),
        features,
        notes: notes ?? null,
        createdAt: Date.now(),
      });

      const pipFactor = pair.includes("JPY") ? 100 : 10000;
      const stopPipsCalc = Math.abs(entryPrice - stopLoss) * pipFactor;
      const tpPipsCalc   = Math.abs(target - entryPrice)  * pipFactor;
      const rr           = stopPipsCalc > 0 ? tpPipsCalc / stopPipsCalc : 0;

      return text(
        `Trade logged successfully.\n\n` +
        `Journal ID: ${id}\n` +
        `Pair: ${pair} | Direction: ${direction.toUpperCase()}\n` +
        `Entry: ${entryPrice} | SL: ${stopLoss} | TP: ${target}\n` +
        `Stop: ${stopPipsCalc.toFixed(1)} pips | R:R ${rr.toFixed(2)}\n` +
        `Session: ${features.session} | Day: ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][now.getUTCDay()]}\n\n` +
        `When the trade closes, call update_trade_outcome with ID: ${id}`
      );
    }
  );

  // ── 17. update_trade_outcome ──────────────────────────────────────────────────
  server.tool(
    "update_trade_outcome",
    "Record the outcome of a completed trade. Call this when the user reports a trade closed — hit TP (win), hit SL (loss), or closed at breakeven. Automatically calculates pips P&L and actual R:R achieved.",
    {
      journalId: z.string().describe("Journal entry ID from log_trade"),
      result:    z.enum(["win", "loss", "breakeven"]),
      exitPrice: z.number().describe("Price at which the trade was closed"),
      notes:     z.string().optional().describe("What happened — e.g. 'TP1 hit, closed manually'"),
    },
    async ({ journalId, result, exitPrice, notes }) => {
      try {
        await updateJournalOutcome(env.DB, journalId, { result, exitPrice, notes });
      } catch (e) {
        return text(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }

      const entry = (await getJournalEntries(env.DB, { limit: 1 })).find(e => e.id === journalId);
      const pnl = entry?.pnlPips ?? 0;
      const rr  = entry?.rrAchieved ?? 0;

      const emoji = result === "win" ? "✅" : result === "loss" ? "❌" : "⚖️";
      return text(
        `${emoji} Trade outcome recorded.\n\n` +
        `Result: ${result.toUpperCase()}\n` +
        `Exit: ${exitPrice}\n` +
        `P&L: ${pnl > 0 ? "+" : ""}${pnl.toFixed(1)} pips\n` +
        `R:R achieved: ${rr.toFixed(2)}\n\n` +
        `This data is now part of your ML training set. Keep logging every trade to improve signal quality over time.`
      );
    }
  );

  // ── 18. get_journal_stats ─────────────────────────────────────────────────────
  server.tool(
    "get_journal_stats",
    "Get aggregated performance statistics from the trade journal. Shows win rate, average R:R achieved vs targeted, P&L in pips, and breakdowns by pair, signal type, session, and day of week. Use this to identify which setups and market conditions produce the best results.",
    {},
    async () => {
      const stats = await getJournalStats(env.DB);

      if (stats.totalTrades === 0) {
        return text("No trades logged yet. Use log_trade to start building your ML dataset.");
      }

      const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
      const fmt = (n: number) => (n * 100).toFixed(1) + "%";

      const pairLines = Object.entries(stats.byPair)
        .sort((a, b) => b[1].trades - a[1].trades)
        .map(([p, s]) => `  ${p}: ${s.trades} trades, ${fmt(s.winRate)} win rate`).join("\n");

      const sigLines = Object.entries(stats.bySignal)
        .sort((a, b) => b[1].trades - a[1].trades)
        .map(([s, v]) => `  ${s}: ${v.trades} trades, ${fmt(v.winRate)} win rate`).join("\n");

      const sessLines = Object.entries(stats.bySession)
        .sort((a, b) => b[1].trades - a[1].trades)
        .map(([s, v]) => `  ${s}: ${v.trades} trades, ${fmt(v.winRate)} win rate`).join("\n");

      const dayLines = Object.entries(stats.byDayOfWeek)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([d, v]) => `  ${dow[Number(d)]}: ${v.trades} trades, ${fmt(v.winRate)} win rate`).join("\n");

      return text(
        `TRADE JOURNAL STATISTICS\n${"─".repeat(40)}\n\n` +
        `Total trades logged : ${stats.totalTrades}\n` +
        `Completed trades    : ${stats.completedTrades}\n` +
        `Open trades         : ${stats.totalTrades - stats.completedTrades}\n\n` +
        `OUTCOMES\n` +
        `  Wins      : ${stats.wins}\n` +
        `  Losses    : ${stats.losses}\n` +
        `  Breakeven : ${stats.breakevens}\n` +
        `  Win rate  : ${fmt(stats.winRate)}\n\n` +
        `R:R  Targeted: ${stats.avgRrTargeted.toFixed(2)}  |  Achieved: ${stats.avgRrAchieved.toFixed(2)}\n` +
        `Total P&L   : ${stats.totalPnlPips > 0 ? "+" : ""}${stats.totalPnlPips.toFixed(1)} pips\n\n` +
        `BY PAIR\n${pairLines}\n\n` +
        `BY SIGNAL TYPE\n${sigLines}\n\n` +
        `BY SESSION\n${sessLines}\n\n` +
        `BY DAY OF WEEK\n${dayLines}`
      );
    }
  );

  // ── 19. set_bot_mode ─────────────────────────────────────────────────────────
  server.tool(
    "set_bot_mode",
    "Set a trading bot's mode. 'off' = no automatic trading. 'approval' = bot finds setups and queues them for your review — you approve each trade before it executes. 'autonomous' = bot executes qualifying setups automatically without asking. This operates on your real bot(s) from the Bot tab — the same ones the live cron job runs. If you have more than one bot, pass botId (use get_bot_status to see IDs); with exactly one bot configured, botId can be omitted.",
    {
      mode:             z.enum(["off", "approval", "autonomous"]),
      botId:            z.string().optional().describe("Bot ID (or its first 8 chars) to target — required only if you have more than one bot"),
      minScore:         z.number().min(0).max(100).optional().describe("Minimum signal confidence score to act on"),
      maxOpenPositions: z.number().min(1).max(10).optional().describe("Max concurrent open positions"),
      pairs:            z.array(PAIR_ENUM).optional().describe("Pairs this bot trades — omit or empty for all tradeable pairs"),
    },
    async ({ mode, botId, minScore, maxOpenPositions, pairs }) => {
      const bots = await listBots(env.DB);
      if (bots.length === 0) {
        return text("No bots configured yet — create one in the Bot tab first.");
      }

      let target: BotInstance;
      if (botId) {
        const found = bots.find(b => b.id === botId || b.id.startsWith(botId));
        if (!found) {
          return text(`No bot found with ID starting with "${botId}". Your bots:\n` +
            bots.map(b => `  ${b.name} — ${b.id}`).join("\n"));
        }
        target = found;
      } else if (bots.length === 1) {
        target = bots[0]!;
      } else {
        return text(`You have ${bots.length} bots — pass botId to target one specifically:\n` +
          bots.map(b => `  ${b.name} [${b.mode}] — ${b.id}`).join("\n"));
      }

      const newSettings: Record<string, unknown> = { ...target.settings };
      if (minScore !== undefined) newSettings.minConfidenceScore = minScore;
      if (maxOpenPositions !== undefined) newSettings.maxOpenPositions = maxOpenPositions;

      const updated = await updateBot(env.DB, target.id, {
        mode,
        settings: newSettings,
        ...(pairs !== undefined ? { pairs: pairs as CurrencyPair[] } : {}),
      });
      if (!updated) return text(`Bot ${target.id} was not found when saving — it may have been deleted.`);

      const warnings: string[] = [];
      if (mode === "autonomous") {
        warnings.push("⚠ AUTONOMOUS mode enabled — this bot will execute trades without asking you.");
        warnings.push("Make sure risk settings and account assignment are correct in the Bot tab.");
        warnings.push(`Use set_bot_mode with mode='off' and botId='${updated.id.slice(0, 8)}' to stop it at any time.`);
      }

      return text(
        `Bot "${updated.name}" mode set to: ${mode.toUpperCase()}\n\n` +
        `Settings:\n` +
        `  Min confidence score : ${updated.settings.minConfidenceScore ?? "—"}\n` +
        `  Max open positions   : ${updated.settings.maxOpenPositions ?? "—"}\n` +
        `  Account              : ${updated.accountId ?? "none assigned"}\n` +
        `  Active pairs         : ${updated.pairs.length > 0 ? updated.pairs.join(", ") : "All 6 pairs"}\n\n` +
        (warnings.length > 0 ? warnings.join("\n") : "Bot is ready.")
      );
    }
  );

  // ── 20. get_bot_status ────────────────────────────────────────────────────────
  server.tool(
    "get_bot_status",
    "Get your real configured bot(s) — mode, settings, and account — plus signals awaiting approval and recent activity. 'Pending signals' here means setups queued for your review (approval mode only); a bot set to autonomous skips that queue and tries to execute immediately, so it won't show anything here even while it has a live order sitting unfilled at the broker.",
    {},
    async () => {
      const [bots, pending, recent] = await Promise.all([
        listBots(env.DB),
        getBotSignals(env.DB, { status: "pending", limit: 10 }),
        getBotSignals(env.DB, { limit: 5, source: "live" }),
      ]);
      const token = await env.KV.get("ctrader:access_token");

      const botLines = bots.map(b =>
        `  ${b.name} [${b.type}] — ${b.id}\n` +
        `    Mode: ${b.mode.toUpperCase()} | Account: ${b.accountId ?? "none assigned"} | Pairs: ${b.pairs.length > 0 ? b.pairs.join(", ") : "all 6"}\n` +
        `    Min confidence: ${b.settings.minConfidenceScore ?? "—"} | Max open positions: ${b.settings.maxOpenPositions ?? "—"}`
      ).join("\n\n");

      const pendingLines = pending.map(s =>
        `  [${s.id.slice(0, 8)}] ${s.pair} ${s.direction.toUpperCase()} @ ${s.entryPrice} | Score: ${s.score.toFixed(0)} | Lots: ${s.lots}\n` +
        `    SL: ${s.stopLoss} | TP: ${s.takeProfit} | Expires: ${new Date(s.expiresAt).toUTCString()}\n` +
        `    ${s.reasons.slice(0, 2).join("; ")}`
      ).join("\n\n");

      const recentLines = recent.map(s =>
        `  ${s.pair} ${s.direction.toUpperCase()} — ${s.status.toUpperCase()} @ ${new Date(s.createdAt).toUTCString()}`
      ).join("\n");

      return text(
        `BOT STATUS\n${"─".repeat(40)}\n` +
        `cTrader: ${token ? "Connected" : "Not connected"}\n\n` +
        `BOTS (${bots.length}):\n${botLines || "  No bots configured — create one in the Bot tab."}\n\n` +
        (pending.length > 0
          ? `PENDING SIGNALS (${pending.length}) — use approve_signal or reject_signal:\n${pendingLines}\n\n`
          : `No pending signals.\n\n`) +
        `RECENT ACTIVITY:\n${recentLines || "  None"}`
      );
    }
  );

  // ── 21. approve_signal ────────────────────────────────────────────────────────
  server.tool(
    "approve_signal",
    "Approve a pending bot signal and execute the trade on cTrader. Use get_bot_status to see pending signal IDs.",
    {
      signalId: z.string().describe("Signal ID from get_bot_status (first 8 chars are enough)"),
    },
    async ({ signalId }) => {
      // Find the signal (allow partial ID match)
      const pending = await getBotSignals(env.DB, { status: "pending", limit: 20 });
      const signal  = pending.find(s => s.id.startsWith(signalId) || s.id === signalId);
      if (!signal) return text(`No pending signal found with ID starting with: ${signalId}`);

      if (signal.expiresAt < Date.now()) {
        await updateBotSignalStatus(env.DB, signal.id, "expired");
        return text(`Signal ${signalId} has expired — run a new scan to get fresh setups.`);
      }

      let trading: TradingService;
      try {
        trading = await TradingService.connect(env);
      } catch {
        return text("cTrader is not connected. Go to the trading app and connect first.");
      }

      await updateBotSignalStatus(env.DB, signal.id, "approved");

      try {
        await executeSignal(signal, env.DB, env.KV, trading);

        const pipFactor = signal.pair.includes("JPY") ? 100 : 10000;
        const stopPips  = Math.abs(signal.entryPrice - signal.stopLoss) * pipFactor;
        const tpPips    = Math.abs(signal.takeProfit - signal.entryPrice) * pipFactor;
        const rr        = stopPips > 0 ? tpPips / stopPips : 0;

        return text(
          `✅ Trade executed on cTrader!\n\n` +
          `${signal.pair} ${signal.direction.toUpperCase()}\n` +
          `Entry  : ${signal.entryPrice}\n` +
          `SL     : ${signal.stopLoss}  (${stopPips.toFixed(1)} pips)\n` +
          `TP     : ${signal.takeProfit}  (${tpPips.toFixed(1)} pips)\n` +
          `Lots   : ${signal.lots}\n` +
          `R:R    : ${rr.toFixed(2)}\n` +
          `Score  : ${signal.score.toFixed(0)}\n\n` +
          `Trade has been logged to the journal. When it closes, use update_trade_outcome to record the result.`
        );
      } catch (e) {
        await updateBotSignalStatus(env.DB, signal.id, "failed", {
          errorMessage: (e as Error).message,
        });
        return text(`❌ Execution failed: ${(e as Error).message}`);
      }
    }
  );

  // ── 22. reject_signal ─────────────────────────────────────────────────────────
  server.tool(
    "reject_signal",
    "Reject a pending bot signal — it will not be executed.",
    {
      signalId: z.string().describe("Signal ID from get_bot_status"),
      reason:   z.string().optional().describe("Why you're rejecting this setup"),
    },
    async ({ signalId, reason }) => {
      const pending = await getBotSignals(env.DB, { status: "pending", limit: 20 });
      const signal  = pending.find(s => s.id.startsWith(signalId) || s.id === signalId);
      if (!signal) return text(`No pending signal found with ID: ${signalId}`);

      await updateBotSignalStatus(env.DB, signal.id, "rejected", {
        rejectionReason: reason ?? "Manually rejected",
      });

      return text(`Signal ${signalId} (${signal.pair} ${signal.direction}) rejected.${reason ? ` Reason: ${reason}` : ""}`);
    }
  );

  // ── 23. run_bot_scan ──────────────────────────────────────────────────────────
  server.tool(
    "run_bot_scan",
    "Trigger an immediate scan for every active (non-off) bot, using each bot's own real configured settings and account — the same as clicking 'Scan All' in the Bot tab. In approval mode this queues qualifying setups for review. In autonomous mode it executes them immediately for real, using real account balance and risk settings.",
    {},
    async () => {
      const bots = await listBots(env.DB);
      const activeBots = bots.filter(b => b.mode !== "off");
      if (activeBots.length === 0) {
        return text(bots.length === 0
          ? "No bots configured yet — create one in the Bot tab first."
          : "All bots are set to OFF — nothing to scan. Use set_bot_mode to activate one.");
      }

      let totalFound = 0, totalQueued = 0, totalExecuted = 0, totalFailed = 0;
      const perBotLines: string[] = [];

      for (const bot of activeBots) {
        try {
          const result = await runBotScan({
            DB:                    env.DB,
            KV:                    env.KV,
            MARKET_DATA_PROVIDER:  env.MARKET_DATA_PROVIDER,
            CTRADER_CLIENT_ID:     env.CTRADER_CLIENT_ID,
            CTRADER_CLIENT_SECRET: env.CTRADER_CLIENT_SECRET,
            CTRADER_ACCOUNT_ID:    env.CTRADER_ACCOUNT_ID,
            botInstance:           bot,
          });
          totalFound    += result.signalsFound;
          totalQueued   += result.signalsQueued;
          totalExecuted += result.signalsExecuted;
          totalFailed   += result.signalsFailed;
          perBotLines.push(
            `  ${bot.name} [${bot.mode}]: ${result.pairsScanned} pairs scanned, ${result.signalsFound} found, ` +
            `${result.signalsQueued} queued, ${result.signalsExecuted} executed, ${result.signalsFailed} failed` +
            (result.errors.length > 0 ? `\n    ${result.errors.join("; ")}` : "")
          );
        } catch (e) {
          perBotLines.push(`  ${bot.name}: ERROR — ${(e as Error).message}`);
        }
      }

      return text(
        `BOT SCAN COMPLETE\n${"─".repeat(30)}\n` +
        `Totals — found: ${totalFound} | queued: ${totalQueued} | executed: ${totalExecuted} | failed: ${totalFailed}\n\n` +
        perBotLines.join("\n\n")
      );
    }
  );

}

