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
let accountBalance  = parseFloat(localStorage.getItem('risk_balance') ?? '10000')
// These are local defaults for the manual trade calculator only — bots use their own per-bot settings
const riskPercent  = 1.0
const rewardRisk   = 2.5
let defaultSlPips  = 50
let tradeDirection: 'buy' | 'sell' = 'buy'

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

function initChartTypeButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-ct]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-ct]').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      chart.setChartType(btn.dataset.ct as 'candle_solid' | 'area')
    })
  })
}

function initTfButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('#tf-buttons .tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tf-buttons .tf-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      activeTimeframe = btn.dataset.tf!
      syncMobileTf(activeTimeframe)
      loadAll()
    })
  })
}

function syncMobileTf(tf: string): void {
  document.querySelectorAll<HTMLButtonElement>('.mobile-tf-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tf === tf)
  })
}

function initMobile(): void {
  const sidebar  = document.getElementById('sidebar')!
  const overlay  = document.getElementById('sidebar-overlay')!
  const menuBtn  = document.getElementById('mobile-menu-btn')
  const pairDisp = document.getElementById('mobile-pair-display')

  function openSidebar(): void {
    sidebar.classList.add('open')
    overlay.classList.add('visible')
  }
  function closeSidebar(): void {
    sidebar.classList.remove('open')
    overlay.classList.remove('visible')
  }

  menuBtn?.addEventListener('click', openSidebar)
  overlay.addEventListener('click', closeSidebar)

  // Close sidebar when a pair is selected (mobile UX)
  document.querySelectorAll<HTMLButtonElement>('.pair-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (pairDisp) pairDisp.textContent = btn.dataset.pair ?? ''
      closeSidebar()
    })
  })

  // Mobile TF buttons mirror sidebar TF buttons
  document.querySelectorAll<HTMLButtonElement>('.mobile-tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tf-buttons .tf-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tf === btn.dataset.tf)
      })
      document.querySelectorAll('.mobile-tf-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      activeTimeframe = btn.dataset.tf!
      loadAll()
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
    const data = await getAnalysis(activePair, activeTimeframe, { accountBalance, riskPercent, rewardRisk })
    updateAnalysisPanel(data)
    autoDirection(data)
    if (data.atr) chart.setSuggestedStop(data.atr)
    if (data.htfZones) chart.setHtfZones(data.htfZones)
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
  await Promise.all([loadAnalysis(candles), loadNews(activePair)])
}

// ── News panel ────────────────────────────────────────────────────────────────
interface NewsItem {
  title: string
  link: string
  pubDate: string
  source: string
  sentiment: 'bullish' | 'bearish' | 'neutral'
  description: string
}

interface PairNews {
  pair: string
  items: NewsItem[]
  cachedAt: number
  sentiment: { bullish: number; bearish: number; neutral: number; overall: 'bullish' | 'bearish' | 'neutral' }
}

function timeAgo(dateStr: string): string {
  if (!dateStr) return ''
  const ms = Date.now() - new Date(dateStr).getTime()
  const h  = Math.floor(ms / 3_600_000)
  const d  = Math.floor(h / 24)
  if (d > 0)  return `${d}d ago`
  if (h > 0)  return `${h}h ago`
  const m = Math.floor(ms / 60_000)
  return m > 0 ? `${m}m ago` : '< 1m ago'
}

async function loadNews(pair: string): Promise<void> {
  const loading = el('news-loading')
  const errorEl = el('news-error')
  const emptyEl = el('news-empty')
  const listEl  = el('news-list')
  const badge   = el('news-sentiment-badge')

  loading.classList.remove('hidden')
  errorEl.classList.add('hidden')
  emptyEl.classList.add('hidden')
  listEl.innerHTML = ''
  badge.classList.add('hidden')

  try {
    const res = await fetch(`/api/v1/news/${encodeURIComponent(pair)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const news = await res.json() as PairNews

    loading.classList.add('hidden')

    if (!news.items || news.items.length === 0) {
      emptyEl.classList.remove('hidden')
      return
    }

    // Update sentiment badge
    badge.textContent = news.sentiment.overall.toUpperCase()
    badge.className = `news-badge ${news.sentiment.overall}`
    badge.classList.remove('hidden')

    // Render headlines
    listEl.innerHTML = news.items.map(item => `
      <a class="news-item" href="${item.link || '#'}" target="_blank" rel="noopener noreferrer">
        <div class="news-item-title">${escapeHtml(item.title)}</div>
        <div class="news-item-meta">
          <span class="news-item-source">${escapeHtml(item.source)}</span>
          ${item.pubDate ? `<span class="news-item-dot">·</span><span class="news-item-age">${timeAgo(item.pubDate)}</span>` : ''}
          <span class="news-sentiment-tag ${item.sentiment}">${item.sentiment.toUpperCase()}</span>
        </div>
      </a>
    `).join('')
  } catch (err) {
    loading.classList.add('hidden')
    errorEl.textContent = `News unavailable: ${(err as Error).message}`
    errorEl.classList.remove('hidden')
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function initNews(): void {
  el('news-refresh-btn').addEventListener('click', () => loadNews(activePair))
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

// ── Drawing tools ─────────────────────────────────────────────────────────────
function initDrawingTools(): void {
  const hint = document.getElementById('draw-hint')!

  const setDrawMode = (active: boolean) => {
    document.querySelectorAll('.draw-tool-btn').forEach(b => b.classList.remove('active'))
    hint.classList.toggle('hidden', !active)
  }

  document.getElementById('draw-support')?.addEventListener('click', () => {
    chart.startDrawSR('support')
    document.getElementById('draw-support')!.classList.add('active')
    hint.textContent = 'Click chart to place support line'
    hint.classList.remove('hidden')
  })

  document.getElementById('draw-resistance')?.addEventListener('click', () => {
    chart.startDrawSR('resistance')
    document.getElementById('draw-resistance')!.classList.add('active')
    hint.textContent = 'Click chart to place resistance line'
    hint.classList.remove('hidden')
  })

  document.getElementById('draw-long')?.addEventListener('click', () => {
    chart.placeTradeSetup('buy')
  })

  document.getElementById('draw-short')?.addEventListener('click', () => {
    chart.placeTradeSetup('sell')
  })

  document.getElementById('draw-clear')?.addEventListener('click', () => {
    chart.clearUserDrawings()
    chart.cancelDraw()
    setDrawMode(false)
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      chart.cancelDraw()
      setDrawMode(false)
    }
  })
}

// ── Overlay toggles ───────────────────────────────────────────────────────────
function initOverlayToggles(): void {
  const toggles: Array<{ id: string; fn: (v: boolean) => void }> = [
    { id: 'toggle-zones',      fn: v => chart.toggleZones(v) },
    { id: 'toggle-structure',  fn: v => chart.toggleStructure(v) },
    { id: 'toggle-signals',    fn: v => chart.toggleSignals(v) },
    { id: 'toggle-patterns',   fn: v => chart.togglePatterns(v) },
{ id: 'toggle-trade',      fn: v => chart.toggleTradeLines(v) },
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

// ── Tab switching ─────────────────────────────────────────────────────────────
function initTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
      document.querySelectorAll('.tab-panel').forEach(p => {
        p.classList.remove('active')
        p.classList.add('hidden')
      })
      btn.classList.add('active')
      const panel = document.getElementById(`tab-${btn.dataset.tab}`)!
      panel.classList.remove('hidden')
      panel.classList.add('active')
      if (btn.dataset.tab === 'positions') loadPositions()
      if (btn.dataset.tab === 'history')   loadHistory()
      if (btn.dataset.tab === 'news')      loadNews(activePair)
    })
  })
}

// ── cTrader status ────────────────────────────────────────────────────────────
let tradeOrderType: 'market' | 'limit' = 'market'

async function checkCTraderStatus(): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/ctrader/status')
    const data = await res.json() as { connected: boolean }
    const dot        = document.getElementById('ctrader-status-dot')!
    const txt        = document.getElementById('ctrader-status-text')!
    const connectBtn = document.getElementById('ctrader-connect-btn')!
    const disconnBtn = document.getElementById('ctrader-disconnect-btn')!
    const exec       = document.getElementById('execute-trade-btn')!
    if (data.connected) {
      dot.className   = 'status-dot connected'
      txt.textContent = 'Connected (Demo)'
      connectBtn.textContent = '✓ Connected'
      connectBtn.classList.add('connected')
      disconnBtn.classList.remove('hidden')
      exec.classList.remove('hidden')
    } else {
      dot.className   = 'status-dot disconnected'
      txt.textContent = 'Not connected'
      connectBtn.textContent = 'Connect cTrader'
      connectBtn.classList.remove('connected')
      disconnBtn.classList.add('hidden')
      exec.classList.add('hidden')
    }
    return data.connected
  } catch { return false }
}

function initCTrader(): void {
  document.getElementById('ctrader-connect-btn')?.addEventListener('click', () => {
    window.location.href = '/auth/ctrader'
  })

  document.getElementById('ctrader-disconnect-btn')?.addEventListener('click', async () => {
    await fetch('/api/v1/ctrader/disconnect', { method: 'POST' })
    document.getElementById('ctrader-trade-form')?.classList.add('hidden')
    document.getElementById('ctrader-positions-panel')?.classList.add('hidden')
    await checkCTraderStatus()
    window.location.href = '/auth/ctrader'
  })

  document.getElementById('execute-trade-btn')?.addEventListener('click', showExecuteModal)

  if (new URLSearchParams(window.location.search).get('ctrader') === 'connected') {
    history.replaceState({}, '', '/')
  }
  checkCTraderStatus().then(connected => {
    if (connected) showCTraderConnectedUI()
  })

  // Market / Limit toggle
  const marketBtn   = document.getElementById('trade-type-market')!
  const limitBtn    = document.getElementById('trade-type-limit')!
  const entryLabel  = document.getElementById('trade-entry-label')!
  const entryInput  = document.getElementById('trade-entry') as HTMLInputElement
  const setOrderType = (type: 'market' | 'limit') => {
    tradeOrderType = type
    marketBtn.classList.toggle('trade-type-active', type === 'market')
    limitBtn.classList.toggle('trade-type-active',  type === 'limit')
    if (type === 'market') {
      entryLabel.childNodes[0].textContent = 'Entry Price (Market) '
      entryInput.placeholder = 'fetched at execution'
      entryInput.readOnly = true
      entryInput.value = ''
    } else {
      entryLabel.childNodes[0].textContent = 'Limit Price '
      entryInput.placeholder = 'limit price'
      entryInput.readOnly = false
    }
    const slEl = document.getElementById('trade-sl') as HTMLInputElement
    const tpEl = document.getElementById('trade-tp') as HTMLInputElement
    slEl.dataset.auto = 'true'; slEl.value = ''
    tpEl.dataset.auto = 'true'; tpEl.value = ''
    updateTradeSizing()
  }
  marketBtn.addEventListener('click', () => setOrderType('market'))
  limitBtn.addEventListener('click',  () => setOrderType('limit'))
  setOrderType('market') // default

  // Direction toggle
  const dirBuyBtn  = document.getElementById('trade-dir-buy')!
  const dirSellBtn = document.getElementById('trade-dir-sell')!
  const submitBtn  = document.getElementById('trade-submit-btn')
  const setDir = (dir: 'buy' | 'sell') => {
    tradeDirection = dir
    dirBuyBtn.classList.toggle('trade-dir-active', dir === 'buy')
    dirSellBtn.classList.toggle('trade-dir-active', dir === 'sell')
    submitBtn?.classList.toggle('sell-mode', dir === 'sell')
    submitBtn!.textContent = dir === 'buy' ? '▲ Place Buy' : '▼ Place Sell'
    const slEl = document.getElementById('trade-sl') as HTMLInputElement
    const tpEl = document.getElementById('trade-tp') as HTMLInputElement
    slEl.dataset.auto = 'true'; slEl.value = ''
    tpEl.dataset.auto = 'true'; tpEl.value = ''
    updateTradeSizing()
  }
  dirBuyBtn.addEventListener('click',  () => setDir('buy'))
  dirSellBtn.addEventListener('click', () => setDir('sell'))

  document.getElementById('trade-submit-btn')?.addEventListener('click', () => placeManualTrade(tradeDirection))
  document.getElementById('ctrader-positions-refresh')?.addEventListener('click', loadCTraderPositions)
  ;['trade-entry', 'trade-pair'].forEach(id =>
    document.getElementById(id)?.addEventListener('input', updateTradeSizing)
  )
  const slEl2 = document.getElementById('trade-sl') as HTMLInputElement
  slEl2?.addEventListener('input', () => { slEl2.dataset.auto = 'false'; updateTradeSizing() })
  const tpEl2 = document.getElementById('trade-tp') as HTMLInputElement
  tpEl2?.addEventListener('input', () => { tpEl2.dataset.auto = 'false'; updateTradeSizing() })
}

function showCTraderConnectedUI(): void {
  document.getElementById('ctrader-trade-form')?.classList.remove('hidden')
  document.getElementById('ctrader-positions-panel')?.classList.remove('hidden')
  const btn = document.getElementById('trade-submit-btn')
  if (btn) btn.textContent = '▲ Place Buy'
  loadCTraderPositions()
}

async function loadCTraderPositions(): Promise<void> {
  const list = document.getElementById('ctrader-positions-list')!
  list.innerHTML = '<span class="panel-status">Loading…</span>'
  try {
    const res  = await fetch('/api/v1/ctrader/positions')
    const data = await res.json() as { positions: { positionId: number; symbol: string; direction: string; volume: number; openPrice: number }[] }
    if (!data.positions.length) { list.innerHTML = '<span class="panel-status">No open positions</span>'; return }
    list.innerHTML = data.positions.map(p => `
      <div class="position-row">
        <span class="pos-symbol">${p.symbol}</span>
        <span class="pos-dir ${p.direction}">${p.direction.toUpperCase()}</span>
        <span class="pos-vol">${(p.volume / 100000).toFixed(2)} lots</span>
        <span class="pos-price">@ ${p.openPrice.toFixed(5)}</span>
        <button class="small-btn close-pos-btn" data-id="${p.positionId}" data-vol="${p.volume}">Close</button>
      </div>`).join('')
    list.querySelectorAll('.close-pos-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id  = Number((btn as HTMLElement).dataset.id)
        const vol = Number((btn as HTMLElement).dataset.vol)
        if (!confirm(`Close position #${id}?`)) return
        btn.textContent = '…'
        await fetch(`/api/v1/ctrader/positions/${id}/close`, { method: 'POST' })
        loadCTraderPositions()
      })
    })
  } catch (e) {
    list.innerHTML = `<span class="panel-status error">${(e as Error).message}</span>`
  }
}

// Pip value per standard lot in account currency (GBP approx)
function pipValuePerLot(pair: string): number {
  // For pairs where USD is quote: pip = $10/lot ≈ £8 at 0.80 GBPUSD
  // Simplified: use £8 for non-JPY, £0.08 for JPY (100-pip = 1 unit)
  return pair.includes('JPY') ? 8 : 8
}

function calcLots(entry: number, sl: number, riskGbp: number, pair: string): number {
  const pipSize   = pair.includes('JPY') ? 0.01 : 0.0001
  const pips      = Math.abs(entry - sl) / pipSize
  if (pips === 0) return 0
  const lots = riskGbp / (pips * pipValuePerLot(pair))
  return Math.max(0.01, Math.round(lots * 100) / 100)
}

function updateTradeSizing(): void {
  const pair    = (document.getElementById('trade-pair')  as HTMLSelectElement).value
  const entry   = parseFloat((document.getElementById('trade-entry') as HTMLInputElement).value)
  const slEl    = document.getElementById('trade-sl')    as HTMLInputElement
  const tpEl    = document.getElementById('trade-tp')    as HTMLInputElement
  const sizing  = document.getElementById('trade-sizing')!

  if (!entry) { sizing.classList.add('hidden'); return }

  const pipSize = pair.includes('JPY') ? 0.01 : 0.0001
  const dec     = pair.includes('JPY') ? 3 : 5

  const isBuy = tradeDirection === 'buy'

  // Auto-fill SL based on selected direction
  if (!slEl.value || slEl.dataset.auto === 'true') {
    slEl.value = isBuy
      ? (entry - defaultSlPips * pipSize).toFixed(dec)
      : (entry + defaultSlPips * pipSize).toFixed(dec)
    slEl.dataset.auto = 'true'
  }

  const sl     = parseFloat(slEl.value)
  const slPips = Math.abs(entry - sl) / pipSize

  // Auto-fill TP from R:R
  const autoTp = isBuy
    ? entry + slPips * rewardRisk * pipSize
    : entry - slPips * rewardRisk * pipSize
  if (!tpEl.value || tpEl.dataset.auto === 'true') {
    tpEl.value = autoTp.toFixed(dec)
    tpEl.dataset.auto = 'true'
  }

  const tp      = parseFloat(tpEl.value)
  const tpPips  = Math.abs(tp - entry) / pipSize
  const rr      = (tpPips / slPips).toFixed(1)
  const riskGbp = accountBalance * (riskPercent / 100)
  const lots    = calcLots(entry, sl, riskGbp, pair)

  const profit = tpPips * pipValuePerLot(pair) * lots

  document.getElementById('trade-sizing-lots')!.textContent  = `${lots.toFixed(2)} lots`
  document.getElementById('trade-sizing-risk')!.textContent  = `£${riskGbp.toFixed(0)} risk · ${slPips.toFixed(1)} pip SL`
  document.getElementById('trade-sizing-rr')!.textContent    = `R:R ${rr} · +£${profit.toFixed(0)} if TP hit`
  sizing.classList.remove('hidden')
}

async function placeManualTrade(direction: 'buy' | 'sell'): Promise<void> {
  const pair    = (document.getElementById('trade-pair') as HTMLSelectElement).value
  const slVal   = (document.getElementById('trade-sl')   as HTMLInputElement).value
  const tpVal   = (document.getElementById('trade-tp')   as HTMLInputElement).value
  const result  = document.getElementById('trade-result')!

  result.className = 'trade-result'
  result.textContent = tradeOrderType === 'market' ? 'Fetching price…' : 'Placing order…'
  result.classList.remove('hidden')

  let entry: number
  if (tradeOrderType === 'market') {
    // Fetch live price for market orders
    try {
      const r = await fetch(`/api/v1/price/${encodeURIComponent(pair)}`)
      const d = await r.json() as { mid?: number }
      entry = d.mid ?? 0
      if (!entry) throw new Error('Could not fetch live price')
      // Auto-fill SL/TP if not set
      const pipSize = pair.includes('JPY') ? 0.01 : 0.0001
      const defaultSlPips = 50
      const sl = document.getElementById('trade-sl') as HTMLInputElement
      const tp = document.getElementById('trade-tp') as HTMLInputElement
      if (!slVal) {
        sl.value = (direction === 'buy' ? entry - defaultSlPips * pipSize : entry + defaultSlPips * pipSize).toFixed(pair.includes('JPY') ? 3 : 5)
      }
      if (!tpVal) {
        const slPrice = parseFloat(sl.value)
        const slDist  = Math.abs(entry - slPrice)
        tp.value = (direction === 'buy' ? entry + slDist * rewardRisk : entry - slDist * rewardRisk).toFixed(pair.includes('JPY') ? 3 : 5)
      }
      updateTradeSizing()
    } catch (e) {
      result.className = 'trade-result error'
      result.textContent = `Price fetch failed: ${(e as Error).message}`
      return
    }
  } else {
    entry = parseFloat((document.getElementById('trade-entry') as HTMLInputElement).value)
    if (!entry) {
      result.className = 'trade-result error'
      result.textContent = 'Enter a limit price'
      return
    }
  }

  const slFinal = parseFloat((document.getElementById('trade-sl') as HTMLInputElement).value)
  const tpFinal = parseFloat((document.getElementById('trade-tp') as HTMLInputElement).value)
  const lots = (entry && slFinal)
    ? calcLots(entry, slFinal, accountBalance * (riskPercent / 100), pair)
    : 0.01

  result.textContent = 'Placing order…'

  try {
    const body: Record<string, unknown> = { pair, direction, lots, orderType: tradeOrderType }
    if (tradeOrderType === 'limit') body.limitPrice = entry
    if (slFinal) body.stopLoss   = slFinal
    if (tpFinal) body.takeProfit = tpFinal
    const res  = await fetch('/api/v1/ctrader/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const data = await res.json() as { success?: boolean; error?: string }
    if (data.success) {
      result.className = 'trade-result success'
      result.textContent = `✓ ${tradeOrderType.toUpperCase()} ${direction.toUpperCase()} ${lots.toFixed(2)} lots ${pair} placed`
      // Market orders take a moment to appear on cTrader's side — wait before refreshing
      await new Promise(r => setTimeout(r, tradeOrderType === 'market' ? 2000 : 500))
      loadCTraderPositions()
    } else {
      result.className = 'trade-result error'
      result.textContent = `Error: ${data.error}`
    }
  } catch (e) {
    result.className = 'trade-result error'
    result.textContent = (e as Error).message
  }
}

// ── Execute trade modal ───────────────────────────────────────────────────────
function showExecuteModal(): void {
  const state = (window as any).__tradeState as {
    entry: number; sl: number; tp: number; lots: number; direction: string
  } | undefined
  if (!state) return

  const dec = activePair.includes('JPY') ? 3 : 5
  el('m-pair').textContent = activePair
  el('m-dir').textContent  = state.direction.toUpperCase()
  el('m-lots').textContent = state.lots.toFixed(2)
  el('m-sl').textContent   = state.sl.toFixed(dec)
  el('m-tp').textContent   = state.tp.toFixed(dec)
  el('execute-modal').classList.remove('hidden')
}

function initExecuteModal(): void {
  el('modal-cancel').addEventListener('click', () => {
    el('execute-modal').classList.add('hidden')
  })
  el('modal-confirm').addEventListener('click', async () => {
    const state = (window as any).__tradeState as {
      entry: number; sl: number; tp: number; lots: number; direction: 'buy' | 'sell'
    }
    el('modal-confirm').textContent = 'Placing…'
    el('modal-confirm').setAttribute('disabled', 'true')
    try {
      const res = await fetch('/api/v1/ctrader/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair:       activePair,
          direction:  state.direction,
          lots:       state.lots,
          stopLoss:   state.sl,
          takeProfit: state.tp,
        }),
      })
      const data = await res.json() as { success?: boolean; error?: string }
      if (data.success) {
        el('execute-modal').classList.add('hidden')
        alert('Order placed successfully on cTrader demo account.')
      } else {
        alert(`Order failed: ${data.error}`)
      }
    } catch (e) {
      alert(`Error: ${(e as Error).message}`)
    } finally {
      el('modal-confirm').textContent = 'Place Order'
      el('modal-confirm').removeAttribute('disabled')
    }
  })
}

// ── Positions ─────────────────────────────────────────────────────────────────
interface PositionRow {
  positionId: number; symbol: string; direction: string;
  volume: number; openPrice: number; stopLoss?: number; takeProfit?: number; openTime: number;
}

async function loadPositions(): Promise<void> {
  el('positions-loading').classList.remove('hidden')
  el('positions-error').classList.add('hidden')
  el('positions-empty').classList.add('hidden')
  el('positions-table').classList.add('hidden')

  try {
    const res  = await fetch('/api/v1/ctrader/positions')
    const data = await res.json() as { positions?: PositionRow[]; error?: string }
    if (data.error) throw new Error(data.error)

    const positions = data.positions ?? []
    if (positions.length === 0) {
      el('positions-empty').classList.remove('hidden')
      return
    }

    const tbody = el<HTMLTableSectionElement>('positions-body')
    tbody.innerHTML = positions.map(p => {
      const lots = (p.volume / 100000).toFixed(2)
      const dec  = p.symbol.includes('JPY') ? 3 : 5
      const dir  = p.direction === 'buy' ? 'buy' : 'sell'
      const date = p.openTime ? new Date(p.openTime).toLocaleDateString('en-GB') : '—'
      return `<tr>
        <td>${p.symbol}</td>
        <td class="${dir}">${dir.toUpperCase()}</td>
        <td>${lots}</td>
        <td>${p.openPrice.toFixed(dec)}</td>
        <td>${p.stopLoss  ? p.stopLoss.toFixed(dec)  : '—'}</td>
        <td>${p.takeProfit ? p.takeProfit.toFixed(dec) : '—'}</td>
        <td>${date}</td>
        <td><button class="close-btn" data-id="${p.positionId}" data-vol="${p.volume}">Close</button></td>
      </tr>`
    }).join('')

    tbody.querySelectorAll<HTMLButtonElement>('.close-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Close this position?')) return
        btn.textContent = 'Closing…'
        btn.disabled = true
        try {
          const res = await fetch(`/api/v1/ctrader/positions/${btn.dataset.id}/close`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ volume: parseInt(btn.dataset.vol!) }),
          })
          const d = await res.json() as { success?: boolean; error?: string }
          if (d.success) loadPositions()
          else alert(`Close failed: ${d.error}`)
        } catch (e) { alert(`Error: ${(e as Error).message}`) }
      })
    })

    el('positions-table').classList.remove('hidden')
  } catch (e) {
    el<HTMLElement>('positions-error').textContent = (e as Error).message
    el('positions-error').classList.remove('hidden')
  } finally {
    el('positions-loading').classList.add('hidden')
  }
}

// ── History ───────────────────────────────────────────────────────────────────
interface DealRow {
  dealId: number; symbol: string; direction: string;
  volume: number; entryPrice: number; closePrice?: number; closeTime?: number; profit?: number;
}

async function loadHistory(): Promise<void> {
  const days = (el<HTMLSelectElement>('history-days')).value
  el('history-loading').classList.remove('hidden')
  el('history-error').classList.add('hidden')
  el('history-empty').classList.add('hidden')
  el('history-table').classList.add('hidden')

  try {
    const res  = await fetch(`/api/v1/ctrader/history?days=${days}`)
    const data = await res.json() as { deals?: DealRow[]; error?: string }
    if (data.error) throw new Error(data.error)

    const deals = data.deals ?? []
    if (deals.length === 0) {
      el('history-empty').classList.remove('hidden')
      return
    }

    const tbody = el<HTMLTableSectionElement>('history-body')
    tbody.innerHTML = deals.map(d => {
      const lots   = (d.volume / 100000).toFixed(2)
      const dec    = d.symbol.includes('JPY') ? 3 : 5
      const dir    = d.direction === 'buy' ? 'buy' : 'sell'
      const date   = d.closeTime ? new Date(d.closeTime).toLocaleDateString('en-GB') : '—'
      const pnl    = d.profit != null ? d.profit.toFixed(2) : null
      const pnlCls = pnl && parseFloat(pnl) >= 0 ? 'profit-positive' : 'profit-negative'
      return `<tr>
        <td>${d.symbol}</td>
        <td class="${dir}">${dir.toUpperCase()}</td>
        <td>${lots}</td>
        <td>${d.entryPrice.toFixed(dec)}</td>
        <td>${d.closePrice ? d.closePrice.toFixed(dec) : '—'}</td>
        <td>${date}</td>
        <td class="${pnlCls}">${pnl ? `£${pnl}` : '—'}</td>
      </tr>`
    }).join('')

    el('history-table').classList.remove('hidden')
  } catch (e) {
    el<HTMLElement>('history-error').textContent = (e as Error).message
    el('history-error').classList.remove('hidden')
  } finally {
    el('history-loading').classList.add('hidden')
  }
}

// ── Risk settings ─────────────────────────────────────────────────────────────
function updateRiskDisplay(): void {
  const displayEl = document.getElementById('risk-amount-display')
  const noteEl    = document.getElementById('risk-note-amount')
  const fmt = `£${accountBalance.toFixed(2)}`
  if (displayEl) displayEl.textContent = fmt
  if (noteEl)    noteEl.textContent    = fmt
}

function initRiskSettings(): void {
  const balanceInput = el<HTMLInputElement>('risk-balance')
  const btn          = el<HTMLButtonElement>('risk-settings-btn')
  const dropdown     = el('risk-dropdown')

  balanceInput.value = String(accountBalance)
  updateRiskDisplay()

  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const open = dropdown.classList.toggle('hidden') === false
    btn.classList.toggle('active', open)
  })

  document.addEventListener('click', () => {
    dropdown.classList.add('hidden')
    btn.classList.remove('active')
  })

  dropdown.addEventListener('click', (e) => e.stopPropagation())

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const syncIndicator = document.createElement('span')
  syncIndicator.id = 'risk-sync-status'
  syncIndicator.style.cssText = 'font-size:10px;margin-left:auto;color:var(--muted);display:block;text-align:right;padding:4px 0 0;'
  el('risk-dropdown').appendChild(syncIndicator)

  const setSyncStatus = (state: 'saving' | 'saved' | 'error') => {
    syncIndicator.textContent = state === 'saving' ? '↻ Syncing…' : state === 'saved' ? '✓ Synced to MCP' : '⚠ Sync failed'
    syncIndicator.style.color = state === 'error' ? 'var(--sell)' : state === 'saved' ? 'var(--buy)' : 'var(--muted)'
  }

  const saveToKv = () => {
    if (saveTimer) clearTimeout(saveTimer)
    setSyncStatus('saving')
    saveTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/v1/settings/risk', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountBalance }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setSyncStatus('saved')
      } catch {
        setSyncStatus('error')
      }
    }, 500)
  }

  const onChange = () => {
    accountBalance = parseFloat(balanceInput.value) || 10000
    localStorage.setItem('risk_balance', String(accountBalance))
    updateRiskDisplay()
    updateBotRiskDisplay()
    updateTradeSizing()
    saveToKv()
  }

  balanceInput.addEventListener('input', onChange)

  saveToKv()
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

  initTabs()
  initPairButtons()
  initTfButtons()
  initChartTypeButtons()
  applyUrlParams()
  initDirectionToggle()
  chart.onDrawingComplete = () => {
    document.querySelectorAll('.draw-tool-btn').forEach(b => b.classList.remove('active'))
    document.getElementById('draw-hint')?.classList.add('hidden')
  }
  initDrawingTools()
  initOverlayToggles()
  initRiskSettings()
  initNews()
  initCTrader()
  initExecuteModal()
  document.getElementById('refresh-positions')?.addEventListener('click', loadPositions)
  document.getElementById('refresh-history')?.addEventListener('click', loadHistory)
  document.getElementById('history-days')?.addEventListener('change', loadHistory)
  initJournal()
  initBot()
  initBacktestTab()
  initMobile()

  // Update pair/TF on chart after URL params applied
  chart.setPair(activePair)
  tradePanel.setPair(activePair)

  loadAll()
}

// ── Journal ────────────────────────────────────────────────────────────────
function initJournal(): void {
  const tableEl  = document.getElementById('journal-table')!
  const bodyEl   = document.getElementById('journal-body')!
  const loadingEl = document.getElementById('journal-loading')!
  const errorEl  = document.getElementById('journal-error')!
  const emptyEl  = document.getElementById('journal-empty')!
  const statsBar = document.getElementById('journal-stats-bar')!
  const formWrap = document.getElementById('journal-form-wrap')!
  const outcomeModal = document.getElementById('outcome-modal')!

  const pipFactor = (pair: string) => pair.includes('JPY') ? 100 : 10000

  async function loadJournal() {
    loadingEl.classList.remove('hidden')
    tableEl.classList.add('hidden')
    emptyEl.classList.add('hidden')
    errorEl.classList.add('hidden')
    statsBar.classList.add('hidden')
    try {
      const [entriesRes, statsRes] = await Promise.all([
        fetch('/api/v1/journal?limit=100'),
        fetch('/api/v1/journal/stats'),
      ])
      const { entries } = await entriesRes.json() as { entries: any[] }
      const stats = await statsRes.json() as any

      loadingEl.classList.add('hidden')

      if (entries.length === 0) {
        emptyEl.classList.remove('hidden')
        return
      }

      // Stats bar
      const pct = (n: number) => (n * 100).toFixed(1) + '%'
      document.getElementById('jstat-trades')!.textContent = String(stats.completedTrades ?? 0) + '/' + String(stats.totalTrades ?? 0)
      document.getElementById('jstat-winrate')!.textContent = stats.completedTrades > 0 ? pct(stats.winRate) : '—'
      document.getElementById('jstat-rr-target')!.textContent = stats.avgRrTargeted > 0 ? stats.avgRrTargeted.toFixed(2) : '—'
      document.getElementById('jstat-rr-achieved')!.textContent = stats.completedTrades > 0 ? stats.avgRrAchieved.toFixed(2) : '—'
      const pip = stats.totalPnlPips ?? 0
      const pipEl = document.getElementById('jstat-pnl')!
      pipEl.textContent = (pip > 0 ? '+' : '') + pip.toFixed(1)
      pipEl.style.color = pip > 0 ? 'var(--buy)' : pip < 0 ? 'var(--sell)' : ''
      statsBar.classList.remove('hidden')

      // Table rows
      bodyEl.innerHTML = entries.map((e: any) => {
        const pf = pipFactor(e.pair)
        const stopPips = Math.abs(e.entryPrice - e.stopLoss) * pf
        const tpPips   = Math.abs(e.target - e.entryPrice) * pf
        const rr       = stopPips > 0 ? (tpPips / stopPips).toFixed(2) : '—'
        const dateStr  = new Date(e.createdAt).toLocaleDateString('en-GB', { day:'2-digit', month:'short' })
        const signal   = e.features?.signalType ?? '—'
        const session  = (e.session ?? '—').replace(/_/g, ' ')
        const result   = e.result
        const pips     = e.pnlPips != null ? (e.pnlPips > 0 ? '+' : '') + e.pnlPips.toFixed(1) : '—'
        const pipsColor = e.pnlPips != null ? (e.pnlPips > 0 ? 'var(--buy)' : e.pnlPips < 0 ? 'var(--sell)' : '') : ''
        const resultBadge = result
          ? `<span class="result-badge ${result}">${result}</span>`
          : `<span class="result-badge open">open</span>`
        const actionBtn = !result
          ? `<button class="outcome-btn" data-id="${e.id}" data-entry="${e.entryPrice}">Record Outcome</button>`
          : ''
        const dirColor = e.direction === 'buy' ? 'var(--buy)' : 'var(--sell)'

        return `<tr>
          <td>${dateStr}</td>
          <td>${e.pair}</td>
          <td style="color:${dirColor};font-weight:600">${e.direction.toUpperCase()}</td>
          <td>${e.entryPrice}</td>
          <td>${e.stopLoss}</td>
          <td>${e.target}</td>
          <td>${rr}</td>
          <td style="font-size:10px;color:var(--muted)">${session}</td>
          <td style="font-size:10px;color:var(--muted)">${signal}</td>
          <td>${resultBadge}</td>
          <td style="color:${pipsColor};font-family:monospace">${pips}</td>
          <td>${actionBtn}</td>
        </tr>`
      }).join('')

      tableEl.classList.remove('hidden')
    } catch {
      loadingEl.classList.add('hidden')
      errorEl.textContent = 'Failed to load journal'
      errorEl.classList.remove('hidden')
    }
  }

  // Outcome buttons via event delegation
  bodyEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.outcome-btn') as HTMLElement | null
    if (!btn) return
    ;(document.getElementById('outcome-journal-id') as HTMLInputElement).value = btn.dataset['id']!
    ;(document.getElementById('outcome-exit') as HTMLInputElement).value = btn.dataset['entry'] ?? ''
    ;(document.getElementById('outcome-notes') as HTMLInputElement).value = ''
    ;(document.getElementById('outcome-result') as HTMLSelectElement).value = 'win'
    outcomeModal.classList.remove('hidden')
  })

  document.getElementById('outcome-cancel')?.addEventListener('click', () => {
    outcomeModal.classList.add('hidden')
  })

  document.getElementById('outcome-submit')?.addEventListener('click', async () => {
    const id     = (document.getElementById('outcome-journal-id') as HTMLInputElement).value
    const result = (document.getElementById('outcome-result') as HTMLSelectElement).value
    const exit   = parseFloat((document.getElementById('outcome-exit') as HTMLInputElement).value)
    const notes  = (document.getElementById('outcome-notes') as HTMLInputElement).value
    if (!id || isNaN(exit)) return
    try {
      const res = await fetch(`/api/v1/journal/${id}/outcome`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result, exitPrice: exit, notes: notes || undefined }),
      })
      if (!res.ok) throw new Error(await res.text())
      outcomeModal.classList.add('hidden')
      await loadJournal()
    } catch (err) {
      alert('Failed to save outcome: ' + err)
    }
  })

  // Log trade form
  document.getElementById('journal-log-btn')?.addEventListener('click', () => {
    formWrap.classList.toggle('hidden')
  })
  document.getElementById('jf-cancel')?.addEventListener('click', () => {
    formWrap.classList.add('hidden')
  })

  document.getElementById('jf-submit')?.addEventListener('click', async () => {
    const pair   = (document.getElementById('jf-pair') as HTMLSelectElement).value
    const dir    = (document.getElementById('jf-dir') as HTMLSelectElement).value
    const tf     = (document.getElementById('jf-tf') as HTMLSelectElement).value
    const entry  = parseFloat((document.getElementById('jf-entry') as HTMLInputElement).value)
    const sl     = parseFloat((document.getElementById('jf-sl') as HTMLInputElement).value)
    const tp     = parseFloat((document.getElementById('jf-tp') as HTMLInputElement).value)
    const conf   = parseFloat((document.getElementById('jf-conf') as HTMLInputElement).value) || 0
    const signal = (document.getElementById('jf-signal') as HTMLSelectElement).value
    const notes  = (document.getElementById('jf-notes') as HTMLInputElement).value
    const status = document.getElementById('jf-status')!
    if (!pair || !dir || isNaN(entry) || isNaN(sl) || isNaN(tp)) {
      status.textContent = '⚠ Fill in pair, entry, SL, and TP'
      return
    }
    status.textContent = 'Saving…'
    try {
      const res = await fetch('/api/v1/journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair, direction: dir, timeframe: tf,
          entryPrice: entry, stopLoss: sl, target: tp,
          confidence: conf, notes: notes || undefined,
          features: { signalType: signal, signalConfidence: conf / 100 },
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      status.textContent = '✓ Saved'
      formWrap.classList.add('hidden')
      await loadJournal()
    } catch {
      status.textContent = '⚠ Save failed'
    }
  })

  document.getElementById('journal-refresh-btn')?.addEventListener('click', loadJournal)
  loadJournal()
}

// ── Bot Panel ──────────────────────────────────────────────────────────────
function updateBotRiskDisplay(): void {
  // Re-render all bot risk/trade amounts using each bot's own riskPercent
  document.querySelectorAll<HTMLElement>('[data-bot-risk-amount]').forEach(el => {
    const pct = parseFloat(el.dataset['botRiskAmount'] ?? '1')
    el.textContent = `£${(accountBalance * pct / 100).toFixed(2)}`
  })
}

const ALL_PAIRS = ['EUR/USD','GBP/USD','GBP/CAD','USD/JPY','EUR/GBP','AUD/USD']

function initBot(): void {
  const botList    = document.getElementById('bot-list')!
  const signalList = document.getElementById('bot-signals-list')!
  const pendingBadge = document.getElementById('bot-pending-count')!
  const scanAllBtn = document.getElementById('bot-scan-all-btn')!
  const addBtn     = document.getElementById('bot-add-btn')!
  const scanStatus = document.getElementById('bot-scan-status')!

  // ── Add bot modal ──────────────────────────────────────────────────────────
  const modal          = document.getElementById('bot-add-modal')!
  const modalNameEl    = document.getElementById('bot-new-name')    as HTMLInputElement
  const modalTypeEl    = document.getElementById('bot-new-type')    as HTMLSelectElement
  const cancelModalBtn = document.getElementById('bot-add-cancel-btn')!
  const confirmModalBtn= document.getElementById('bot-add-confirm-btn')!

  addBtn.addEventListener('click', () => modal.classList.remove('hidden'))
  cancelModalBtn.addEventListener('click', () => modal.classList.add('hidden'))
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden') })

  // Custom type select
  const typeSelect    = document.getElementById('bot-type-select')!
  const typeHidden    = document.getElementById('bot-new-type') as HTMLInputElement
  const typeSelected  = typeSelect.querySelector<HTMLElement>('.custom-select-selected')!
  const typeOptions   = typeSelect.querySelector<HTMLElement>('.custom-select-options')!
  typeSelected.addEventListener('click', (e) => { e.stopPropagation(); typeOptions.classList.toggle('hidden') })
  typeOptions.querySelectorAll<HTMLElement>('.custom-select-option').forEach(opt => {
    opt.addEventListener('click', () => {
      typeHidden.value = opt.dataset.value!
      typeSelected.textContent = opt.textContent
      typeOptions.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('active'))
      opt.classList.add('active')
      typeOptions.classList.add('hidden')
    })
  })
  document.addEventListener('click', () => typeOptions.classList.add('hidden'))

  confirmModalBtn.addEventListener('click', async () => {
    const type  = modalTypeEl.value
    const name  = modalNameEl.value.trim() || undefined
    const pairs = Array.from(document.querySelectorAll<HTMLInputElement>('.bot-new-pair'))
      .filter(c => c.checked).map(c => c.value)

    confirmModalBtn.textContent = 'Creating…'
    try {
      const res = await fetch('/api/v1/bot/bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, name, pairs }),
      })
      if (!res.ok) throw new Error(await res.text())
      modal.classList.add('hidden')
      modalNameEl.value = ''
      document.querySelectorAll<HTMLInputElement>('.bot-new-pair').forEach(c => c.checked = false)
      await loadBotStatus()
    } catch (e: any) {
      alert(`Failed: ${e.message}`)
    } finally {
      confirmModalBtn.textContent = 'Create Bot'
    }
  })

  // ── Render bot cards ───────────────────────────────────────────────────────
  function renderBotCard(bot: any): string {
    const typeClass = bot.type === 'trendline' ? 'trendline' : ''
    const pairPills = ALL_PAIRS.map(p => {
      const active = bot.pairs.length === 0 || bot.pairs.includes(p)
      return `<span class="bot-pair-pill ${active ? 'active' : ''}" data-pair="${p}" data-bot-id="${bot.id}">${p}</span>`
    }).join('')

    const riskFields = `
      <div class="bot-card-row">
        <span class="bot-card-label">Risk %</span>
        <div class="bot-card-setting">
          <input type="number" min="0.1" max="10" step="0.1"
            value="${bot.settings.riskPercent ?? 1.0}"
            data-bot-id="${bot.id}" data-key="riskPercent" />
          <span style="font-size:10px;color:var(--muted)">% per trade</span>
        </div>
        <span class="bot-card-label" style="margin-left:12px">R:R</span>
        <div class="bot-card-setting">
          <input type="number" min="1" max="10" step="0.5"
            value="${bot.settings.rewardRisk ?? (bot.type === 'trendline' ? 3.0 : 2.5)}"
            data-bot-id="${bot.id}" data-key="rewardRisk" />
          <span style="font-size:10px;color:var(--muted)">:1</span>
        </div>
      </div>
      <div class="bot-card-row">
        <span class="bot-card-label">Max Positions</span>
        <div class="bot-card-setting">
          <input type="number" min="1" max="20" step="1"
            value="${bot.settings.maxOpenPositions ?? 2}"
            data-bot-id="${bot.id}" data-key="maxOpenPositions" />
          <span style="font-size:10px;color:var(--muted)">concurrent</span>
        </div>
        <span class="bot-card-label" style="margin-left:12px">Allow Duplicates</span>
        <div class="bot-card-setting" style="align-items:center;gap:6px">
          <input type="checkbox"
            ${bot.settings.allowDuplicatePairs ? 'checked' : ''}
            data-bot-id="${bot.id}" data-key="allowDuplicatePairs" />
          <span style="font-size:10px;color:var(--muted)">same pair twice</span>
        </div>
      </div>`

    const settingFields = bot.type === 'structure' ? `
      <div class="bot-card-row">
        <span class="bot-card-label">Min Score</span>
        <div class="bot-card-setting">
          <input type="number" min="0" max="100" step="1"
            value="${bot.settings.minConfidenceScore ?? 60}"
            data-bot-id="${bot.id}" data-key="minConfidenceScore" />
          <span style="font-size:10px;color:var(--muted)">%</span>
        </div>
        <span class="bot-card-label" style="margin-left:12px">Min Confluence</span>
        <div class="bot-card-setting">
          <input type="number" min="1" max="5" step="1"
            value="${bot.settings.minConfluence ?? 2}"
            data-bot-id="${bot.id}" data-key="minConfluence" />
          <span style="font-size:10px;color:var(--muted)">S/R levels</span>
        </div>
      </div>${riskFields}` : bot.type === 'trendline' ? `
      <div class="bot-card-row">
        <span class="bot-card-label">Min Score</span>
        <div class="bot-card-setting">
          <input type="number" min="0" max="100" step="1"
            value="${bot.settings.minConfidenceScore ?? 60}"
            data-bot-id="${bot.id}" data-key="minConfidenceScore" />
          <span style="font-size:10px;color:var(--muted)">%</span>
        </div>
        <span class="bot-card-label" style="margin-left:12px">Min Touches</span>
        <div class="bot-card-setting">
          <input type="number" min="2" max="10" step="1"
            value="${bot.settings.minTouches ?? 2}"
            data-bot-id="${bot.id}" data-key="minTouches" />
        </div>
      </div>${riskFields}` : ''

    return `
      <div class="bot-card" data-bot-id="${bot.id}">
        <div class="bot-card-header">
          <span class="bot-card-name">${bot.name}</span>
          <span class="bot-type-badge ${typeClass}">${bot.type}</span>
          <span class="bot-card-mode ${bot.mode}">${bot.mode === 'autonomous' ? 'AUTO' : bot.mode.toUpperCase()}</span>
          <span class="bot-card-chevron">▼</span>
        </div>
        <div class="bot-card-body">
          <div class="bot-card-row">
            <span class="bot-card-label">Mode</span>
            <div class="bot-card-mode-row">
              <button class="bot-card-mode-btn ${bot.mode==='off'?'active':''}" data-mode="off" data-bot-id="${bot.id}">Off</button>
              <button class="bot-card-mode-btn ${bot.mode==='approval'?'active':''}" data-mode="approval" data-bot-id="${bot.id}">Approval</button>
              <button class="bot-card-mode-btn ${bot.mode==='autonomous'?'active':''}" data-mode="autonomous" data-bot-id="${bot.id}">Autonomous</button>
            </div>
          </div>
          <div class="bot-card-row">
            <span class="bot-card-label">Pairs</span>
            <div class="bot-card-pairs">${pairPills}</div>
          </div>
          ${settingFields}
          <div class="bot-card-row">
            <span class="bot-card-label">Risk/Trade</span>
            <span data-bot-risk-amount="${bot.settings['riskPercent'] ?? 1}"
                  style="font-size:12px;font-family:monospace;color:var(--fg)">
              £${(accountBalance * ((bot.settings['riskPercent'] as number | undefined) ?? 1) / 100).toFixed(2)}
            </span>
          </div>
          <div class="bot-card-actions">
            <button class="bot-card-save-btn" data-bot-id="${bot.id}">Save</button>
            <button class="bot-card-scan-btn" data-bot-id="${bot.id}">▶ Scan</button>
            <button class="bot-card-delete-btn" data-bot-id="${bot.id}">Delete</button>
          </div>
        </div>
      </div>`
  }

  function attachCardEvents(botId: string) {
    const card = botList.querySelector<HTMLElement>(`.bot-card[data-bot-id="${botId}"]`)
    if (!card) return

    // Expand/collapse
    card.querySelector('.bot-card-header')?.addEventListener('click', () => {
      card.querySelector('.bot-card-body')?.classList.toggle('open')
      const chev = card.querySelector<HTMLElement>('.bot-card-chevron')
      if (chev) chev.textContent = card.querySelector('.bot-card-body')?.classList.contains('open') ? '▲' : '▼'
    })

    // Mode buttons
    card.querySelectorAll<HTMLButtonElement>('.bot-card-mode-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const mode = btn.dataset.mode!
        card.querySelectorAll('.bot-card-mode-btn').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        const badge = card.querySelector<HTMLElement>('.bot-card-mode')
        if (badge) {
          badge.className = `bot-card-mode ${mode}`
          badge.textContent = mode === 'autonomous' ? 'AUTO' : mode.toUpperCase()
        }
      })
    })

    // Pair pills toggle
    card.querySelectorAll<HTMLElement>('.bot-pair-pill').forEach(pill => {
      pill.addEventListener('click', (e) => {
        e.stopPropagation()
        pill.classList.toggle('active')
      })
    })

    // Save
    card.querySelector<HTMLButtonElement>('.bot-card-save-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation()
      const btn = e.currentTarget as HTMLButtonElement
      btn.textContent = '…'
      try {
        const mode    = card.querySelector<HTMLButtonElement>('.bot-card-mode-btn.active')?.dataset.mode ?? 'off'
        const activePills = card.querySelectorAll<HTMLElement>('.bot-pair-pill.active')
        const allActive   = activePills.length === ALL_PAIRS.length
        const pairs = allActive ? [] : Array.from(activePills).map(p => p.dataset.pair!)
        const settings: Record<string, unknown> = {}
        card.querySelectorAll<HTMLInputElement>('[data-key]').forEach(inp => {
          settings[inp.dataset.key!] = inp.type === 'checkbox' ? inp.checked : Number(inp.value)
        })
        const res = await fetch(`/api/v1/bot/bots/${botId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, pairs, settings }),
        })
        if (!res.ok) throw new Error(await res.text())
        btn.textContent = '✓ Saved'
        setTimeout(() => { btn.textContent = 'Save' }, 2000)
      } catch (e: any) {
        btn.textContent = '⚠ Error'
        setTimeout(() => { btn.textContent = 'Save' }, 2000)
      }
    })

    // Per-bot scan
    card.querySelector<HTMLButtonElement>('.bot-card-scan-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation()
      const btn = e.currentTarget as HTMLButtonElement
      btn.disabled = true
      btn.textContent = 'Scanning…'
      try {
        const res  = await fetch(`/api/v1/bot/bots/${botId}/scan`, { method: 'POST' })
        const data = await res.json() as any
        const found = data.signalsFound ?? 0
        scanStatus.textContent = `${btn.closest('.bot-card')?.querySelector('.bot-card-name')?.textContent}: ${found} signal(s) found`
        scanStatus.className   = `bot-scan-status ${found > 0 ? 'ok' : ''}`
        scanStatus.classList.remove('hidden')
        await loadBotStatus()
      } catch (e: any) {
        scanStatus.textContent = e.message
        scanStatus.className   = 'bot-scan-status err'
        scanStatus.classList.remove('hidden')
      } finally {
        btn.disabled = false
        btn.textContent = '▶ Scan'
      }
    })

    // Delete
    card.querySelector<HTMLButtonElement>('.bot-card-delete-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm('Delete this bot?')) return
      await fetch(`/api/v1/bot/bots/${botId}`, { method: 'DELETE' })
      await loadBotStatus()
    })
  }

  // ── Render signals ─────────────────────────────────────────────────────────
  function renderSignals(signals: any[], bots: any[]) {
    const botMap = Object.fromEntries(bots.map(b => [b.id, b.name]))
    if (!signals.length) {
      signalList.innerHTML = '<div class="bot-no-signals">No pending signals</div>'
      pendingBadge.textContent = '0'
      return
    }
    pendingBadge.textContent = String(signals.length)
    signalList.innerHTML = signals.map(s => {
      const rr = s.take_profit && s.stop_loss && s.entry_price
        ? Math.abs((s.take_profit - s.entry_price) / (s.entry_price - s.stop_loss)).toFixed(1)
        : '–'
      const botName = botMap[s.botId] ?? s.botId ?? '—'
      return `
        <div class="bot-signal-card ${s.direction}" data-id="${s.id}">
          <div class="bot-signal-top">
            <span class="bot-signal-pair">${s.pair}</span>
            <span class="bot-signal-dir ${s.direction}">${s.direction}</span>
            <span class="bot-signal-bot-label">${botName}</span>
          </div>
          <div class="bot-signal-info">
            Entry ${s.entry_price?.toFixed(5) ?? '–'} &nbsp;
            SL ${s.stop_loss?.toFixed(5) ?? '–'} &nbsp;
            TP ${s.take_profit?.toFixed(5) ?? '–'} &nbsp;
            RR ${rr} &nbsp; ${s.lots}L &nbsp; Score ${Math.round((s.score ?? 0) * 100)}
          </div>
          <div class="bot-signal-actions">
            <button class="bot-approve-btn" data-id="${s.id}">✓ Approve</button>
            <button class="bot-reject-btn"  data-id="${s.id}">✗ Reject</button>
          </div>
        </div>`
    }).join('')

    signalList.querySelectorAll<HTMLButtonElement>('.bot-approve-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '…'
        try {
          const res = await fetch(`/api/v1/bot/signals/${btn.dataset.id}/approve`, { method: 'POST' })
          if (!res.ok) throw new Error(await res.text())
          await loadBotStatus()
        } catch (e: any) {
          alert(`Approve failed: ${e.message}`)
          btn.disabled = false; btn.textContent = '✓ Approve'
        }
      })
    })
    signalList.querySelectorAll<HTMLButtonElement>('.bot-reject-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await fetch(`/api/v1/bot/signals/${btn.dataset.id}/reject`, { method: 'POST' })
        await loadBotStatus()
      })
    })
  }

  // ── Load status ────────────────────────────────────────────────────────────
  async function loadBotStatus() {
    try {
      const res = await fetch('/api/v1/bot/status')
      if (!res.ok) return
      const data = await res.json() as any
      const bots: any[] = data.bots ?? []

      if (!bots.length) {
        botList.innerHTML = '<div class="bot-no-signals">No bots configured. Click + Add Bot to create one.</div>'
      } else {
        botList.innerHTML = bots.map(renderBotCard).join('')
        bots.forEach(b => attachCardEvents(b.id))
      }

      const pending = (data.recentSignals ?? []).filter((s: any) => s.status === 'pending')
      renderSignals(pending, bots)
    } catch { /* silent */ }
  }

  // ── Scan all ───────────────────────────────────────────────────────────────
  scanAllBtn.addEventListener('click', async () => {
    scanAllBtn.textContent = 'Scanning…'
    ;(scanAllBtn as HTMLButtonElement).disabled = true
    scanStatus.className = 'bot-scan-status'
    scanStatus.classList.remove('hidden')
    try {
      const res  = await fetch('/api/v1/bot/scan', { method: 'POST' })
      const data = await res.json() as any
      if (data.error) throw new Error(data.error)
      const totals = Object.values(data as Record<string, any>)
        .reduce((acc: any, r: any) => ({
          found:    (acc.found    ?? 0) + (r.signalsFound    ?? 0),
          queued:   (acc.queued   ?? 0) + (r.signalsQueued   ?? 0),
          executed: (acc.executed ?? 0) + (r.signalsExecuted ?? 0),
        }), {})
      scanStatus.textContent = `Scan complete — ${totals.found ?? 0} signal(s) found, ${totals.queued ?? 0} queued, ${totals.executed ?? 0} executed`
      if (totals.found > 0) scanStatus.classList.add('ok')
      await loadBotStatus()
    } catch (e: any) {
      scanStatus.textContent = e.message
      scanStatus.classList.add('err')
    } finally {
      scanAllBtn.textContent = '▶ Scan All'
      ;(scanAllBtn as HTMLButtonElement).disabled = false
    }
  })

  // ── Cron log ────────────────────────────────────────────────────────────────
  const cronLogList    = document.getElementById('cron-log-list')!
  const cronLogRefresh = document.getElementById('cron-log-refresh')!

  async function loadCronLog() {
    try {
      const res  = await fetch('/api/v1/bot/cron-log')
      const rows = await res.json() as any[]
      if (!rows.length) {
        cronLogList.innerHTML = '<div class="bot-no-signals">No cron runs recorded yet.</div>'
        return
      }
      cronLogList.innerHTML = `
        <table class="cron-log-table">
          <thead><tr>
            <th>Time</th><th>Session</th><th>Duration</th>
            <th>Recs</th><th>Signals</th><th>Queued</th><th>Executed</th><th>Error</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => {
              const dt   = new Date(r.created_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })
              const dur  = r.duration_ms < 1000 ? `${r.duration_ms}ms` : `${(r.duration_ms / 1000).toFixed(1)}s`
              const errCell = r.error
                ? `<td class="cron-log-err" title="${r.error}">⚠ ${r.error.slice(0, 40)}${r.error.length > 40 ? '…' : ''}</td>`
                : '<td class="cron-log-ok">—</td>'
              return `<tr>
                <td>${dt}</td>
                <td>${r.session_name}</td>
                <td>${dur}</td>
                <td>${r.recommendations_generated ?? 0}</td>
                <td>${r.signals_found ?? 0}</td>
                <td>${r.signals_queued ?? 0}</td>
                <td>${r.signals_executed ?? 0}</td>
                ${errCell}
              </tr>`
            }).join('')}
          </tbody>
        </table>`
    } catch (e: any) {
      cronLogList.innerHTML = `<div class="bot-no-signals" style="color:var(--sell)">${e.message}</div>`
    }
  }

  cronLogRefresh.addEventListener('click', loadCronLog)

  loadBotStatus()
  loadCronLog()
  setInterval(loadBotStatus, 30_000)
}

// ── Backtest ───────────────────────────────────────────────────────────────
async function initBacktestTab(): Promise<void> {
  // Pre-fill dates: last 12 months
  const now = new Date()
  const toDate = now.toISOString().slice(0, 10)
  const fromDate = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()).toISOString().slice(0, 10)
  const fromEl  = document.getElementById('bt-from') as HTMLInputElement
  const toEl    = document.getElementById('bt-to')   as HTMLInputElement
  fromEl.value = fromDate
  toEl.value   = toDate

  document.getElementById('bt-run-btn')?.addEventListener('click', runBacktest)
  document.getElementById('bt-refresh-runs')?.addEventListener('click', loadBacktestRuns)
  document.getElementById('bt-delete-btn')?.addEventListener('click', deleteCurrentRun)

  // Load bots and populate the bot selector
  await loadBacktestBotSelector()

  loadBacktestRuns()
}

async function loadBacktestBotSelector(): Promise<void> {
  const btSelect  = document.getElementById('bt-bot-select')
  const btBotId   = document.getElementById('bt-bot-id')   as HTMLInputElement
  const btBotType = document.getElementById('bt-bot-type') as HTMLInputElement
  if (!btSelect) return

  const selected = btSelect.querySelector('.custom-select-selected') as HTMLElement
  const optionsEl = btSelect.querySelector('.custom-select-options') as HTMLElement

  let bots: any[] = []
  try {
    const res = await fetch('/api/v1/bot/bots')
    bots = await res.json() as any[]
  } catch { /* leave empty */ }

  if (bots.length === 0) {
    if (selected) selected.textContent = 'No bots found — create one in the Bot tab'
    return
  }

  // Build options
  optionsEl.innerHTML = bots.map((b, i) =>
    `<div class="custom-select-option ${i === 0 ? 'active' : ''}" data-value="${b.id}" data-bot-type="${b.type}">
      ${b.name} — Trendline break + retest
    </div>`
  ).join('')

  // Select first bot by default
  const first = bots[0]
  if (selected) { selected.textContent = optionsEl.querySelector('.active')?.textContent?.trim() ?? first.name; selected.dataset.value = first.id }
  btBotId.value   = first.id
  btBotType.value = first.type

  // Wire dropdown
  selected?.addEventListener('click', () => optionsEl.classList.toggle('hidden'))
  optionsEl.querySelectorAll('.custom-select-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const el = opt as HTMLElement
      btBotId.value   = el.dataset.value ?? ''
      btBotType.value = el.dataset.botType ?? 'trendline'
      if (selected) { selected.textContent = el.textContent?.trim() ?? ''; selected.dataset.value = el.dataset.value ?? '' }
      optionsEl.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('active'))
      el.classList.add('active')
      optionsEl.classList.add('hidden')
    })
  })
  document.addEventListener('click', e => {
    if (!btSelect.contains(e.target as Node)) optionsEl.classList.add('hidden')
  })
}

let currentRunId: string | null = null

async function runBacktest(): Promise<void> {
  const pairs = Array.from(document.querySelectorAll<HTMLInputElement>('.bt-pair-check'))
    .filter(c => c.checked).map(c => c.value)
  if (pairs.length === 0) { alert('Select at least one pair'); return }
  const botId   = (document.getElementById('bt-bot-id')   as HTMLInputElement)?.value ?? ''
  const botType = (document.getElementById('bt-bot-type') as HTMLInputElement)?.value ?? 'structure'
  if (!botId) { alert('Select a bot to run the backtest with'); return }

  const fromMs = new Date((document.getElementById('bt-from') as HTMLInputElement).value + 'T00:00:00Z').getTime()
  const toMs   = new Date((document.getElementById('bt-to')   as HTMLInputElement).value + 'T23:59:59Z').getTime()

  const btn = document.getElementById('bt-run-btn') as HTMLButtonElement
  btn.disabled = true
  btn.textContent = '⏳ Running…'

  const progress = document.getElementById('backtest-progress')!
  const statusMsg = document.getElementById('bt-status-msg')!
  progress.classList.remove('hidden')
  statusMsg.textContent = 'Starting backtest…'
  document.getElementById('backtest-results')!.classList.add('hidden')

  try {
    // Phase 1: prefetch each pair individually (3 API calls per pair, safe within Worker limits)
    for (const pair of pairs) {
      statusMsg.textContent = `Fetching market data: ${pair}…`
      const pfRes = await fetch('/api/v1/backtest/prefetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pair, fromMs, toMs, botType, botId }),
      })
      const pfData = await pfRes.json() as { pair: string; results: Record<string, string> }
      const failed = Object.entries(pfData.results ?? {}).filter(([, v]) => !v.startsWith('ok') && v !== 'cached')
      if (failed.length > 0) {
        statusMsg.textContent = `Warning: ${pair} partial data (${failed.map(([k, v]) => `${k}:${v}`).join(', ')}) — continuing`
        await new Promise(r => setTimeout(r, 500))
      }
    }

    // Phase 2: run analysis (all data now in cache — analysis only, fast)
    statusMsg.textContent = 'Data cached — running analysis…'
    const res = await fetch('/api/v1/backtest/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairs, fromMs, toMs, botType, botId }),
    })
    const data = await res.json() as { runId?: string; error?: string }
    if (!res.ok || !data.runId) throw new Error(data.error ?? 'Failed to start backtest')

    currentRunId = data.runId
    statusMsg.textContent = `Run started (${data.runId.slice(0, 8)}…) — polling…`

    let done = false
    let attempts = 0
    const MAX_ATTEMPTS = 120 // 360s max — uncached runs need ~144s just for API fetches
    while (!done && attempts < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, 3000))
      attempts++
      const pollRes = await fetch(`/api/v1/backtest/runs/${data.runId}`)
      const run = await pollRes.json() as any
      if (run.status === 'completed') {
        done = true
        statusMsg.textContent = `Completed — ${run.summary?.totalTrades ?? 0} trades`
        renderBacktestResults(run)
      } else if (run.status === 'failed') {
        done = true
        statusMsg.textContent = `Failed: ${run.error ?? 'unknown error'}`
      } else {
        statusMsg.textContent = `Running… (${attempts * 3}s elapsed)`
      }
    }
    if (!done) statusMsg.textContent = 'Timed out — Worker may have been killed by Cloudflare CPU limit. Check Past Runs to see if it completed.'
  } catch (e: any) {
    const loc = e.stack ? e.stack.split('\n').slice(0,3).join(' | ') : ''
    statusMsg.textContent = `Error: ${e.message} — ${loc}`
  } finally {
    btn.disabled = false
    btn.textContent = '▶ Run Backtest'
    loadBacktestRuns()
  }
}

async function deleteCurrentRun(): Promise<void> {
  if (!currentRunId) return
  if (!confirm('Delete this backtest run and all its trades?')) return
  await fetch(`/api/v1/backtest/runs/${currentRunId}`, { method: 'DELETE' })
  currentRunId = null
  document.getElementById('backtest-results')!.classList.add('hidden')
  loadBacktestRuns()
}

function safeDate(ms: any): string {
  const n = typeof ms === 'string' ? parseInt(ms, 10) : Number(ms)
  if (!n || isNaN(n)) return '—'
  const d = new Date(n)
  return isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10)
}

function renderBacktestResults(run: any): void {
  const resultsEl = document.getElementById('backtest-results')!
  resultsEl.classList.remove('hidden')

  const s = run.summary ?? {}
  const totalPnl = s.totalPnl ?? 0
  const winRate  = s.winRate  ?? 0

  const statsEl = document.getElementById('bt-stats')!
  statsEl.innerHTML = [
    { label: 'Total Trades', value: String(s.totalTrades ?? 0), cls: '' },
    { label: 'Win Rate',     value: `${winRate}%`,              cls: winRate >= 50 ? 'positive' : 'negative' },
    { label: 'Total P&L',   value: `£${totalPnl.toFixed(2)}`,  cls: totalPnl >= 0 ? 'positive' : 'negative' },
    { label: 'Max Drawdown', value: `£${(s.maxDrawdown ?? 0).toFixed(2)}`, cls: 'negative' },
    { label: 'Sharpe',       value: String(s.sharpe ?? 0),      cls: (s.sharpe ?? 0) >= 1 ? 'positive' : '' },
    { label: 'Wins',         value: String(s.wins ?? 0),        cls: 'positive' },
    { label: 'Losses',       value: String(s.losses ?? 0),      cls: 'negative' },
    { label: 'No Trades',    value: String(s.rejectedSignals ?? 0), cls: '' },
  ].map(c => `
    <div class="backtest-card">
      <div class="bc-label">${c.label}</div>
      <div class="bc-value ${c.cls}">${c.value}</div>
    </div>
  `).join('')

  const cfg = run.config ?? {}
  const strategyLabel = 'Trendline Bot'
  ;(document.getElementById('bt-results-title') as HTMLElement).textContent =
    `Results — ${strategyLabel} — ${(cfg.pairs ?? []).join(', ')} — ${safeDate(cfg.fromMs)} to ${safeDate(cfg.toMs)}`

  const trades: any[] = run.trades ?? []

  // Separate executed trades from ML-only rejected signals
  const executedTrades = trades.filter((t: any) => t.status === 'executed')
  const rejectedCount  = trades.filter((t: any) => t.status === 'rejected').length

  // Show diagnostics if 0 executed trades
  const diagEl = document.getElementById('bt-diagnostics')
  if (diagEl) {
    const diag: Record<string, number> = s.diagnostics ?? {}
    const diagEntries = Object.entries(diag).sort((a,b) => b[1]-a[1])
    {
      let html = ''
      if (diagEntries.length > 0) {
        const label = executedTrades.length === 0 ? 'Why no trades?' : 'Rejection breakdown'
        const rows = diagEntries
          .map(([k,v]) => `<tr><td style="padding:4px 8px;color:var(--muted)">${k}</td><td style="padding:4px 8px;text-align:right;color:#f85149">${v}</td></tr>`).join('')
        html += `<div style="margin-top:12px"><strong style="color:var(--fg)">${label}</strong> <span style="color:var(--muted);font-size:12px">(${rejectedCount} rejected setups recorded for ML)</span><table style="margin-top:6px;width:100%;font-size:12px;border-collapse:collapse">${rows}</table></div>`
      }
      const runLog: string[] = s.log ?? []
      if (runLog.length > 0) {
        html += `<div style="margin-top:12px"><strong style="color:var(--fg)">Run log</strong><pre style="margin-top:6px;font-size:11px;color:var(--muted);white-space:pre-wrap;max-height:200px;overflow-y:auto">${runLog.join('\n')}</pre></div>`
      }
      if (html) {
        diagEl.innerHTML = html
        diagEl.classList.remove('hidden')
      } else {
        diagEl.innerHTML = ''
        diagEl.classList.add('hidden')
      }
    }
  }

  renderEquityCurve(executedTrades)

  const tbody = document.getElementById('bt-trades-body')!
  if (executedTrades.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--muted)">No trades</td></tr>'
  } else {
    tbody.innerHTML = executedTrades.map((t: any) => {
      const outcomeClass = t.outcome === 'tp' ? 'outcome-tp' : t.outcome === 'sl' ? 'outcome-sl' : 'outcome-expired'
      const pnlCls = (t.pnl_gbp ?? 0) >= 0 ? 'outcome-tp' : 'outcome-sl'
      const dateStr = safeDate(t.created_at)
      return `<tr>
        <td>${t.pair}</td>
        <td class="${t.direction === 'buy' ? 'outcome-tp' : 'outcome-sl'}">${t.direction.toUpperCase()}</td>
        <td>${t.entry_price}</td>
        <td>${t.stop_loss}</td>
        <td>${t.take_profit}</td>
        <td>${t.score}</td>
        <td>${dateStr}</td>
        <td class="${outcomeClass}">${(t.outcome ?? '—').toUpperCase()}</td>
        <td class="${pnlCls}">${t.pnl_pips ?? '—'}</td>
        <td class="${pnlCls}">${t.pnl_gbp != null ? '£' + Number(t.pnl_gbp).toFixed(2) : '—'}</td>
      </tr>`
    }).join('')
  }
}

function renderEquityCurve(trades: any[]): void {
  const container = document.getElementById('bt-equity-chart')!
  const completed = trades.filter((t: any) => t.pnl_gbp != null)
  if (completed.length === 0) { container.innerHTML = ''; return }

  let cum = 0
  const points = completed.map((t: any) => { cum += Number(t.pnl_gbp); return cum })

  const W = 600, H = 200, PAD = 30
  const minY = Math.min(0, ...points)
  const maxY = Math.max(0, ...points)
  const rangeY = maxY - minY || 1
  const rangeX = points.length - 1 || 1

  const px = (i: number) => PAD + (i / rangeX) * (W - PAD * 2)
  const py = (v: number) => PAD + (1 - (v - minY) / rangeY) * (H - PAD * 2)

  const polyline = points.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ')
  const zeroY = py(0).toFixed(1)

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="background:#111;border-radius:4px">
      <line x1="${PAD}" y1="${zeroY}" x2="${W - PAD}" y2="${zeroY}" stroke="#444" stroke-width="1" stroke-dasharray="4,4"/>
      <polyline points="${polyline}" fill="none" stroke="#3fb950" stroke-width="2"/>
      <text x="${PAD}" y="${H - 6}" fill="#666" font-size="9" font-family="monospace">${completed.length} trades</text>
      <text x="${W - PAD}" y="${H - 6}" fill="#666" font-size="9" font-family="monospace" text-anchor="end">£${cum.toFixed(0)}</text>
    </svg>
  `
}

async function loadBacktestRuns(): Promise<void> {
  const container = document.getElementById('bt-runs-body')!
  if (!container) return
  container.innerHTML = '<div style="font-size:11px;color:var(--muted);font-family:monospace;padding:8px 0">Loading…</div>'
  try {
    const res = await fetch('/api/v1/backtest/runs')
    const runs = await res.json() as any[]
    if (!runs.length) {
      container.innerHTML = '<div style="font-size:11px;color:var(--muted);font-family:monospace;padding:8px 0">No runs yet</div>'
      return
    }
    container.innerHTML = runs.map((r: any) => {
      const s = r.summary
      const cfg = r.config
      const pairsStr   = (cfg?.pairs ?? []).join(', ')
      const dateStr    = safeDate(r.started_at).replace('—', '?')
      const pnlStr     = s ? (s.totalPnl >= 0 ? `+£${s.totalPnl}` : `-£${Math.abs(s.totalPnl)}`) : ''
      const winStr     = s ? `${s.wins}W/${s.losses}L (${s.winRate}%)` : ''
      const stratLabel = 'TL'
      return `<div class="bt-run-row" data-run-id="${r.id}">
        <span class="bt-run-date">${dateStr}</span>
        <span class="bt-run-strategy-badge">${stratLabel}</span>
        <span class="bt-run-pairs">${pairsStr}</span>
        <span class="bt-run-status-badge ${r.status}">${r.status}</span>
        <span class="bt-run-summary">${winStr} ${pnlStr}</span>
      </div>`
    }).join('')

    container.querySelectorAll<HTMLElement>('.bt-run-row').forEach(row => {
      row.addEventListener('click', async () => {
        const id = row.dataset.runId!
        currentRunId = id
        const pollRes = await fetch(`/api/v1/backtest/runs/${id}`)
        const run = await pollRes.json() as any
        renderBacktestResults(run)
        document.getElementById('backtest-results')!.scrollIntoView({ behavior: 'smooth' })
      })
    })
  } catch {
    container.innerHTML = '<div style="font-size:11px;color:var(--sell);font-family:monospace;padding:8px 0">Failed to load runs</div>'
  }
}

init()
