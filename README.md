# Trading Assistant AI

A Cloudflare Workers service that analyses Forex price action and generates
structured trade recommendations. It exposes both a REST API and an MCP
(Model Context Protocol) server so Claude (and other AI agents) can query it
directly as a tool.

> **Disclaimer** — This project is for educational and research purposes only.
> It does not constitute financial advice. All trade recommendations are
> generated algorithmically and must be verified on a charting platform before
> execution. Never risk money you cannot afford to lose.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Worker                            │
│                                                                 │
│  ┌─────────────┐   ┌───────────────┐   ┌───────────────────┐  │
│  │  MCP Server │   │  REST API     │   │  Cron Scheduler   │  │
│  │  /mcp       │   │  /api/v1/*    │   │  (5 × weekday)    │  │
│  └──────┬──────┘   └───────┬───────┘   └─────────┬─────────┘  │
│         └──────────────────┼──────────────────────┘            │
│                            ▼                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Engine Layer                         │   │
│  │  market-structure  support-resistance  candlestick      │   │
│  │  trend  trade-scoring  risk  recommendation             │   │
│  │  trade-management  analytics                            │   │
│  └─────────────────────────┬───────────────────────────────┘   │
│                            │                                    │
│  ┌──────────────┐  ┌───────┴──────────┐  ┌────────────────┐   │
│  │  Market Data │  │  Storage (D1/KV) │  │  Config (KV)   │   │
│  │  Provider    │  │                  │  │                │   │
│  └──────────────┘  └──────────────────┘  └────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Module Descriptions

| Module | Purpose |
|--------|---------|
| `src/engines/market-structure.ts` | Detect swing highs/lows, label HH/HL/LH/LL, classify trend |
| `src/engines/support-resistance.ts` | Group pivots into zones, score by timeframe/touches/age |
| `src/engines/candlestick.ts` | Detect bullish/bearish engulfing patterns |
| `src/engines/pattern.ts` | Chart pattern scaffold (v2: H&S, double top/bottom) |
| `src/engines/trend.ts` | Calculate EMA(9/21/50), ATR(14), assess momentum |
| `src/engines/trade-scoring.ts` | Score setups 0–100 across 7 weighted components |
| `src/engines/risk.ts` | Position sizing, pip value, R:R validation |
| `src/engines/recommendation.ts` | Orchestrate all engines into a Recommendation |
| `src/engines/trade-management.ts` | Review open trades for exits/stop moves |
| `src/engines/analytics.ts` | Query D1 for performance statistics |
| `src/providers/mock.ts` | Seeded deterministic OHLC data for development |
| `src/providers/live.ts` | Placeholder for real broker integration |
| `src/storage/d1.ts` | Typed D1 prepared statement wrappers |
| `src/storage/kv.ts` | Typed KV getters/setters with TTL support |
| `src/mcp/server.ts` | MCP server + StreamableHTTP transport |
| `src/mcp/tools.ts` | 14 MCP tool definitions |
| `src/api/routes.ts` | Hono REST router mirroring all MCP tools |
| `src/scheduler/cron.ts` | Cron trigger handler (5 sessions per weekday) |

---

## Setup

### Prerequisites

- Node.js 20+
- Wrangler CLI (`npm install -g wrangler`)
- Cloudflare account

### 1. Clone and install

```bash
git clone <your-repo>
cd trading-assistant-ai
npm install
```

### 2. Create D1 database

```bash
wrangler d1 create trading-assistant-ai
```

Copy the `database_id` from the output and update `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "trading-assistant-ai"
database_id = "<your-database-id>"
```

Apply the schema:

```bash
wrangler d1 execute trading-assistant-ai --file ./schema/d1.sql
```

### 3. Create KV namespace

```bash
wrangler kv:namespace create KV
```

Copy the `id` and update `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KV"
id = "<your-kv-id>"
```

Optionally seed the config:

```bash
wrangler kv:key put --binding KV app_config "$(cat kv-config-example.json | jq -c '.value')"
```

### 4. Deploy

```bash
npm run deploy
```

---

## Development Workflow

### Local dev server

```bash
npm run dev
```

Wrangler spins up a local Worker with D1 and KV stubs. The MCP server and
REST API both work locally.

### Run tests

```bash
npm test           # run once
npm run test:watch # watch mode
```

### Type check

```bash
npm run type-check
```

---

## MCP Server Connection

Add the deployed Worker as an MCP server in your Claude config:

```json
{
  "mcpServers": {
    "trading-assistant": {
      "url": "https://trading-assistant-ai.<your-subdomain>.workers.dev/mcp"
    }
  }
}
```

Or for local development:

```json
{
  "mcpServers": {
    "trading-assistant-local": {
      "url": "http://localhost:8787/mcp"
    }
  }
}
```

Once connected, Claude can call tools like:

- `analyse_pair` — full analysis of a single pair
- `get_trade_recommendations` — current open recommendations
- `explain_signal` — detailed reasoning for a recommendation
- `run_scheduled_scan` — trigger a fresh scan of all 6 pairs

---

## REST API Reference

Base URL: `https://trading-assistant-ai.<subdomain>.workers.dev/api/v1`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/pairs` | List all Phase 1 pairs |
| POST | `/analyse/:pair` | Full analysis for one pair |
| POST | `/analyse` | Full analysis for all pairs |
| GET | `/structure/:pair` | Market structure (trend, swings) |
| GET | `/zones/:pair` | Support/resistance zones |
| GET | `/signals/:pair` | Recent candlestick signals |
| GET | `/patterns/:pair` | Chart patterns (v2 placeholder) |
| GET | `/recommendations` | All open recommendations |
| GET | `/recommendations/:id` | Single recommendation |
| GET | `/recommendations/:id/explain` | Full explanation with reasoning |
| POST | `/recommendations/:id/review` | Trigger management review |
| POST | `/recommendations/:id/close` | Close a recommendation |
| GET | `/history` | Historical recommendations (filterable) |
| GET | `/statistics` | Strategy and pair performance stats |
| POST | `/scan` | Run a full scan and persist results |

### Query Parameters

`GET /history` supports:
- `pair` — filter by pair (e.g. `EUR/USD`)
- `direction` — `buy` or `sell`
- `min_confidence` — integer 0–100
- `limit` — max results (default 50)

`GET /zones/:pair` and `/signals/:pair` support:
- `timeframe` — `1H`, `4H`, `D`, or `W`

---

## Configuration Guide

### KV app_config

The `app_config` key controls runtime behaviour. See `kv-config-example.json`:

```json
{
  "provider": "mock",
  "accountSize": 10000,
  "maxLossPerTrade": 100,
  "maxOpenRecommendations": 3,
  "maxTotalOpenRisk": 300,
  "minRewardRisk": 3.0,
  "minConfidenceScore": 75,
  "enabledPairs": ["EUR/USD", "GBP/USD", "GBP/CAD", "USD/JPY", "EUR/GBP", "AUD/USD"],
  "sessionTimezone": "Europe/London"
}
```

Update live config without redeploying:

```bash
wrangler kv:key put --binding KV app_config '{"provider":"mock",...}'
```

### wrangler.toml vars

| Var | Default | Description |
|-----|---------|-------------|
| `ENVIRONMENT` | `production` | `production` or `development` |
| `MARKET_DATA_PROVIDER` | `mock` | `mock` (only supported in v1) |

---

## How to Add a New Market Data Provider

1. Create `src/providers/your-provider.ts` implementing the `MarketDataProvider` interface:

```typescript
import type { MarketDataProvider } from "./interface.ts";

export class YourProvider implements MarketDataProvider {
  async getCandles(pair, timeframe, count) { ... }
  async getLatestPrice(pair) { ... }
}
```

2. Add a case in `src/providers/factory.ts`:

```typescript
case "yourprovider":
  return new YourProvider({ apiKey: env.YOUR_API_KEY });
```

3. Add the API key as a secret:

```bash
wrangler secret put YOUR_API_KEY
```

4. Set `MARKET_DATA_PROVIDER = "yourprovider"` in `wrangler.toml` or KV config.

Compatible providers: OANDA v20 REST, Twelve Data, Alpha Vantage, Polygon.io.

---

## Cron Schedule

Five cron triggers fire on weekdays (UTC):

| Cron | Session | Purpose |
|------|---------|---------|
| `0 7 * * 1-5` | `london_open_prep` | Pre-London session scan |
| `0 10 * * 1-5` | `early_session_review` | Mid-morning review |
| `0 14 * * 1-5` | `us_session_prep` | Pre-US open scan |
| `0 17 * * 1-5` | `trade_management_review` | Afternoon management |
| `0 21 * * 1-5` | `daily_candle_review` | End-of-day daily candle check |

Each trigger:
1. Generates recommendations for all 6 pairs
2. Reviews open recommendations for exit signals
3. Caches analysis in KV (1-hour TTL)
4. Persists signals and zones to D1
5. Records the scan run in `scan_runs`

---

## TradingView Workflow

This project is designed to augment — not replace — your manual analysis:

1. **AI generates the watchlist** — run `analyse_all_pairs` or wait for a cron trigger. Pairs with `consider_trade` action go on your watchlist.

2. **TradingView for visual confirmation** — open each pair on TradingView. Confirm:
   - The S/R zone exists and is clearly visible on the chart
   - The candlestick signal looks clean (not a doji or near-miss)
   - Higher timeframe structure agrees

3. **Broker for execution** — once visually confirmed, set the order in your broker platform with the stop and target from the recommendation's `explain` output.

4. **AI for management** — use `get_open_recommendations` or `review_recommendation` to get management suggestions during the trading day.

---

## Next Steps — v2 Roadmap

- **Live data provider** — integrate OANDA v20 REST API
- **Pattern detection** — implement double top/bottom and H&S with a multi-bar state machine
- **Multi-timeframe confluence** — score setups across W/D/4H simultaneously
- **Trade journal UI** — simple HTML dashboard served from the Worker
- **Telegram/email alerts** — push notifications when `consider_trade` is generated
- **Backtesting engine** — replay historical signals against stored zone data
- **Position tracking** — link journal entries to recommendations with P&L tracking
- **Additional pairs** — Phase 2: USD/CAD, NZD/USD, USD/CHF, GBP/JPY
