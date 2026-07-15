import { Hono } from "hono";

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  CTRADER_CLIENT_ID: string;
  CTRADER_CLIENT_SECRET: string;
  CTRADER_ACCOUNT_ID: string;
}

interface ClosedSignalRow {
  pair: string;
  outcome: "tp" | "sl" | "expired";
  close_time: number;
  pnl_pips: number | null;
  pnl_gbp: number | null;
}

interface PeriodStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnlGbp: number;
  pnlPips: number;
}

function emptyStats(): PeriodStats {
  return { trades: 0, wins: 0, losses: 0, winRate: 0, pnlGbp: 0, pnlPips: 0 };
}

function accumulate(stats: PeriodStats, row: ClosedSignalRow): void {
  stats.trades++;
  if (row.outcome === "tp") stats.wins++;
  else if (row.outcome === "sl") stats.losses++;
  stats.pnlGbp  += row.pnl_gbp  ?? 0;
  stats.pnlPips += row.pnl_pips ?? 0;
}

function finalize(stats: PeriodStats): PeriodStats {
  const decided = stats.wins + stats.losses;
  return {
    ...stats,
    winRate: decided > 0 ? Number((stats.wins / decided * 100).toFixed(1)) : 0,
    pnlGbp:  Number(stats.pnlGbp.toFixed(2)),
    pnlPips: Number(stats.pnlPips.toFixed(1)),
  };
}

export function createDashboardRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/api/v1/dashboard/summary", async (c) => {
    const now = new Date();
    const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    // The forex trading week runs Sunday evening (Sydney open) through Friday close, not the
    // ISO calendar week — so "this week" starts on the most recent Sunday, not Monday.
    const dow = now.getUTCDay(); // 0 = Sunday
    const startOfWeek = startOfToday - dow * 24 * 60 * 60 * 1000;
    const startOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const startOfYear  = Date.UTC(now.getUTCFullYear(), 0, 1);

    // Multi-account scoping: a signal's own row has no account_id — it's only knowable via
    // the bot that generated it, which is itself assigned to one account. When the caller
    // asks to scope by account (the Dashboard's Demo/Live split and per-account drill-down),
    // join through bots and only count signals whose bot has an account in the requested set.
    // Signals from an unassigned/unattributed bot are excluded once scoping is requested —
    // there's no way to say which account they belong to.
    const accountIdsParam = c.req.query("accountIds");
    const accountIds = accountIdsParam ? accountIdsParam.split(",").filter(Boolean) : null;

    // Note: monitor.ts flips status to "expired" for every closed position once it records
    // an outcome (win, loss, or genuinely expired) — status is a lifecycle marker, not a
    // result. Filtering on status='executed' here would exclude every real closed trade
    // except ones from before that behaviour existed, so we filter on outcome instead.
    const query = accountIds && accountIds.length > 0
      ? c.env.DB.prepare(
          `SELECT bs.pair, bs.outcome, bs.close_time, bs.pnl_pips, bs.pnl_gbp
           FROM bot_signals bs
           JOIN bots b ON bs.bot_id = b.id
           WHERE bs.source = 'live' AND bs.outcome IS NOT NULL AND bs.close_time IS NOT NULL
             AND b.account_id IN (${accountIds.map(() => "?").join(",")})
           ORDER BY bs.close_time DESC`
        ).bind(...accountIds)
      : c.env.DB.prepare(
          `SELECT pair, outcome, close_time, pnl_pips, pnl_gbp
           FROM bot_signals
           WHERE source = 'live' AND outcome IS NOT NULL AND close_time IS NOT NULL
           ORDER BY close_time DESC`
        );
    const { results } = await query.all<ClosedSignalRow>();

    const today = emptyStats();
    const week  = emptyStats();
    const month = emptyStats();
    const year  = emptyStats();
    const allTime = emptyStats();

    for (const row of results) {
      accumulate(allTime, row);
      if (row.close_time >= startOfYear)  accumulate(year, row);
      if (row.close_time >= startOfMonth) accumulate(month, row);
      if (row.close_time >= startOfWeek)  accumulate(week, row);
      if (row.close_time >= startOfToday) accumulate(today, row);
    }

    // Current streak (consecutive wins or losses, most recent first, ignoring expired)
    let streakType: "win" | "loss" | null = null;
    let streakCount = 0;
    for (const row of results) {
      if (row.outcome === "expired") continue;
      const type = row.outcome === "tp" ? "win" : "loss";
      if (streakType === null) { streakType = type; streakCount = 1; }
      else if (type === streakType) streakCount++;
      else break;
    }

    // Equity curve: cumulative realised P&L over time, oldest first
    let running = 0;
    const equityCurve = [...results]
      .reverse()
      .map(row => {
        running += row.pnl_gbp ?? 0;
        return { t: row.close_time, cum: Number(running.toFixed(2)) };
      });

    // Per-pair breakdown
    const byPairMap = new Map<string, PeriodStats>();
    for (const row of results) {
      const stats = byPairMap.get(row.pair) ?? emptyStats();
      accumulate(stats, row);
      byPairMap.set(row.pair, stats);
    }
    const byPair = Object.fromEntries(
      [...byPairMap.entries()]
        .map(([pair, stats]): [string, PeriodStats] => [pair, finalize(stats)])
        .sort((a, b) => b[1].pnlGbp - a[1].pnlGbp)
    );

    return c.json({
      periods: {
        today: finalize(today),
        week:  finalize(week),
        month: finalize(month),
        year:  finalize(year),
      },
      allTime: finalize(allTime),
      currentStreak: { type: streakType, count: streakCount },
      equityCurve,
      byPair,
    });
  });

  return app;
}
