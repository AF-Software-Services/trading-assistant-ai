import './style.css'
import { TradingChart } from './chart'
import { TradePanel } from './trade-panel'
import { getCandles, getAnalysis } from './api'
import type { AnalysisResult } from './api'

// ── State ─────────────────────────────────────────────────────────────────────
let activePair      = 'EUR/USD'
let activeTimeframe = '4H'
let chart: TradingChart
let tradePanel: TradePanel

// ── DOM helpers ───────────────────────────────────────────────────────────────
function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

function showChartLoading(show: boolean): void {
  el('chart-loading').classList.toggle('hidden', !show)
}

function showChartError(msg: string | null): void {
  const errEl = el('chart-error')
  if (msg) {
    el('chart-error-msg').textContent = msg
    errEl.classList.remove('hidden')
  } else {
    errEl.classList.add('hidden')
  }
}

function showAnalysisLoading(show: boolean): void {
  el('analysis-loading').classList.toggle('hidden', !show)
}

// ── Pair / TF buttons ─────────────────────────────────────────────────────────
function initPairButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('.pair-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pair-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      activePair = btn.dataset.pair!
      tradePanel.setPair(activePair)
      chart.setPair(activePair)
      loadAll()
    })
  })
}

function initTfButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      activeTimeframe = btn.dataset.tf!
      loadCandles()
    })
  })
}

// ── URL params (pre-select pair/TF from ?pair=GBP/USD&timeframe=4H) ───────────
function applyUrlParams(): void {
  const params = new URLSearchParams(window.location.search)
  const pair = params.get('pair')
  const tf   = params.get('timeframe')

  if (pair) {
    const btn = document.querySelector<HTMLButtonElement>(`.pair-btn[data-pair="${pair}"]`)
    if (btn) {
      document.querySelectorAll('.pair-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      activePair = pair
    }
  }

  if (tf) {
    const btn = document.querySelector<HTMLButtonElement>(`.tf-btn[data-tf="${tf}"]`)
    if (btn) {
      document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      activeTimeframe = tf
    }
  }
}

// ── Load candles ──────────────────────────────────────────────────────────────
async function loadCandles(): Promise<void> {
  showChartLoading(true)
  showChartError(null)

  try {
    const candles = await getCandles(activePair, activeTimeframe, 200)
    chart.applyCandles(candles)
  } catch (err) {
    showChartError(`Failed to load candles: ${(err as Error).message}`)
  } finally {
    showChartLoading(false)
  }
}

// ── Load analysis ─────────────────────────────────────────────────────────────
function updateAnalysisPanel(data: AnalysisResult): void {
  const trendMap: Record<string, string> = {
    uptrend:   '▲ UPTREND',
    downtrend: '▼ DOWNTREND',
    range:     '◆ RANGE',
  }

  const trendEl = el('an-trend')
  trendEl.textContent = trendMap[data.trend] ?? data.trend.toUpperCase()
  trendEl.className = 'value'
  if (data.trend === 'uptrend')   trendEl.classList.add('buy')
  if (data.trend === 'downtrend') trendEl.classList.add('sell')

  // Nearest resistance / support from zones
  const dec = activePair.includes('JPY') ? 3 : 5
  const resistanceZones = data.zones.filter(z => z.type === 'resistance').sort((a, b) => a.low - b.low)
  const supportZones    = data.zones.filter(z => z.type === 'support').sort((a, b) => b.high - a.high)

  el('an-resistance').textContent = resistanceZones[0]
    ? resistanceZones[0].low.toFixed(dec)
    : '—'
  el('an-support').textContent = supportZones[0]
    ? supportZones[0].high.toFixed(dec)
    : '—'

  const lastSig = data.signals[data.signals.length - 1]
  el('an-signal').textContent = lastSig
    ? `${lastSig.type} (${lastSig.confidence}%)`
    : '—'

  el('an-buy').textContent  = `${data.buyScore}/100`
  el('an-sell').textContent = `${data.sellScore}/100`
}

async function loadAnalysis(candles?: Awaited<ReturnType<typeof getCandles>>): Promise<void> {
  showAnalysisLoading(true)
  try {
    const data = await getAnalysis(activePair)
    updateAnalysisPanel(data)
    autoDirection(data)
    if (data.atr) chart.setSuggestedStop(data.atr)
    chart.applyZones(data.zones)
    if (data.structure?.swingPoints) {
      chart.applySwingPoints(data.structure.swingPoints)
    }
    // Use the candles already fetched (passed in) or fetch fresh if called standalone
    const candleData = candles ?? await getCandles(activePair, activeTimeframe, 200)
    chart.applySignals(data.signals, candleData)
    chart.applyPatterns(data.patterns ?? [])
  } catch (err) {
    // Analysis endpoint failing shouldn't break the chart — just clear panel
    el('an-trend').textContent      = 'Error'
    el('an-resistance').textContent = '—'
    el('an-support').textContent    = '—'
    el('an-signal').textContent     = '—'
    el('an-buy').textContent        = '—'
    el('an-sell').textContent       = '—'
  } finally {
    showAnalysisLoading(false)
  }
}

// ── Load everything ───────────────────────────────────────────────────────────
async function loadAll(): Promise<void> {
  // Load candles first, then pass them to analysis to avoid double-fetch
  showChartLoading(true)
  showChartError(null)
  let candles: Awaited<ReturnType<typeof getCandles>> | undefined
  try {
    candles = await getCandles(activePair, activeTimeframe, 200)
    chart.applyCandles(candles)
  } catch (err) {
    showChartError(`Failed to load candles: ${(err as Error).message}`)
  } finally {
    showChartLoading(false)
  }
  await loadAnalysis(candles)
}

// ── Direction toggle (BUY / SELL) ─────────────────────────────────────────────
function setDirection(dir: 'buy' | 'sell'): void {
  const buyBtn  = document.getElementById('dir-buy')  as HTMLButtonElement
  const sellBtn = document.getElementById('dir-sell') as HTMLButtonElement
  if (dir === 'buy') {
    buyBtn.classList.add('active')
    sellBtn.classList.remove('active')
  } else {
    sellBtn.classList.add('active')
    buyBtn.classList.remove('active')
  }
  chart.setDirection(dir)
}

function initDirectionToggle(): void {
  document.getElementById('dir-buy')?.addEventListener('click',  () => setDirection('buy'))
  document.getElementById('dir-sell')?.addEventListener('click', () => setDirection('sell'))
}

function autoDirection(data: AnalysisResult): void {
  const bullishTypes = new Set(['bullish_engulfing', 'hammer'])
  const bearishTypes = new Set(['bearish_engulfing', 'shooting_star'])

  // Check the last 5 signals for a recent engulfing candle
  const recent = data.signals.slice(-5)
  const latestBullish = [...recent].reverse().find(s => bullishTypes.has(s.type))
  const latestBearish = [...recent].reverse().find(s => bearishTypes.has(s.type))

  let dir: 'buy' | 'sell'

  if (latestBullish && latestBearish) {
    // Both present — most recent wins
    dir = latestBullish.timestamp >= latestBearish.timestamp ? 'buy' : 'sell'
  } else if (latestBullish) {
    // Bullish engulfing overrides trend → long
    dir = 'buy'
  } else if (latestBearish) {
    // Bearish engulfing overrides trend → short
    dir = 'sell'
  } else {
    // No recent signal — follow the trend
    dir = data.trend === 'downtrend' ? 'sell' : 'buy'
  }

  setDirection(dir)
}

// ── Overlay toggles ───────────────────────────────────────────────────────────
function initOverlayToggles(): void {
  const toggles: Array<{ id: string; fn: (v: boolean) => void }> = [
    { id: 'toggle-zones',     fn: v => chart.toggleZones(v) },
    { id: 'toggle-structure', fn: v => chart.toggleStructure(v) },
    { id: 'toggle-signals',   fn: v => chart.toggleSignals(v) },
    { id: 'toggle-patterns',  fn: v => chart.togglePatterns(v) },
  ]
  for (const { id, fn } of toggles) {
    document.getElementById(id)?.addEventListener('click', () => {
      const btn = document.getElementById(id) as HTMLButtonElement
      const active = btn.classList.toggle('active')
      btn.textContent = active ? 'ON' : 'OFF'
      fn(active)
    })
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
function init(): void {
  chart = new TradingChart('chart-container')
  tradePanel = new TradePanel()

  chart.setPair(activePair)
  tradePanel.setPair(activePair)

  chart.setOnTradeLinesChange(state => {
    tradePanel.update(state)
  })

  initPairButtons()
  initTfButtons()
  applyUrlParams()
  initDirectionToggle()
  initOverlayToggles()

  // Update pair/TF on chart after URL params applied
  chart.setPair(activePair)
  tradePanel.setPair(activePair)

  loadAll()
}

init()
