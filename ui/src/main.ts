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
let accountBalance  = 0 // always derived from the selected/connected cTrader account's live balance
// These are local defaults for the manual trade calculator only — bots use their own per-bot settings
const riskPercent  = 1.0
const rewardRisk   = 2.5
let defaultSlPips  = 50
let tradeDirection: 'buy' | 'sell' = 'buy'
let cachedAccounts: any[] = []
let selectedTradeAccountId = ''
// Applied once per page load — the account marked "default" becomes the initial view in
// Dashboard/Positions/History instead of "All", but never fights a selection the user has
// since made (see applyDefaultAccountSelection).
let appliedDefaultAccountSelection = false
// Set by initAccounts()'s first loadAccounts() call — lets other init paths (initBot()) wait
// for cachedAccounts to be populated at least once before their own first render, instead of
// racing it. Without this, a bot card's first render could land before accounts had loaded,
// showing "— No account —" even though the bot's real accountId was correct all along; it
// would self-correct on the next 30s poll, but only after alarming the user in the meantime.
let initialAccountsLoad: Promise<void> | null = null

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
  const select = el<HTMLSelectElement>('pair-select')
  select.addEventListener('change', () => {
    activePair = select.value
    const pairDisp = document.getElementById('mobile-pair-display')
    if (pairDisp) pairDisp.textContent = activePair
    tradePanel.setPair(activePair)
    chart.setPair(activePair)
    loadAll()
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
  document.getElementById('pair-select')?.addEventListener('change', closeSidebar)

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
    const select = el<HTMLSelectElement>('pair-select')
    if (Array.from(select.options).some(o => o.value === pair)) {
      select.value = pair
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
  document.querySelectorAll<HTMLButtonElement>('.tab-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
      document.querySelectorAll('.mobile-more-item').forEach(b => b.classList.remove('active'))
      document.querySelectorAll('.tab-panel').forEach(p => {
        p.classList.remove('active')
        p.classList.add('hidden')
      })
      btn.classList.add('active')
      // On mobile, tabs reached via "More" aren't in the bottom bar — show the More
      // button itself as active instead, so there's still a visible sense of location.
      if (!('mobilePrimary' in btn.dataset)) {
        document.getElementById('mobile-more-btn')?.classList.add('active')
        document.querySelector(`.mobile-more-item[data-tab="${btn.dataset.tab}"]`)?.classList.add('active')
      }
      const panel = document.getElementById(`tab-${btn.dataset.tab}`)!
      panel.classList.remove('hidden')
      panel.classList.add('active')
      // Sidebar (desktop) and its mobile-topbar equivalent hold chart-only controls
      // (pair/timeframe/overlays) — only relevant on the Chart tab itself.
      const onChart = btn.dataset.tab === 'chart'
      document.getElementById('sidebar')?.classList.toggle('hidden', !onChart)
      document.getElementById('mobile-topbar')?.classList.toggle('hidden', !onChart)
      if (btn.dataset.tab === 'positions') loadPositions()
      if (btn.dataset.tab === 'history')   loadHistory()
      if (btn.dataset.tab === 'news')      loadNews(activePair)
      if (btn.dataset.tab === 'dashboard') loadDashboard()
      // Chart is no longer the default landing tab, so its container can be display:none at
      // the moment klinecharts first measures it — resize once it's actually visible again.
      if (btn.dataset.tab === 'chart')     requestAnimationFrame(() => chart.resize())
    })
  })
}

function initMobileMore(): void {
  const moreBtn  = document.getElementById('mobile-more-btn')!
  const overlay  = document.getElementById('mobile-more-overlay')!
  const sheet    = document.getElementById('mobile-more-sheet')!

  const closeSheet = () => {
    overlay.classList.add('hidden')
    sheet.classList.add('hidden')
  }

  moreBtn.addEventListener('click', () => {
    overlay.classList.remove('hidden')
    sheet.classList.remove('hidden')
  })
  overlay.addEventListener('click', closeSheet)

  document.querySelectorAll<HTMLButtonElement>('.mobile-more-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelector<HTMLButtonElement>(`.tab-btn[data-tab="${item.dataset.tab}"]`)?.click()
      closeSheet()
    })
  })
}

// ── cTrader status ────────────────────────────────────────────────────────────
let tradeOrderType: 'market' | 'limit' = 'market'

function updateTradeConnectionUI(): void {
  const dot        = document.getElementById('ctrader-status-dot')!
  const txt        = document.getElementById('ctrader-status-text')!
  const connectBtn = document.getElementById('ctrader-connect-btn')!
  const disconnBtn = document.getElementById('ctrader-disconnect-btn')!
  const exec       = document.getElementById('execute-trade-btn')!

  const acct      = cachedAccounts.find(a => a.id === selectedTradeAccountId)
  const connected = !!acct?.hasToken

  if (connected) {
    dot.className   = 'status-dot connected'
    txt.textContent = `Connected — ${acct.name} (${acct.type.toUpperCase()})`
    connectBtn.textContent = '✓ Connected'
    connectBtn.classList.add('connected')
    disconnBtn.classList.remove('hidden')
    exec.classList.remove('hidden')
    showCTraderConnectedUI()
  } else {
    dot.className   = 'status-dot disconnected'
    txt.textContent = acct ? `${acct.name} not connected` : 'Select an account'
    connectBtn.textContent = 'Connect cTrader'
    connectBtn.classList.remove('connected')
    disconnBtn.classList.add('hidden')
    exec.classList.add('hidden')
    document.getElementById('ctrader-trade-form')?.classList.add('hidden')
    document.getElementById('ctrader-positions-panel')?.classList.add('hidden')
  }

  syncAccountBalanceFromSelection()
}

// Drives position sizing off the selected trade account's real cTrader balance.
// There is no manual fallback — if no account balance is cached yet, sizing is 0
// until the account is connected and its balance refreshed (Accounts tab).
function syncAccountBalanceFromSelection(): void {
  const acct = cachedAccounts.find(a => a.id === selectedTradeAccountId)
  accountBalance = acct?.balance ?? 0
  updateRiskDisplay()
  updateBotRiskDisplay()
  updateTradeSizing()
}

function initCTrader(): void {
  document.getElementById('trade-account')?.addEventListener('change', (e) => {
    selectedTradeAccountId = (e.target as HTMLSelectElement).value
    updateTradeConnectionUI()
  })

  document.getElementById('ctrader-connect-btn')?.addEventListener('click', () => {
    window.location.href = `/auth/ctrader?accountId=${selectedTradeAccountId || 'default'}`
  })

  document.getElementById('ctrader-disconnect-btn')?.addEventListener('click', async () => {
    const id = selectedTradeAccountId || 'default'
    await fetch(`/api/v1/ctrader/accounts/${id}/disconnect`, { method: 'POST' })
    document.getElementById('ctrader-trade-form')?.classList.add('hidden')
    document.getElementById('ctrader-positions-panel')?.classList.add('hidden')
    await loadAccounts()
    window.location.href = `/auth/ctrader?accountId=${id}`
  })

  document.getElementById('execute-trade-btn')?.addEventListener('click', showExecuteModal)

  if (new URLSearchParams(window.location.search).get('ctrader') === 'connected') {
    history.replaceState({}, '', '/')
  }

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
    const qs   = selectedTradeAccountId ? `?accountId=${encodeURIComponent(selectedTradeAccountId)}` : ''
    const res  = await fetch(`/api/v1/ctrader/positions${qs}`)
    const data = await res.json() as { positions?: { positionId: number; symbol: string; direction: string; volume: number; lots: number; openPrice: number }[]; error?: string }
    if (!res.ok || !data.positions) { list.innerHTML = `<span class="panel-status error">${data.error ?? 'Failed to load positions'}</span>`; return }
    if (!data.positions.length) { list.innerHTML = '<span class="panel-status">No open positions</span>'; return }
    list.innerHTML = data.positions.map(p => `
      <div class="position-row">
        <span class="pos-symbol">${p.symbol}</span>
        <span class="pos-dir ${p.direction}">${p.direction.toUpperCase()}</span>
        <span class="pos-vol">${p.lots.toFixed(2)} lots</span>
        <span class="pos-price">@ ${p.openPrice.toFixed(5)}</span>
        <button class="small-btn close-pos-btn" data-id="${p.positionId}" data-vol="${p.volume}">Close</button>
      </div>`).join('')
    list.querySelectorAll('.close-pos-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id  = Number((btn as HTMLElement).dataset.id)
        const vol = Number((btn as HTMLElement).dataset.vol)
        if (!confirm(`Close position #${id}?`)) return
        btn.textContent = '…'
        await fetch(`/api/v1/ctrader/positions/${id}/close`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ volume: vol, ...(selectedTradeAccountId ? { accountId: selectedTradeAccountId } : {}) }),
        })
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
    if (selectedTradeAccountId) body.accountId = selectedTradeAccountId
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
          ...(selectedTradeAccountId ? { accountId: selectedTradeAccountId } : {}),
        }),
      })
      const data = await res.json() as { success?: boolean; error?: string }
      if (data.success) {
        el('execute-modal').classList.add('hidden')
        const acct = cachedAccounts.find(a => a.id === selectedTradeAccountId)
        alert(`Order placed successfully${acct ? ` on ${acct.name} (${acct.type.toUpperCase()})` : ''}.`)
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
  volume: number; lots: number; openPrice: number; stopLoss?: number; takeProfit?: number; openTime: number;
  profit?: number; currentPrice?: number;
}

interface PendingOrderRow {
  id: string; pair: string; direction: string; lots: number;
  limitPrice: number; stopLoss?: number; takeProfit?: number;
  placedAt: number; expiresAt: number;
}

function renderPendingOrdersTable(rows: Array<PendingOrderRow & { account: { name: string } }>): void {
  const tableEl = el('pending-orders-table')
  const emptyEl = el('pending-orders-empty')
  if (rows.length === 0) {
    tableEl.classList.add('hidden')
    emptyEl.classList.remove('hidden')
    return
  }
  emptyEl.classList.add('hidden')
  tableEl.classList.remove('hidden')
  el<HTMLTableSectionElement>('pending-orders-body').innerHTML = rows.map(o => {
    const dec = o.pair.includes('JPY') ? 3 : 5
    const dir = o.direction === 'buy' ? 'buy' : 'sell'
    return `<tr>
      <td data-label="Pair">${o.pair}</td>
      <td data-label="Dir" class="${dir}">${dir.toUpperCase()}</td>
      <td data-label="Lots">${o.lots.toFixed(2)}</td>
      <td data-label="Limit Price">${o.limitPrice.toFixed(dec)}</td>
      <td data-label="SL">${o.stopLoss   != null ? o.stopLoss.toFixed(dec)   : '—'}</td>
      <td data-label="TP">${o.takeProfit != null ? o.takeProfit.toFixed(dec) : '—'}</td>
      <td data-label="Placed">${safeDateTime(o.placedAt)}</td>
      <td data-label="Expires">${safeDateTime(o.expiresAt)}</td>
    </tr>`
  }).join('')
}

let positionsAccountFilter: string = 'all'
let historyAccountFilter: string = 'all'

// Populates a Live/Demo grouped account filter dropdown from cachedAccounts, preserving
// the current selection if it's still a valid option (e.g. after a background refresh).
// Shared by Positions and History so both filters behave identically.
function renderAccountFilter(selectId: string, current: string): string {
  const select = el<HTMLSelectElement>(selectId)
  const live = cachedAccounts.filter(a => a.type === 'live')
  const demo = cachedAccounts.filter(a => a.type === 'demo')

  const optgroup = (label: string, accounts: any[]) => accounts.length === 0 ? '' : `
    <optgroup label="${label}">
      ${accounts.map(a => `<option value="${a.id}">${a.name}</option>`).join('')}
    </optgroup>
  `
  select.innerHTML = `<option value="all">All Accounts</option>${optgroup('Live', live)}${optgroup('Demo', demo)}`

  const stillValid = current === 'all' || cachedAccounts.some(a => a.id === current)
  const value = stillValid ? current : 'all'
  select.value = value
  return value
}

async function loadPositions(): Promise<void> {
  el('positions-loading').classList.remove('hidden')
  el('positions-error').classList.add('hidden')
  el('positions-empty').classList.add('hidden')
  el('positions-table').classList.add('hidden')

  try {
    positionsAccountFilter = renderAccountFilter('positions-account-filter', positionsAccountFilter)

    // Pull positions from every connected account so multi-account setups show everything at
    // once, unless the user has scoped down to "All", a type, or one specific account.
    const targets = cachedAccounts.filter(a =>
      a.hasToken && (positionsAccountFilter === 'all' || a.id === positionsAccountFilter)
    )
    const queries = targets.length ? targets : [{ id: '', name: 'Default', type: 'demo' }]

    const results = await Promise.all(queries.map(async (a) => {
      const qs = a.id ? `?accountId=${encodeURIComponent(a.id)}` : ''
      try {
        const res  = await fetch(`/api/v1/ctrader/positions${qs}`)
        const data = await res.json() as { positions?: PositionRow[]; pendingOrders?: PendingOrderRow[]; error?: string }
        if (data.error) return { account: a, positions: [] as PositionRow[], pendingOrders: [] as PendingOrderRow[], error: data.error }
        return { account: a, positions: data.positions ?? [], pendingOrders: data.pendingOrders ?? [], error: null as string | null }
      } catch (e) {
        return { account: a, positions: [] as PositionRow[], pendingOrders: [] as PendingOrderRow[], error: (e as Error).message }
      }
    }))

    renderPendingOrdersTable(results.flatMap(r => r.pendingOrders.map(o => ({ ...o, account: r.account }))))

    const rows = results.flatMap(r => r.positions.map(p => ({ ...p, account: r.account })))
    const errors = results.filter(r => r.error).map(r => `${r.account.name}: ${r.error}`)

    if (rows.length === 0) {
      el('positions-empty').classList.remove('hidden')
      if (errors.length) {
        el<HTMLElement>('positions-error').textContent = errors.join(' · ')
        el('positions-error').classList.remove('hidden')
      }
      return
    }

    const tbody = el<HTMLTableSectionElement>('positions-body')
    tbody.innerHTML = rows.map(p => {
      const lots     = p.lots.toFixed(2)
      const dec      = p.symbol.includes('JPY') ? 3 : 5
      const dir      = p.direction === 'buy' ? 'buy' : 'sell'
      const date     = safeDateTime(p.openTime)
      const typeCls  = p.account.type === 'live' ? 'acct-badge-live' : 'acct-badge-demo'
      const acctCell = `<span class="acct-type-badge ${typeCls}">${p.account.type.toUpperCase()}</span> ${p.account.name}`
      return `<tr>
        <td data-label="Account">${acctCell}</td>
        <td data-label="Pair">${p.symbol}</td>
        <td data-label="Dir" class="${dir}">${dir.toUpperCase()}</td>
        <td data-label="Lots">${lots}</td>
        <td data-label="Open">${p.openPrice.toFixed(dec)}</td>
        <td data-label="SL">${p.stopLoss  ? p.stopLoss.toFixed(dec)  : '—'}</td>
        <td data-label="TP">${p.takeProfit ? p.takeProfit.toFixed(dec) : '—'}</td>
        <td data-label="Opened">${date}</td>
        <td data-label=""><button class="close-btn" data-id="${p.positionId}" data-vol="${p.volume}" data-acct-id="${p.account.id}">Close</button></td>
      </tr>`
    }).join('')

    tbody.querySelectorAll<HTMLButtonElement>('.close-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Close this position?')) return
        btn.textContent = 'Closing…'
        btn.disabled = true
        try {
          const acctId = btn.dataset.acctId
          const res = await fetch(`/api/v1/ctrader/positions/${btn.dataset.id}/close`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ volume: parseInt(btn.dataset.vol!), ...(acctId ? { accountId: acctId } : {}) }),
          })
          const d = await res.json() as { success?: boolean; error?: string }
          if (d.success) loadPositions()
          else alert(`Close failed: ${d.error}`)
        } catch (e) { alert(`Error: ${(e as Error).message}`) }
      })
    })

    el('positions-table').classList.remove('hidden')
    if (errors.length) {
      el<HTMLElement>('positions-error').textContent = `Some accounts failed to load: ${errors.join(' · ')}`
      el('positions-error').classList.remove('hidden')
    }
  } catch (e) {
    el<HTMLElement>('positions-error').textContent = (e as Error).message
    el('positions-error').classList.remove('hidden')
  } finally {
    el('positions-loading').classList.add('hidden')
  }
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
interface PeriodStats {
  trades: number; wins: number; losses: number; winRate: number; pnlGbp: number; pnlPips: number
}
interface DashboardSummary {
  periods: { today: PeriodStats; week: PeriodStats; month: PeriodStats; year: PeriodStats }
  allTime: PeriodStats
  currentStreak: { type: 'win' | 'loss' | null; count: number }
  equityCurve: Array<{ t: number; cum: number }>
  byPair: Record<string, PeriodStats>
}

function renderPeriodCard(s: PeriodStats): string {
  const pnlCls = s.pnlGbp > 0 ? 'buy' : s.pnlGbp < 0 ? 'sell' : ''
  return `
    <div class="dash-period-row"><span>Trades</span><span>${s.trades}</span></div>
    <div class="dash-period-row"><span>Wins / Losses</span><span><span class="buy">${s.wins}</span> / <span class="sell">${s.losses}</span></span></div>
    <div class="dash-period-row"><span>Win Rate</span><span>${s.trades > 0 ? s.winRate.toFixed(1) + '%' : '—'}</span></div>
    <div class="dash-period-row"><span>P&amp;L</span><span class="${pnlCls}">£${s.pnlGbp.toFixed(2)}</span></div>
    <div class="dash-period-row"><span>Pips</span><span class="${pnlCls}">${s.pnlPips.toFixed(1)}</span></div>
  `
}

// Circular win-rate progress ring, drawn as a single SVG.
function renderWinRateRing(s: PeriodStats): string {
  const pct    = s.trades > 0 ? s.winRate : 0
  const r      = 42
  const circ   = 2 * Math.PI * r
  const offset = circ * (1 - pct / 100)
  const cls    = pct >= 50 ? 'buy' : 'sell'
  return `
    <svg viewBox="0 0 100 100" class="dash-ring">
      <circle cx="50" cy="50" r="${r}" class="dash-ring-track" />
      <circle cx="50" cy="50" r="${r}" class="dash-ring-progress ${cls}"
        stroke-dasharray="${circ}" stroke-dashoffset="${offset}" />
      <text x="50" y="46" text-anchor="middle" class="dash-ring-pct">${s.trades > 0 ? pct.toFixed(0) + '%' : '—'}</text>
      <text x="50" y="63" text-anchor="middle" class="dash-ring-sub">${s.wins}W / ${s.losses}L</text>
    </svg>
  `
}

// Cumulative realised P&L line chart with area fill.
function renderDashboardEquityCurve(points: Array<{ t: number; cum: number }>): string {
  if (points.length < 2) {
    return '<div class="bot-no-signals">Not enough closed trades yet for an equity curve.</div>'
  }
  const W = 800, H = 220, PAD = 8
  const minCum = Math.min(0, ...points.map(p => p.cum))
  const maxCum = Math.max(0, ...points.map(p => p.cum))
  const range  = maxCum - minCum || 1
  const xAt = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2)
  const yAt = (cum: number) => H - PAD - ((cum - minCum) / range) * (H - PAD * 2)

  const linePts = points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.cum).toFixed(1)}`).join(' ')
  const zeroY   = yAt(0).toFixed(1)
  const areaPts = `${xAt(0).toFixed(1)},${zeroY} ${linePts} ${xAt(points.length - 1).toFixed(1)},${zeroY}`
  const last    = points[points.length - 1]!
  const cls     = last.cum >= 0 ? 'buy' : 'sell'

  return `
    <svg viewBox="0 0 ${W} ${H}" class="dash-equity-svg" preserveAspectRatio="none">
      <line x1="${PAD}" y1="${zeroY}" x2="${W - PAD}" y2="${zeroY}" class="dash-equity-zero" />
      <polygon points="${areaPts}" class="dash-equity-area ${cls}" />
      <polyline points="${linePts}" class="dash-equity-line ${cls}" />
      <circle cx="${xAt(points.length - 1).toFixed(1)}" cy="${yAt(last.cum).toFixed(1)}" r="3.5" class="dash-equity-dot ${cls}" />
    </svg>
  `
}

// Grouped win/loss bar chart across the four calendar periods.
function renderPeriodBars(p: { today: PeriodStats; week: PeriodStats; month: PeriodStats; year: PeriodStats }): string {
  const rows = [
    { label: 'Today', s: p.today },
    { label: 'Week',  s: p.week },
    { label: 'Month', s: p.month },
    { label: 'Year',  s: p.year },
  ]
  const max = Math.max(1, ...rows.map(r => Math.max(r.s.wins, r.s.losses)))
  return `<div class="dash-bar-chart">
    ${rows.map(r => `
      <div class="dash-bar-group">
        <div class="dash-bar-pair">
          <div class="dash-bar buy" style="height:${(r.s.wins / max * 100).toFixed(0)}%" title="${r.s.wins} wins"></div>
          <div class="dash-bar sell" style="height:${(r.s.losses / max * 100).toFixed(0)}%" title="${r.s.losses} losses"></div>
        </div>
        <div class="dash-bar-label">${r.label}</div>
      </div>
    `).join('')}
  </div>`
}

// Horizontal P&L-by-pair bars, sorted by the backend (best to worst).
function renderPairBars(byPair: Record<string, PeriodStats>): string {
  const entries = Object.entries(byPair)
  if (entries.length === 0) return '<div class="bot-no-signals">No closed trades yet.</div>'
  const max = Math.max(1, ...entries.map(([, s]) => Math.abs(s.pnlGbp)))
  return `<div class="dash-pair-bars">
    ${entries.map(([pair, s]) => {
      const cls = s.pnlGbp >= 0 ? 'buy' : 'sell'
      const pct = Math.abs(s.pnlGbp) / max * 100
      return `
        <div class="dash-pair-bar-row">
          <span class="dash-pair-bar-label">${pair}</span>
          <div class="dash-pair-bar-track">
            <div class="dash-pair-bar-fill ${cls}" style="width:${pct.toFixed(0)}%"></div>
          </div>
          <span class="dash-pair-bar-value ${cls}">£${s.pnlGbp.toFixed(2)}</span>
        </div>
      `
    }).join('')}
  </div>`
}

// ── Dashboard scope: Demo/Live + per-account drill-down ────────────────────────
let dashboardAccountType: 'live' | 'demo' = 'live'
let dashboardSelectedAccountId: string = 'all'

function accountsOfDashboardType(): any[] {
  return cachedAccounts.filter(a => a.type === dashboardAccountType)
}

function renderDashboardAccountTabs(): void {
  // Keep the Live/Demo type tab in sync with dashboardAccountType — needed because that
  // value can change without a click (e.g. the default-account selection on first load),
  // and the HTML's hardcoded "active" class on Live otherwise never gets corrected.
  document.querySelectorAll<HTMLButtonElement>('.dash-type-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === dashboardAccountType)
  })

  const wrap = el('dash-account-tabs')
  const accounts = accountsOfDashboardType()

  if (accounts.length === 0) {
    wrap.innerHTML = ''
    return
  }

  const tabs = [{ id: 'all', name: `All ${dashboardAccountType === 'live' ? 'Live' : 'Demo'}` }, ...accounts]
  wrap.innerHTML = tabs.map(a => `
    <button class="dash-account-tab ${a.id === dashboardSelectedAccountId ? 'active' : ''}" data-acct-id="${a.id}">${a.name}</button>
  `).join('')

  wrap.querySelectorAll<HTMLButtonElement>('.dash-account-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      dashboardSelectedAccountId = btn.dataset.acctId!
      wrap.querySelectorAll('.dash-account-tab').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      loadDashboard()
    })
  })
}

function initDashboardTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('.dash-type-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type as 'live' | 'demo'
      if (type === dashboardAccountType) return
      dashboardAccountType = type
      dashboardSelectedAccountId = 'all'
      document.querySelectorAll('.dash-type-tab').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      renderDashboardAccountTabs()
      loadDashboard()
    })
  })
}

// Runs the same close-detection/outcome-recording pass as the hourly cron, on demand.
// The cron can leave a just-closed trade unrecorded for up to an hour — call this before
// reading Journal/Dashboard data so a trade that closed seconds ago still shows up now,
// rather than making the user wait for the next scheduled tick. Best-effort: the cron
// remains the real safety net, so a failure here shouldn't block the page from loading.
async function triggerMonitor(): Promise<void> {
  try { await fetch('/api/v1/bot/monitor', { method: 'POST' }) } catch { /* cron will catch it later */ }
}

async function loadDashboard(): Promise<void> {
  el('dashboard-loading').classList.remove('hidden')
  el('dashboard-error').classList.add('hidden')
  el('dashboard-content').classList.add('hidden')

  try {
    // Fire-and-forget: triggerMonitor() is a best-effort reconciliation pass (its own doc
    // comment says as much) — it used to be awaited here, which meant the *entire* dashboard
    // stayed hidden behind whatever a live cTrader sync happened to cost that tick (measured
    // 10-16s in production). The positions fetch below already queries live truth directly,
    // so nothing displayed here actually depends on this having finished first.
    void triggerMonitor()

    // cachedAccounts (and the balance figure on it) is only ever written by loadAccounts() —
    // without this, the Dashboard's own "Refresh" button refreshed everything except the
    // account balance, which stayed frozen at whatever it was on initial page load.
    await loadAccounts()
    renderDashboardAccountTabs()

    // Scope to the selected Demo/Live type, and to a single account if drilled down —
    // "All" means every connected account of the selected type, not every account overall.
    const typeAccounts = accountsOfDashboardType()
    const queries = typeAccounts.filter(a =>
      a.hasToken && (dashboardSelectedAccountId === 'all' || a.id === dashboardSelectedAccountId)
    )

    if (typeAccounts.length === 0) {
      el('dashboard-loading').classList.add('hidden')
      el('dashboard-empty').textContent = `No ${dashboardAccountType === 'live' ? 'Live' : 'Demo'} accounts added yet — add one in the Accounts tab.`
      el('dashboard-empty').classList.remove('hidden')
      return
    }
    if (queries.length === 0) {
      el('dashboard-loading').classList.add('hidden')
      el('dashboard-empty').textContent = `Selected account isn't connected yet — connect it in the Accounts tab.`
      el('dashboard-empty').classList.remove('hidden')
      return
    }
    el('dashboard-empty').classList.add('hidden')

    // Balance is already cached on each account (kept fresh by loadAccounts() above) — show
    // it immediately rather than waiting on either section below.
    const totalBalance = queries.reduce((sum, a) => sum + (a.balance ?? 0), 0)
    el<HTMLElement>('dash-balance').textContent = totalBalance > 0 ? `£${totalBalance.toFixed(2)}` : '—'

    el('dashboard-loading').classList.add('hidden')
    el('dashboard-content').classList.remove('hidden')

    // Two independent sections with very different costs — summary is a D1/KV read (fast),
    // positions is a live cTrader round-trip per account (can take seconds). Each renders
    // into its own DOM region as soon as it resolves, instead of one gating the other.
    void loadDashboardSummary(queries)
    void loadDashboardPositions(queries)
  } catch (e) {
    el('dashboard-loading').classList.add('hidden')
    el<HTMLElement>('dashboard-error').textContent = (e as Error).message
    el('dashboard-error').classList.remove('hidden')
  }
}

async function loadDashboardSummary(queries: any[]): Promise<void> {
  try {
    const accountIdsParam = queries.map(a => a.id).join(',')
    const res     = await fetch(`/api/v1/dashboard/summary?accountIds=${encodeURIComponent(accountIdsParam)}`)
    const summary = await res.json() as DashboardSummary

    const streakEl = el<HTMLElement>('dash-streak')
    if (summary.currentStreak.type) {
      const isPlural = summary.currentStreak.count !== 1
      const noun = summary.currentStreak.type === 'win'
        ? (isPlural ? 'wins' : 'win')
        : (isPlural ? 'losses' : 'loss')
      streakEl.textContent = `${summary.currentStreak.count} ${noun}`
      streakEl.className = `dash-card-value ${summary.currentStreak.type === 'win' ? 'buy' : 'sell'}`
    } else {
      streakEl.textContent = '—'
    }

    el('dash-period-today').innerHTML = renderPeriodCard(summary.periods.today)
    el('dash-period-week').innerHTML  = renderPeriodCard(summary.periods.week)
    el('dash-period-month').innerHTML = renderPeriodCard(summary.periods.month)
    el('dash-period-year').innerHTML  = renderPeriodCard(summary.periods.year)

    el('dash-winrate-ring').innerHTML  = renderWinRateRing(summary.allTime)
    el('dash-equity-curve').innerHTML  = renderDashboardEquityCurve(summary.equityCurve)
    el('dash-period-bars').innerHTML   = renderPeriodBars(summary.periods)
    el('dash-pair-bars').innerHTML     = renderPairBars(summary.byPair)
  } catch (e) {
    console.error('[Dashboard] Failed to load summary:', e)
    el('dash-streak').textContent = '—'
  }
}

async function loadDashboardPositions(queries: any[]): Promise<void> {
  el('dash-positions-loading').classList.remove('hidden')
  try {
    const positionResults = await Promise.all(queries.map(async (a) => {
      try {
        const res  = await fetch(`/api/v1/ctrader/positions?accountId=${encodeURIComponent(a.id)}`)
        const data = await res.json() as { positions?: PositionRow[]; pendingOrders?: PendingOrderRow[] }
        return { account: a, positions: data.positions ?? [], pendingOrders: data.pendingOrders ?? [] }
      } catch {
        return { account: a, positions: [] as PositionRow[], pendingOrders: [] as PendingOrderRow[] }
      }
    }))

    const positions     = positionResults.flatMap(r => r.positions.map(p => ({ ...p, account: r.account })))
    const pendingOrders = positionResults.flatMap(r => r.pendingOrders.map(o => ({ ...o, account: r.account })))
    const openPnl        = positions.reduce((sum: number, p: any) => sum + (p.profit ?? 0), 0)

    el<HTMLElement>('dash-open-count').textContent = String(positions.length)
    const openPnlEl = el<HTMLElement>('dash-open-pnl')
    if (positions.length > 0 && Number.isFinite(openPnl)) {
      openPnlEl.textContent = `${openPnl >= 0 ? '+' : ''}£${openPnl.toFixed(2)} unrealised`
      openPnlEl.className = `dash-card-sub ${openPnl > 0 ? 'buy' : openPnl < 0 ? 'sell' : ''}`
    } else {
      openPnlEl.textContent = ''
    }

    const listEl = el('dash-positions-list')
    if (positions.length === 0) {
      listEl.innerHTML = '<div class="bot-no-signals">No open positions.</div>'
    } else {
      const pipFactor = (pair: string) => pair.includes('JPY') ? 100 : 10000
      listEl.innerHTML = positions.map((p: any) => {
        const dir = p.direction === 'buy' ? 'buy' : 'sell'
        const dec = p.symbol.includes('JPY') ? 3 : 5
        const pf  = pipFactor(p.symbol)
        const cur = p.currentPrice

        const priceCell = cur != null
          ? `<span>Current <b>${cur.toFixed(dec)}</b></span>`
          : `<span class="dash-position-stale">Current —</span>`

        const slPips = cur != null && p.stopLoss   != null ? Math.abs(cur - p.stopLoss)   * pf : null
        const tpPips = cur != null && p.takeProfit != null ? Math.abs(cur - p.takeProfit) * pf : null

        const slCell = p.stopLoss != null
          ? `<span>SL <b class="sell">${p.stopLoss.toFixed(dec)}</b>${slPips != null ? ` <span class="dash-position-dist">(${slPips.toFixed(1)}p)</span>` : ''}</span>`
          : `<span>SL <b class="sell">—</b></span>`
        const tpCell = p.takeProfit != null
          ? `<span>TP <b class="buy">${p.takeProfit.toFixed(dec)}</b>${tpPips != null ? ` <span class="dash-position-dist">(${tpPips.toFixed(1)}p)</span>` : ''}</span>`
          : `<span>TP <b class="buy">—</b></span>`

        return `<div class="dash-position-row">
          <div class="dash-position-main">
            <span class="${dir}">${dir.toUpperCase()}</span>
            <span>${p.symbol}</span>
            <span>${p.lots.toFixed(2)} lots</span>
            <span>${p.account.name}</span>
          </div>
          <div class="dash-position-levels">
            ${priceCell}
            ${slCell}
            ${tpCell}
          </div>
        </div>`
      }).join('')
    }

    const pendingWrap = el('dash-pending-orders-wrap')
    if (pendingOrders.length === 0) {
      pendingWrap.classList.add('hidden')
    } else {
      pendingWrap.classList.remove('hidden')
      el('dash-pending-orders-list').innerHTML = pendingOrders.map((o: any) => {
        const dir = o.direction === 'buy' ? 'buy' : 'sell'
        const dec = o.pair.includes('JPY') ? 3 : 5
        return `<div class="dash-position-row">
          <div class="dash-position-main">
            <span class="${dir}">${dir.toUpperCase()}</span>
            <span>${o.pair}</span>
            <span>${o.lots.toFixed(2)} lots</span>
            <span>${o.account.name}</span>
          </div>
          <div class="dash-position-levels">
            <span>Limit <b>${o.limitPrice.toFixed(dec)}</b></span>
            <span>SL <b class="sell">${o.stopLoss   != null ? o.stopLoss.toFixed(dec)   : '—'}</b></span>
            <span>TP <b class="buy">${o.takeProfit != null ? o.takeProfit.toFixed(dec) : '—'}</b></span>
            <span>Expires <b>${safeDateTime(o.expiresAt)}</b></span>
          </div>
        </div>`
      }).join('')
    }
  } catch (e) {
    console.error('[Dashboard] Failed to load positions:', e)
    el('dash-positions-list').innerHTML = '<div class="bot-no-signals" style="color:var(--sell)">Failed to load positions.</div>'
  } finally {
    el('dash-positions-loading').classList.add('hidden')
  }
}

// ── History ───────────────────────────────────────────────────────────────────
interface TradeRow {
  positionId: number; symbol: string; direction: string; lots: number;
  entryPrice: number; openTime: number;
  closePrice?: number; closeTime?: number; profit?: number;
}

async function loadHistory(): Promise<void> {
  const days = (el<HTMLSelectElement>('history-days')).value
  el('history-loading').classList.remove('hidden')
  el('history-error').classList.add('hidden')
  el('history-empty').classList.add('hidden')
  el('history-table').classList.add('hidden')

  try {
    historyAccountFilter = renderAccountFilter('history-account-filter', historyAccountFilter)

    // Same multi-account fan-out as loadPositions(): pull every connected account's history
    // unless the user has scoped down to "All" or one specific account.
    const targets = cachedAccounts.filter(a =>
      a.hasToken && (historyAccountFilter === 'all' || a.id === historyAccountFilter)
    )
    const queries = targets.length ? targets : [{ id: '', name: 'Default', type: 'demo' }]

    const results = await Promise.all(queries.map(async (a) => {
      const qs = a.id ? `&accountId=${encodeURIComponent(a.id)}` : ''
      try {
        const res  = await fetch(`/api/v1/ctrader/history?days=${days}${qs}`)
        const data = await res.json() as { trades?: TradeRow[]; error?: string }
        if (data.error) return { account: a, trades: [] as TradeRow[], error: data.error }
        return { account: a, trades: data.trades ?? [], error: null as string | null }
      } catch (e) {
        return { account: a, trades: [] as TradeRow[], error: (e as Error).message }
      }
    }))

    const rows = results.flatMap(r => r.trades.map(t => ({ ...t, account: r.account })))
    const errors = results.filter(r => r.error).map(r => `${r.account.name}: ${r.error}`)

    if (rows.length === 0) {
      el('history-empty').classList.remove('hidden')
      if (errors.length) {
        el<HTMLElement>('history-error').textContent = errors.join(' · ')
        el('history-error').classList.remove('hidden')
      }
      return
    }

    const tbody = el<HTMLTableSectionElement>('history-body')
    tbody.innerHTML = rows.map(t => {
      const lots     = t.lots.toFixed(2)
      const dec      = t.symbol.includes('JPY') ? 3 : 5
      const dir      = t.direction === 'buy' ? 'buy' : 'sell'
      // One row per trade (entry + exit merged) — "Open" here always means genuinely still
      // open, not "this is just the entry-side deal of an already-closed trade".
      const date     = safeDateTime(t.closeTime ?? t.openTime)
      const pnl      = t.profit != null ? t.profit.toFixed(2) : null
      const pnlCls   = pnl && parseFloat(pnl) >= 0 ? 'profit-positive' : 'profit-negative'
      const typeCls  = t.account.type === 'live' ? 'acct-badge-live' : 'acct-badge-demo'
      const acctCell = `<span class="acct-type-badge ${typeCls}">${t.account.type.toUpperCase()}</span> ${t.account.name}`
      return `<tr>
        <td data-label="Account">${acctCell}</td>
        <td data-label="Pair">${t.symbol}</td>
        <td data-label="Dir" class="${dir}">${dir.toUpperCase()}</td>
        <td data-label="Lots">${lots}</td>
        <td data-label="Entry">${t.entryPrice.toFixed(dec)}</td>
        <td data-label="Close">${t.closePrice != null ? t.closePrice.toFixed(dec) : 'Open'}</td>
        <td data-label="Date">${date}</td>
        <td data-label="P&amp;L" class="${pnlCls}">${pnl ? `£${pnl}` : '—'}</td>
      </tr>`
    }).join('')

    if (errors.length) {
      el<HTMLElement>('history-error').textContent = errors.join(' · ')
      el('history-error').classList.remove('hidden')
    }
    el('history-table').classList.remove('hidden')
  } catch (e) {
    el<HTMLElement>('history-error').textContent = (e as Error).message
    el('history-error').classList.remove('hidden')
  } finally {
    el('history-loading').classList.add('hidden')
  }
}

// ── Risk settings ─────────────────────────────────────────────────────────────
// Updates the sidebar's "Risk: £X per trade" note (Chart tab only). The old top-bar "⚙ Risk"
// button/dropdown that used to also show this was removed — it had no controls left (risk %
// and R:R moved to per-bot settings long ago), duplicated the balance the Trade tab's own
// sizing display and the Dashboard already show, and appeared on every tab regardless of
// relevance.
function updateRiskDisplay(): void {
  const noteEl = document.getElementById('risk-note-amount')
  if (noteEl) noteEl.textContent = `£${accountBalance.toFixed(2)}`
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
  initMobileMore()
  initDashboardTabs()
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
  initNews()
  initCTrader()
  initExecuteModal()
  document.getElementById('refresh-positions')?.addEventListener('click', loadPositions)
  document.getElementById('positions-account-filter')?.addEventListener('change', (e) => {
    positionsAccountFilter = (e.target as HTMLSelectElement).value
    loadPositions()
  })
  document.getElementById('refresh-dashboard')?.addEventListener('click', loadDashboard)
  document.getElementById('refresh-history')?.addEventListener('click', loadHistory)
  document.getElementById('history-days')?.addEventListener('change', loadHistory)
  document.getElementById('history-account-filter')?.addEventListener('change', (e) => {
    historyAccountFilter = (e.target as HTMLSelectElement).value
    loadHistory()
  })
  initJournal()
  initAccounts()
  initBot()
  initBacktestTab()
  initMobile()

  // Update pair/TF on chart after URL params applied
  chart.setPair(activePair)
  tradePanel.setPair(activePair)

  loadAll()
  // Dashboard is now the default landing tab — load it up front rather than waiting for a
  // tab click. loadDashboard() already awaits loadAccounts() itself (see below) — chaining
  // a second loadAccounts() call here just fired a redundant fetch a few milliseconds after
  // the one initAccounts() already kicked off.
  loadDashboard()
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
      // Fire-and-forget — see the comment on triggerMonitor() itself. Journal reads from
      // D1 either way; a trade that closed seconds ago just won't have its outcome recorded
      // until this background pass finishes, same as before, but the page no longer waits
      // 10-16s for a live cTrader sync before showing anything.
      void triggerMonitor()
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
        const createdDate = new Date(e.createdAt)
        const dateStr  = `${createdDate.toLocaleDateString('en-GB', { day:'2-digit', month:'short' })} ${createdDate.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })}`
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
          <td data-label="Date">${dateStr}</td>
          <td data-label="Pair">${e.pair}</td>
          <td data-label="Dir" style="color:${dirColor};font-weight:600">${e.direction.toUpperCase()}</td>
          <td data-label="Entry">${e.entryPrice}</td>
          <td data-label="SL">${e.stopLoss}</td>
          <td data-label="TP">${e.target}</td>
          <td data-label="R:R">${rr}</td>
          <td data-label="Session" style="font-size:10px;color:var(--muted)">${session}</td>
          <td data-label="Signal" style="font-size:10px;color:var(--muted)">${signal}</td>
          <td data-label="Result">${resultBadge}</td>
          <td data-label="Pips" style="color:${pipsColor};font-family:monospace">${pips}</td>
          <td data-label="">${actionBtn}</td>
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

// ── Accounts Panel ────────────────────────────────────────────────────────────
function initAccounts(): void {
  const addBtn     = document.getElementById('account-add-btn')!
  const modal      = document.getElementById('account-add-modal')!
  const cancelBtn  = document.getElementById('acct-add-cancel-btn')!
  const confirmBtn = document.getElementById('acct-add-confirm-btn') as HTMLButtonElement

  addBtn.addEventListener('click', () => modal.classList.remove('hidden'))
  cancelBtn.addEventListener('click', () => modal.classList.add('hidden'))
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden') })

  confirmBtn.addEventListener('click', async () => {
    const name    = (document.getElementById('acct-new-name')       as HTMLInputElement).value.trim()
    const type    = (document.getElementById('acct-new-type')       as HTMLSelectElement).value
    const ctId    = (document.getElementById('acct-new-ctrader-id') as HTMLInputElement).value.trim()
    const currency= (document.getElementById('acct-new-currency')   as HTMLSelectElement).value
    if (!name || !ctId) { alert('Name and cTrader Account ID are required'); return }

    confirmBtn.textContent = 'Adding…'
    confirmBtn.disabled    = true
    try {
      const res = await fetch('/api/v1/ctrader/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, ctraderAccountId: ctId, currency }),
      })
      if (!res.ok) throw new Error(await res.text())
      modal.classList.add('hidden')
      ;(document.getElementById('acct-new-name')       as HTMLInputElement).value = ''
      ;(document.getElementById('acct-new-ctrader-id') as HTMLInputElement).value = ''
      await loadAccounts()
    } catch (e: any) {
      alert(`Failed: ${e.message}`)
    } finally {
      confirmBtn.textContent = 'Add Account'
      confirmBtn.disabled    = false
    }
  })

  initialAccountsLoad = loadAccounts()
  initDiscoverAccounts()
}

function initDiscoverAccounts(): void {
  const btn  = document.getElementById('discover-accounts-btn') as HTMLButtonElement
  const list = document.getElementById('discover-accounts-list')!

  btn.addEventListener('click', async () => {
    btn.textContent = 'Checking…'
    btn.disabled = true
    list.innerHTML = ''
    try {
      const res  = await fetch('/api/v1/ctrader/discover-accounts')
      const data = await res.json() as {
        tokenAccountId?: string
        accounts?: Array<{ ctidTraderAccountId: number; isLive: boolean; traderLogin: number; brokerName: string; alreadyAdded: boolean }>
        error?: string
      }
      if (data.error) { list.innerHTML = `<div class="bot-no-signals" style="color:var(--sell)">${data.error}</div>`; return }

      const accounts = data.accounts ?? []
      if (accounts.length === 0) {
        list.innerHTML = '<div class="bot-no-signals">No accounts found on this cTrader ID.</div>'
        return
      }

      list.innerHTML = accounts.map(a => `
        <div class="discover-account-row">
          <span class="acct-type-badge ${a.isLive ? 'acct-badge-live' : 'acct-badge-demo'}">${a.isLive ? 'LIVE' : 'DEMO'}</span>
          <span>${a.brokerName || 'Trading Account'} #${a.ctidTraderAccountId}</span>
          ${a.alreadyAdded
            ? '<span class="discover-account-added">✓ Added</span>'
            : `<button class="small-btn primary-btn discover-add-btn" data-id="${a.ctidTraderAccountId}" data-live="${a.isLive}">+ Add</button>`}
        </div>
      `).join('')

      list.querySelectorAll<HTMLButtonElement>('.discover-add-btn').forEach(addBtn => {
        addBtn.addEventListener('click', async () => {
          addBtn.textContent = 'Adding…'
          addBtn.disabled = true
          try {
            const res = await fetch('/api/v1/ctrader/accounts/adopt', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ctidTraderAccountId: Number(addBtn.dataset.id),
                isLive: addBtn.dataset.live === 'true',
                tokenAccountId: data.tokenAccountId,
              }),
            })
            if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? 'Failed to add account')
            await loadAccounts()
            btn.click() // refresh the discovery list so this account now shows "✓ Added"
          } catch (e: any) {
            alert(`Failed: ${e.message}`)
            addBtn.textContent = '+ Add'
            addBtn.disabled = false
          }
        })
      })
    } catch (e: any) {
      list.innerHTML = `<div class="bot-no-signals" style="color:var(--sell)">${e.message}</div>`
    } finally {
      btn.textContent = '↻ Check Pepperstone'
      btn.disabled = false
    }
  })
}

async function loadAccounts(): Promise<void> {
  const list = document.getElementById('accounts-list')!
  try {
    // Fetch every account (including deactivated ones) once — the Accounts management list
    // below needs to show inactive accounts so they can be reactivated, while cachedAccounts
    // (read by the Dashboard, Positions, Bot assignment, etc.) is filtered down to active
    // ones only, so a deactivated account's data disappears everywhere else automatically.
    const res      = await fetch('/api/v1/ctrader/accounts?includeInactive=true')
    const accounts = await res.json() as any[]
    cachedAccounts = accounts.filter(a => a.isActive)

    if (!accounts.length) {
      list.innerHTML = '<div class="bot-no-signals">No accounts. Click + Add Account to connect cTrader.</div>'
    } else {
      list.innerHTML = accounts.map(renderAccountRow).join('')
      attachAccountRowEvents()
    }
    updateAccountSelector(cachedAccounts)
    applyDefaultAccountSelection()
  } catch (e: any) {
    list.innerHTML = `<div class="bot-no-signals" style="color:var(--sell)">Error: ${e.message}</div>`
  }
}

// Points Dashboard/Positions/History at the default account on first load, once accounts
// are known. Runs only once per page load — after that, whatever the user has selected wins,
// even if loadAccounts() is called again later (e.g. after a Connect/Deactivate action).
function applyDefaultAccountSelection(): void {
  if (appliedDefaultAccountSelection) return
  appliedDefaultAccountSelection = true
  const defaultAccount = cachedAccounts.find(a => a.isDefault)
  if (!defaultAccount) return

  dashboardAccountType       = defaultAccount.type
  dashboardSelectedAccountId = defaultAccount.id
  positionsAccountFilter     = defaultAccount.id
  historyAccountFilter       = defaultAccount.id
}

const CURRENCY_SYMBOLS: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' }

function formatBalance(a: any): string {
  if (a.balance == null) return '—'
  const sym = CURRENCY_SYMBOLS[a.currency] ?? ''
  return `${sym}${a.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function renderAccountRow(a: any): string {
  const connected = !!a.hasToken
  const statusDot = connected ? '●' : '○'
  const statusCls = connected ? 'acct-status-connected' : 'acct-status-pending'
  const statusLbl = connected ? 'Connected' : 'Not connected'
  const typeCls   = a.type === 'live' ? 'acct-badge-live' : 'acct-badge-demo'
  const typeLabel = a.type === 'live' ? 'LIVE' : 'DEMO'

  const connectBtn = connected
    ? `<button class="small-btn acct-disconnect-btn" data-acct-id="${a.id}">Disconnect</button>`
    : `<button class="small-btn primary-btn acct-connect-btn" data-acct-id="${a.id}">Connect</button>`
  // Deactivating (not deleting) keeps credentials and history intact — it just hides the
  // account from the Dashboard, Positions, Bot assignment, etc. until switched back on.
  const activeToggleBtn = a.isActive
    ? `<button class="small-btn acct-deactivate-btn" data-acct-id="${a.id}">Deactivate</button>`
    : `<button class="small-btn primary-btn acct-activate-btn" data-acct-id="${a.id}">Activate</button>`
  const refreshBtn = connected
    ? `<button class="small-btn acct-refresh-balance-btn" data-acct-id="${a.id}" title="Refresh balance">↻</button>`
    : ''
  // The default account is what Dashboard/Positions/History etc. show initially instead
  // of "All" — only one account can hold it at a time (enforced server-side).
  const defaultToggleBtn = a.isDefault
    ? `<button class="small-btn primary-btn acct-unset-default-btn" data-acct-id="${a.id}">★ Default</button>`
    : `<button class="small-btn acct-set-default-btn" data-acct-id="${a.id}">☆ Set Default</button>`

  return `<div class="account-row ${a.isActive ? '' : 'account-row-inactive'}" data-acct-id="${a.id}">
    <div class="account-row-left">
      <span class="account-name">${a.name}</span>
      <span class="acct-type-badge ${typeCls}">${typeLabel}</span>
      ${a.isActive ? '' : '<span class="acct-inactive-badge">INACTIVE</span>'}
      ${a.isDefault ? '<span class="acct-default-badge">DEFAULT</span>' : ''}
      <span class="account-meta">#${a.ctraderAccountId} · ${a.currency}</span>
      <span class="account-balance">${formatBalance(a)}</span>
    </div>
    <div class="account-row-right">
      <span class="${statusCls}">${statusDot} ${statusLbl}</span>
      ${refreshBtn}
      ${connectBtn}
      ${defaultToggleBtn}
      ${activeToggleBtn}
    </div>
  </div>`
}

function attachAccountRowEvents(): void {
  document.querySelectorAll<HTMLButtonElement>('.acct-connect-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      window.location.href = `/auth/ctrader?accountId=${btn.dataset.acctId}`
    })
  })
  document.querySelectorAll<HTMLButtonElement>('.acct-disconnect-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.acctId!
      btn.textContent = '…'
      btn.disabled    = true
      await fetch(`/api/v1/ctrader/accounts/${id}/disconnect`, { method: 'POST' })
      await loadAccounts()
    })
  })
  document.querySelectorAll<HTMLButtonElement>('.acct-deactivate-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.textContent = '…'
      btn.disabled = true
      await fetch(`/api/v1/ctrader/accounts/${btn.dataset.acctId}/deactivate`, { method: 'POST' })
      await loadAccounts()
    })
  })
  document.querySelectorAll<HTMLButtonElement>('.acct-activate-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.textContent = '…'
      btn.disabled = true
      await fetch(`/api/v1/ctrader/accounts/${btn.dataset.acctId}/activate`, { method: 'POST' })
      await loadAccounts()
    })
  })
  document.querySelectorAll<HTMLButtonElement>('.acct-set-default-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.textContent = '…'
      btn.disabled = true
      await fetch(`/api/v1/ctrader/accounts/${btn.dataset.acctId}/set-default`, { method: 'POST' })
      await loadAccounts()
    })
  })
  document.querySelectorAll<HTMLButtonElement>('.acct-unset-default-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.textContent = '…'
      btn.disabled = true
      await fetch(`/api/v1/ctrader/accounts/${btn.dataset.acctId}/unset-default`, { method: 'POST' })
      await loadAccounts()
    })
  })
  document.querySelectorAll<HTMLButtonElement>('.acct-refresh-balance-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.textContent = '…'
      btn.disabled    = true
      try {
        await fetch(`/api/v1/ctrader/accounts/${btn.dataset.acctId}/refresh-balance`, { method: 'POST' })
      } catch { /* row will just keep showing the last known balance */ }
      await loadAccounts()
    })
  })
}

function updateAccountSelector(accounts: any[]): void {
  document.querySelectorAll<HTMLSelectElement>('.bot-account-select').forEach(sel => {
    const current = sel.value
    sel.innerHTML = '<option value="">— No account —</option>' +
      accounts.map(a => `<option value="${a.id}">${a.name} (${a.type.toUpperCase()})</option>`).join('')
    if (current) sel.value = current
  })
  // Also populate the bot-creation modal selector
  const newBotSel = document.getElementById('bot-new-account') as HTMLSelectElement | null
  if (newBotSel) {
    const cur = newBotSel.value
    newBotSel.innerHTML = '<option value="">— No account assigned —</option>' +
      accounts.map(a => `<option value="${a.id}">${a.name} (${a.type.toUpperCase()})</option>`).join('')
    if (cur) newBotSel.value = cur
  }

  // Manual trade account selector (Trade tab)
  const tradeSel = document.getElementById('trade-account') as HTMLSelectElement | null
  if (tradeSel) {
    const prev = selectedTradeAccountId
    tradeSel.innerHTML = accounts
      .map(a => `<option value="${a.id}">${a.name} (${a.type.toUpperCase()})${a.hasToken ? '' : ' — not connected'}</option>`)
      .join('')
    const stillExists = accounts.some(a => a.id === prev)
    const fallback     = accounts.find(a => a.hasToken) ?? accounts.find(a => a.id === 'default') ?? accounts[0]
    selectedTradeAccountId = stillExists ? prev : (fallback ? fallback.id : '')
    tradeSel.value = selectedTradeAccountId
    updateTradeConnectionUI()
  }
}

// ── Bot Panel ──────────────────────────────────────────────────────────────
// Uses the bot's own assigned account balance when known; falls back to the
// globally selected/manual balance for bots with no account or no cached balance yet.
function formatBotRiskAmount(botAccountId: string | null | undefined, riskPercent: number): string {
  const acct    = botAccountId ? cachedAccounts.find(a => a.id === botAccountId) : undefined
  const balance = acct?.balance ?? accountBalance
  return `£${(balance * riskPercent / 100).toFixed(2)}`
}

function updateBotRiskDisplay(): void {
  // Re-render all bot risk/trade amounts using each bot's own riskPercent + account balance
  document.querySelectorAll<HTMLElement>('[data-bot-risk-amount]').forEach(el => {
    const pct       = parseFloat(el.dataset['botRiskAmount'] ?? '1')
    const accountId = el.dataset['botAccountId'] || null
    el.textContent  = formatBotRiskAmount(accountId, pct)
  })
}

const PAIR_CATEGORIES: Record<string, string[]> = {
  Forex:       ['EUR/USD', 'GBP/USD', 'GBP/CAD', 'USD/JPY', 'EUR/GBP', 'AUD/USD'],
  Indices:     ['US500', 'NAS100', 'GER40', 'UK100'],
  Commodities: ['XAU/USD', 'XAG/USD', 'WTI/USD', 'BRENT/USD', 'NATGAS', 'COPPER'],
}
const ALL_PAIRS = Object.values(PAIR_CATEGORIES).flat()

// ── Shared bot-card building blocks (used by both live bot cards and test-bot cards) ──────
function buildPairPills(bot: any): string {
  return Object.entries(PAIR_CATEGORIES).map(([category, pairs]) => {
    const pills = pairs.map(p => {
      // Empty pairs falls back to forex-only in the backend scan (bot/engine.ts), not all 16 —
      // mirror that here instead of highlighting every pill.
      const active = bot.pairs.length === 0 ? PAIR_CATEGORIES.Forex.includes(p) : bot.pairs.includes(p)
      return `<span class="bot-pair-pill ${active ? 'active' : ''}" data-pair="${p}" data-bot-id="${bot.id}">${p}</span>`
    }).join('')
    return `<div class="pair-category-group">
      <div class="pair-category-header">
        <span>${category}</span>
        <button type="button" class="pair-category-select-all" data-category="${category}" data-bot-id="${bot.id}">Select all</button>
      </div>
      <div class="bot-card-pairs">${pills}</div>
    </div>`
  }).join('')
}

function buildSettingFields(bot: any): string {
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
    </div>${riskFields}
    <details class="bot-card-advanced">
      <summary>Advanced — setup tuning</summary>
      <div class="bot-card-row">
        <span class="bot-card-label">SL Buffer</span>
        <div class="bot-card-setting">
          <input type="number" min="0" max="2" step="0.05"
            value="${bot.settings.slBufferAtr ?? 0.1}"
            data-bot-id="${bot.id}" data-key="slBufferAtr" />
          <span style="font-size:10px;color:var(--muted)">×ATR beyond line</span>
        </div>
        <span class="bot-card-label" style="margin-left:12px">Break Threshold</span>
        <div class="bot-card-setting">
          <input type="number" min="0.1" max="2" step="0.05"
            value="${bot.settings.breakThresholdAtr ?? 0.5}"
            data-bot-id="${bot.id}" data-key="breakThresholdAtr" />
          <span style="font-size:10px;color:var(--muted)">×ATR</span>
        </div>
      </div>
      <div class="bot-card-row">
        <span class="bot-card-label">Retest Window</span>
        <div class="bot-card-setting">
          <input type="number" min="2" max="20" step="1"
            value="${bot.settings.retestWindowBars ?? 6}"
            data-bot-id="${bot.id}" data-key="retestWindowBars" />
          <span style="font-size:10px;color:var(--muted)">bars</span>
        </div>
        <span class="bot-card-label" style="margin-left:12px">Retest Recency</span>
        <div class="bot-card-setting">
          <input type="number" min="1" max="20" step="1"
            value="${bot.settings.retestRecencyBars ?? 3}"
            data-bot-id="${bot.id}" data-key="retestRecencyBars" />
          <span style="font-size:10px;color:var(--muted)">bars</span>
        </div>
      </div>
      <div class="bot-card-row">
        <span class="bot-card-label">Touch Tolerance</span>
        <div class="bot-card-setting">
          <input type="number" min="0.05" max="1" step="0.05"
            value="${bot.settings.touchToleranceAtr ?? 0.3}"
            data-bot-id="${bot.id}" data-key="touchToleranceAtr" />
          <span style="font-size:10px;color:var(--muted)">×ATR</span>
        </div>
        <span class="bot-card-label" style="margin-left:12px">Min Stop Dist</span>
        <div class="bot-card-setting">
          <input type="number" min="0" max="1" step="0.05"
            value="${bot.settings.minStopDistAtr ?? 0.2}"
            data-bot-id="${bot.id}" data-key="minStopDistAtr" />
          <span style="font-size:10px;color:var(--muted)">×ATR</span>
        </div>
      </div>
      <div class="bot-card-row">
        <span class="bot-card-label">Swing Lookback</span>
        <div class="bot-card-setting">
          <input type="number" min="2" max="20" step="1"
            value="${bot.settings.swingLookback ?? 5}"
            data-bot-id="${bot.id}" data-key="swingLookback" />
          <span style="font-size:10px;color:var(--muted)">bars each side</span>
        </div>
      </div>
      <div class="bot-card-row">
        <span class="bot-card-label">TP Mode</span>
        <div class="bot-card-setting">
          <select class="small-select" data-bot-id="${bot.id}" data-key="tpMode">
            <option value="rr" ${(bot.settings.tpMode ?? 'rr') === 'rr' ? 'selected' : ''}>Fixed R:R</option>
            <option value="atLevel" ${bot.settings.tpMode === 'atLevel' ? 'selected' : ''}>At next S/R level</option>
          </select>
        </div>
      </div>
      <div class="bot-card-row">
        <span class="bot-card-label">Sessions</span>
        <div class="bot-card-setting" style="align-items:center;gap:6px">
          <input type="checkbox" ${bot.settings.allowAsianSession !== false ? 'checked' : ''}
            data-bot-id="${bot.id}" data-key="allowAsianSession" />
          <span style="font-size:10px;color:var(--muted)">Asian</span>
        </div>
        <div class="bot-card-setting" style="align-items:center;gap:6px">
          <input type="checkbox" ${bot.settings.allowLondonSession !== false ? 'checked' : ''}
            data-bot-id="${bot.id}" data-key="allowLondonSession" />
          <span style="font-size:10px;color:var(--muted)">London</span>
        </div>
        <div class="bot-card-setting" style="align-items:center;gap:6px">
          <input type="checkbox" ${bot.settings.allowNySession !== false ? 'checked' : ''}
            data-bot-id="${bot.id}" data-key="allowNySession" />
          <span style="font-size:10px;color:var(--muted)">NY</span>
        </div>
      </div>
      <div class="bot-card-row">
        <span class="bot-card-label">Candle Confirm</span>
        <div class="bot-card-setting" style="align-items:center;gap:6px">
          <input type="checkbox" ${bot.settings.requireCandleConfirmation ? 'checked' : ''}
            data-bot-id="${bot.id}" data-key="requireCandleConfirmation" />
          <span style="font-size:10px;color:var(--muted)">require engulfing/hammer at retest</span>
        </div>
      </div>
    </details>` : ''

  return settingFields
}

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

  // Per-category "select all" in the Add Bot pair checklist
  document.querySelectorAll<HTMLInputElement>('.bot-new-pair-select-all').forEach(selectAll => {
    selectAll.addEventListener('click', (e) => {
      e.stopPropagation()
      const category = selectAll.dataset.category
      document.querySelectorAll<HTMLInputElement>(`.bot-new-pair[data-category="${category}"]`)
        .forEach(c => { c.checked = selectAll.checked })
    })
  })

  confirmModalBtn.addEventListener('click', async () => {
    const type  = modalTypeEl.value
    const name  = modalNameEl.value.trim() || undefined
    const pairs = Array.from(document.querySelectorAll<HTMLInputElement>('.bot-new-pair'))
      .filter(c => c.checked).map(c => c.value)

    confirmModalBtn.textContent = 'Creating…'
    try {
      const accountId = (document.getElementById('bot-new-account') as HTMLSelectElement)?.value || null
      const res = await fetch('/api/v1/bot/bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, name, pairs, accountId }),
      })
      if (!res.ok) throw new Error(await res.text())
      modal.classList.add('hidden')
      modalNameEl.value = ''
      document.querySelectorAll<HTMLInputElement>('.bot-new-pair, .bot-new-pair-select-all').forEach(c => c.checked = false)
      await loadBotStatus()
    } catch (e: any) {
      alert(`Failed: ${e.message}`)
    } finally {
      confirmModalBtn.textContent = 'Create Bot'
    }
  })

  // ── Render bot cards ───────────────────────────────────────────────────────
  function renderBotCard(bot: any): string {
    const typeClass = bot.type === 'trendline' ? 'trendline' : bot.type === 'structure' ? 'structure' : ''
    const pairPills = buildPairPills(bot)
    const settingFields = buildSettingFields(bot)

    const acct       = cachedAccounts.find(a => a.id === bot.accountId)
    const acctBadge  = acct
      ? `<span class="acct-type-badge ${acct.type === 'live' ? 'acct-badge-live' : 'acct-badge-demo'}">${acct.type.toUpperCase()}</span>`
      : ''
    const acctSelector = `
      <div class="bot-card-row">
        <span class="bot-card-label">Account</span>
        <div class="bot-card-setting" style="flex:1">
          <select class="small-select bot-account-select" data-bot-id="${bot.id}" style="font-size:11px;padding:3px 6px;width:100%">
            <option value="">— No account —</option>
            ${cachedAccounts.map(a => `<option value="${a.id}" ${bot.accountId === a.id ? 'selected' : ''}>${a.name} (${a.type.toUpperCase()})</option>`).join('')}
          </select>
        </div>
      </div>`

    return `
      <div class="bot-card" data-bot-id="${bot.id}">
        <div class="bot-card-header">
          <span class="bot-card-name">${bot.name}</span>
          <span class="bot-type-badge ${typeClass}">${bot.type}</span>
          ${acctBadge}
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
          <div class="bot-card-row bot-card-row-pairs">
            <span class="bot-card-label">Pairs</span>
            <div class="bot-card-pairs-wrap">${pairPills}</div>
          </div>
          ${settingFields}
          ${acctSelector}
          <div class="bot-card-row">
            <span class="bot-card-label">Risk/Trade</span>
            <span data-bot-risk-amount="${bot.settings['riskPercent'] ?? 1}"
                  data-bot-account-id="${bot.accountId ?? ''}"
                  style="font-size:12px;font-family:monospace;color:var(--fg)">
              ${formatBotRiskAmount(bot.accountId, (bot.settings['riskPercent'] as number | undefined) ?? 1)}
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

    // Per-category "select all" — toggles every pill in that category between all-active/all-inactive
    card.querySelectorAll<HTMLButtonElement>('.pair-category-select-all').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const group = btn.closest('.pair-category-group')
        const pills = group?.querySelectorAll<HTMLElement>('.bot-pair-pill') ?? []
        const allActive = Array.from(pills).every(p => p.classList.contains('active'))
        pills.forEach(p => p.classList.toggle('active', !allActive))
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
        card.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]').forEach(inp => {
          settings[inp.dataset.key!] = inp.tagName === 'SELECT'
            ? inp.value
            : (inp as HTMLInputElement).type === 'checkbox' ? (inp as HTMLInputElement).checked : Number(inp.value)
        })
        const accountId = card.querySelector<HTMLSelectElement>('.bot-account-select')?.value || null
        const res = await fetch(`/api/v1/bot/bots/${botId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, pairs, settings, accountId }),
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
  const CRON_LOG_PAGE_SIZE = 25
  let cronLogOffset = 0

  async function loadCronLog() {
    try {
      const res  = await fetch(`/api/v1/bot/cron-log?limit=${CRON_LOG_PAGE_SIZE}&offset=${cronLogOffset}`)
      const data = await res.json() as { results: any[]; total: number; limit: number; offset: number }
      const rows = data.results ?? []
      if (!rows.length) {
        cronLogList.innerHTML = cronLogOffset > 0
          ? '<div class="bot-no-signals">No more cron runs.</div>'
          : '<div class="bot-no-signals">No cron runs recorded yet.</div>'
        return
      }

      const total    = data.total ?? rows.length
      const from     = cronLogOffset + 1
      const to       = cronLogOffset + rows.length
      const hasPrev  = cronLogOffset > 0
      const hasNext  = to < total

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
                ? `<td data-label="Error" class="cron-log-err" title="${r.error}">⚠ ${r.error.slice(0, 40)}${r.error.length > 40 ? '…' : ''}</td>`
                : '<td data-label="Error" class="cron-log-ok">—</td>'
              return `<tr>
                <td data-label="Time">${dt}</td>
                <td data-label="Session">${r.session_name}</td>
                <td data-label="Duration">${dur}</td>
                <td data-label="Recs">${r.recommendations_generated ?? 0}</td>
                <td data-label="Signals">${r.signals_found ?? 0}</td>
                <td data-label="Queued">${r.signals_queued ?? 0}</td>
                <td data-label="Executed">${r.signals_executed ?? 0}</td>
                ${errCell}
              </tr>`
            }).join('')}
          </tbody>
        </table>
        <div class="cron-log-pager">
          <span class="cron-log-pager-info">${from}–${to} of ${total}</span>
          <div class="cron-log-pager-btns">
            <button class="small-btn" id="cron-log-prev" ${hasPrev ? '' : 'disabled'}>‹ Prev</button>
            <button class="small-btn" id="cron-log-next" ${hasNext ? '' : 'disabled'}>Next ›</button>
          </div>
        </div>`

      document.getElementById('cron-log-prev')?.addEventListener('click', () => {
        cronLogOffset = Math.max(0, cronLogOffset - CRON_LOG_PAGE_SIZE)
        loadCronLog()
      })
      document.getElementById('cron-log-next')?.addEventListener('click', () => {
        cronLogOffset += CRON_LOG_PAGE_SIZE
        loadCronLog()
      })
    } catch (e: any) {
      cronLogList.innerHTML = `<div class="bot-no-signals" style="color:var(--sell)">${e.message}</div>`
    }
  }

  cronLogRefresh.addEventListener('click', () => { cronLogOffset = 0; loadCronLog() })

  // Wait for accounts to have loaded at least once so the first render's account dropdowns
  // are correct from the start, rather than racing loadAccounts() and rendering "— No account —"
  // for a bot that actually does have one.
  ;(initialAccountsLoad ?? Promise.resolve()).then(loadBotStatus)
  loadCronLog()
}

// ── Test bots (Backtest tab) ────────────────────────────────────────────────
// Full bot configs used for backtesting only — same settings shape as a live bot (reuses
// buildPairPills/buildSettingFields above), but with a manually-set starting balance instead
// of a real account, and never shown in the live Bot tab (bot/routes.ts's GET /bots hides
// is_test rows by default). "Promote to Live" just assigns a real account and flips is_test
// back off via the same PUT endpoint the Bot tab's own Save button already uses.
function renderTestBotCard(bot: any): string {
  const typeClass = bot.type === 'trendline' ? 'trendline' : bot.type === 'structure' ? 'structure' : ''
  const pairPills = buildPairPills(bot)
  const settingFields = buildSettingFields(bot)

  return `
    <div class="bot-card test-bot-card" data-bot-id="${bot.id}">
      <div class="bot-card-header">
        <span class="bot-card-name">${bot.name}</span>
        <span class="bot-type-badge ${typeClass}">${bot.type}</span>
        <span class="bot-type-badge">TEST</span>
        <span class="bot-card-chevron">▼</span>
      </div>
      <div class="bot-card-body">
        <div class="bot-card-row bot-card-row-pairs">
          <span class="bot-card-label">Pairs</span>
          <div class="bot-card-pairs-wrap">${pairPills}</div>
        </div>
        ${settingFields}
        <div class="bot-card-row">
          <span class="bot-card-label">Starting Balance</span>
          <div class="bot-card-setting">
            <span style="font-size:12px;color:var(--muted)">£</span>
            <input type="number" min="100" step="100"
              value="${bot.startingBalance ?? 10000}"
              class="test-bot-balance-input" data-bot-id="${bot.id}" />
          </div>
        </div>
        <div class="bot-card-row">
          <span class="bot-card-label">Promote to Live</span>
          <div class="bot-card-setting" style="flex:1;gap:6px">
            <select class="small-select test-bot-promote-select" data-bot-id="${bot.id}" style="font-size:11px;padding:3px 6px;flex:1">
              <option value="">— Select account —</option>
              ${cachedAccounts.map(a => `<option value="${a.id}">${a.name} (${a.type.toUpperCase()})</option>`).join('')}
            </select>
            <button class="small-btn test-bot-promote-btn" data-bot-id="${bot.id}">Promote</button>
          </div>
        </div>
        <div class="bot-card-actions">
          <button class="test-bot-save-btn" data-bot-id="${bot.id}">Save</button>
          <button class="bot-card-delete-btn test-bot-delete-btn" data-bot-id="${bot.id}">Delete</button>
        </div>
      </div>
    </div>`
}

function attachTestBotCardEvents(botId: string, onChange: () => void): void {
  const testBotList = document.getElementById('test-bot-list')!
  const card = testBotList.querySelector<HTMLElement>(`.test-bot-card[data-bot-id="${botId}"]`)
  if (!card) return

  card.querySelector('.bot-card-header')?.addEventListener('click', () => {
    card.querySelector('.bot-card-body')?.classList.toggle('open')
    const chev = card.querySelector<HTMLElement>('.bot-card-chevron')
    if (chev) chev.textContent = card.querySelector('.bot-card-body')?.classList.contains('open') ? '▲' : '▼'
  })

  card.querySelectorAll<HTMLElement>('.bot-pair-pill').forEach(pill => {
    pill.addEventListener('click', (e) => {
      e.stopPropagation()
      pill.classList.toggle('active')
    })
  })

  card.querySelectorAll<HTMLButtonElement>('.pair-category-select-all').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const group = btn.closest('.pair-category-group')
      const pills = group?.querySelectorAll<HTMLElement>('.bot-pair-pill') ?? []
      const allActive = Array.from(pills).every(p => p.classList.contains('active'))
      pills.forEach(p => p.classList.toggle('active', !allActive))
    })
  })

  // Save (settings, pairs, starting balance)
  card.querySelector<HTMLButtonElement>('.test-bot-save-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation()
    const btn = e.currentTarget as HTMLButtonElement
    btn.textContent = '…'
    try {
      const activePills = card.querySelectorAll<HTMLElement>('.bot-pair-pill.active')
      const allActive   = activePills.length === ALL_PAIRS.length
      const pairs = allActive ? [] : Array.from(activePills).map(p => p.dataset.pair!)
      const settings: Record<string, unknown> = {}
      card.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]').forEach(inp => {
        settings[inp.dataset.key!] = inp.tagName === 'SELECT'
          ? inp.value
          : (inp as HTMLInputElement).type === 'checkbox' ? (inp as HTMLInputElement).checked : Number(inp.value)
      })
      const startingBalance = Number(card.querySelector<HTMLInputElement>('.test-bot-balance-input')?.value ?? 10000)
      const res = await fetch(`/api/v1/bot/bots/${botId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairs, settings, startingBalance }),
      })
      if (!res.ok) throw new Error(await res.text())
      btn.textContent = '✓ Saved'
      setTimeout(() => { btn.textContent = 'Save' }, 2000)
    } catch (e: any) {
      btn.textContent = '⚠ Error'
      setTimeout(() => { btn.textContent = 'Save' }, 2000)
    }
  })

  // Promote to live
  card.querySelector<HTMLButtonElement>('.test-bot-promote-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation()
    const btn = e.currentTarget as HTMLButtonElement
    const accountId = card.querySelector<HTMLSelectElement>('.test-bot-promote-select')?.value
    if (!accountId) { alert('Select an account to promote this bot to.'); return }
    if (!confirm('Promote this test bot to a live bot on the selected account? It will then appear in the Bot tab (still off until you turn it on there).')) return
    btn.disabled = true
    btn.textContent = '…'
    try {
      const res = await fetch(`/api/v1/bot/bots/${botId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, isTest: false }),
      })
      if (!res.ok) throw new Error(await res.text())
      onChange()
    } catch (e: any) {
      alert(`Promote failed: ${e.message}`)
      btn.disabled = false
      btn.textContent = 'Promote'
    }
  })

  // Delete
  card.querySelector<HTMLButtonElement>('.test-bot-delete-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation()
    if (!confirm('Delete this test bot?')) return
    await fetch(`/api/v1/bot/bots/${botId}`, { method: 'DELETE' })
    onChange()
  })
}

async function loadTestBots(): Promise<void> {
  const testBotList = document.getElementById('test-bot-list')
  if (!testBotList) return
  try {
    const res = await fetch('/api/v1/bot/bots?includeTest=true')
    if (!res.ok) return
    const bots: any[] = (await res.json() as any[]).filter(b => b.isTest)
    if (!bots.length) {
      testBotList.innerHTML = '<div class="bot-no-signals">No test bots yet. Click + Create Test Bot to make one.</div>'
    } else {
      testBotList.innerHTML = bots.map(renderTestBotCard).join('')
      bots.forEach(b => attachTestBotCardEvents(b.id, () => { loadTestBots(); loadBacktestBotSelector() }))
    }
  } catch { /* silent */ }
}

function initTestBotModal(): void {
  const modal          = document.getElementById('test-bot-add-modal')
  const addBtn          = document.getElementById('test-bot-add-btn')
  const nameEl          = document.getElementById('tb-new-name') as HTMLInputElement
  const typeHidden      = document.getElementById('tb-new-type') as HTMLInputElement
  const balanceEl       = document.getElementById('tb-new-balance') as HTMLInputElement
  const cancelBtn       = document.getElementById('tb-add-cancel-btn')
  const confirmBtn      = document.getElementById('tb-add-confirm-btn') as HTMLButtonElement
  if (!modal || !addBtn || !nameEl || !typeHidden || !balanceEl || !cancelBtn || !confirmBtn) return

  addBtn.addEventListener('click', () => modal.classList.remove('hidden'))
  cancelBtn.addEventListener('click', () => modal.classList.add('hidden'))
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden') })

  // Custom type select — same pattern as the Bot tab's Add Bot modal
  const typeSelect   = document.getElementById('tb-type-select')!
  const typeSelected = typeSelect.querySelector<HTMLElement>('.custom-select-selected')!
  const typeOptions  = typeSelect.querySelector<HTMLElement>('.custom-select-options')!
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

  document.querySelectorAll<HTMLInputElement>('.tb-new-pair-select-all').forEach(selectAll => {
    selectAll.addEventListener('click', (e) => {
      e.stopPropagation()
      const category = selectAll.dataset.category
      document.querySelectorAll<HTMLInputElement>(`.tb-new-pair[data-category="${category}"]`)
        .forEach(c => { c.checked = selectAll.checked })
    })
  })

  confirmBtn.addEventListener('click', async () => {
    const type  = typeHidden.value
    const name  = nameEl.value.trim() || undefined
    const pairs = Array.from(document.querySelectorAll<HTMLInputElement>('.tb-new-pair'))
      .filter(c => c.checked).map(c => c.value)
    const startingBalance = Number(balanceEl.value) || 10000

    confirmBtn.textContent = 'Creating…'
    try {
      const res = await fetch('/api/v1/bot/bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, name, pairs, isTest: true, startingBalance }),
      })
      if (!res.ok) throw new Error(await res.text())
      modal.classList.add('hidden')
      nameEl.value = ''
      balanceEl.value = '10000'
      document.querySelectorAll<HTMLInputElement>('.tb-new-pair, .tb-new-pair-select-all').forEach(c => c.checked = false)
      await loadTestBots()
      await loadBacktestBotSelector()
    } catch (e: any) {
      alert(`Failed: ${e.message}`)
    } finally {
      confirmBtn.textContent = 'Create Test Bot'
    }
  })
}

// ── Backtest ───────────────────────────────────────────────────────────────
// Bots fetched by loadBacktestBotSelector, keyed by id — a backtest run always uses the
// selected bot's own `pairs` (same convention as live: empty means forex-only), so there's
// no separate pair selection for the run itself.
let backtestBotsCache: Record<string, any> = {}

function resolveBacktestPairs(bot: any): string[] {
  return (bot?.pairs?.length ?? 0) > 0 ? bot.pairs : PAIR_CATEGORIES.Forex
}

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
  document.getElementById('bt-close-btn')?.addEventListener('click', () => {
    currentRunId = null
    document.getElementById('backtest-results')?.classList.add('hidden')
  })

  // Load bots and populate the bot selector
  await loadBacktestBotSelector()

  initTestBotModal()
  await loadTestBots()

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
    const res = await fetch('/api/v1/bot/bots?includeTest=true')
    bots = await res.json() as any[]
  } catch { /* leave empty */ }

  if (bots.length === 0) {
    if (selected) selected.textContent = 'No bots found — create one in the Bot tab'
    return
  }

  // Cache each bot's own pairs — the backtest runs against exactly what the bot is
  // configured to trade, so there's no separate pair selection for the run itself.
  backtestBotsCache = Object.fromEntries(bots.map(b => [b.id, b]))

  // Build options — test bots are included (backtests are exactly what they're for) and
  // clearly prefixed so they're never confused with a real live bot.
  optionsEl.innerHTML = bots.map((b, i) =>
    `<div class="custom-select-option ${i === 0 ? 'active' : ''}" data-value="${b.id}" data-bot-type="${b.type}">
      ${b.isTest ? '[TEST] ' : ''}${b.name} — ${b.type === 'structure' ? 'S/R zone bounce' : 'Trendline break + retest'}
    </div>`
  ).join('')

  // Select first bot by default
  const first = bots[0]
  if (selected) { selected.textContent = optionsEl.querySelector('.active')?.textContent?.trim() ?? first.name; selected.dataset.value = first.id }
  btBotId.value   = first.id
  btBotType.value = first.type

  // Wire dropdown — this function reruns every time bots are created/promoted/deleted (see
  // callers below), but `selected` and `btSelect` are persistent DOM nodes across those
  // reruns, unlike the `.custom-select-option` elements (recreated fresh each time via the
  // innerHTML assignment above). Guard against re-attaching the same listener on every rerun,
  // which stacked up silently and made clicking the dropdown toggle it open+closed in the same
  // instant (looked like it "didn't open" until a full page reload reset the DOM).
  if (!selected.dataset.wired) {
    selected.dataset.wired = '1'
    selected.addEventListener('click', () => optionsEl.classList.toggle('hidden'))
    document.addEventListener('click', e => {
      if (!btSelect.contains(e.target as Node)) optionsEl.classList.add('hidden')
    })
  }
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
}

let currentRunId: string | null = null

async function runBacktest(): Promise<void> {
  const botId   = (document.getElementById('bt-bot-id')   as HTMLInputElement)?.value ?? ''
  const botType = (document.getElementById('bt-bot-type') as HTMLInputElement)?.value ?? 'structure'
  if (!botId) { alert('Select a bot to run the backtest with'); return }

  // Always the selected bot's own pairs — same convention as live scanning, not a separate
  // per-run selection (a bot's backtest should reflect exactly what it's configured to trade).
  const pairs = resolveBacktestPairs(backtestBotsCache[botId])
  if (pairs.length === 0) { alert('This bot has no pairs configured'); return }

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

// Date + time of day — used for when a run was actually executed, as opposed to
// safeDate() which is used for the historical date range a backtest tested.
function safeDateTime(ms: any): string {
  const n = typeof ms === 'string' ? parseInt(ms, 10) : Number(ms)
  if (!n || isNaN(n)) return '—'
  const d = new Date(n)
  if (isNaN(d.getTime())) return '—'
  return `${d.toLocaleDateString('en-GB')} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
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
  const trades: any[] = run.trades ?? []
  const strategyLabel = trades.some((t: any) => t.trade_class === 'structure') ? 'Structure Bot' : 'Trendline Bot'
  ;(document.getElementById('bt-results-title') as HTMLElement).textContent =
    `Results — ${strategyLabel} — ${(cfg.pairs ?? []).join(', ')} — ${safeDate(cfg.fromMs)} to ${safeDate(cfg.toMs)}`

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
        <td data-label="Pair">${t.pair}</td>
        <td data-label="Dir" class="${t.direction === 'buy' ? 'outcome-tp' : 'outcome-sl'}">${t.direction.toUpperCase()}</td>
        <td data-label="Entry">${t.entry_price}</td>
        <td data-label="SL">${t.stop_loss}</td>
        <td data-label="TP">${t.take_profit}</td>
        <td data-label="Score">${t.score}</td>
        <td data-label="Date">${dateStr}</td>
        <td data-label="Outcome" class="${outcomeClass}">${(t.outcome ?? '—').toUpperCase()}</td>
        <td data-label="P&amp;L pips" class="${pnlCls}">${t.pnl_pips ?? '—'}</td>
        <td data-label="P&amp;L £" class="${pnlCls}">${t.pnl_gbp != null ? '£' + Number(t.pnl_gbp).toFixed(2) : '—'}</td>
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
      const dateStr    = safeDateTime(r.started_at).replace('—', '?')
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
