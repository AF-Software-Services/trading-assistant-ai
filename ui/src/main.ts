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
let accountBalance  = parseFloat(localStorage.getItem('risk_balance')  ?? '10000')
let riskPercent     = parseFloat(localStorage.getItem('risk_percent')  ?? '1')
let rewardRisk      = parseFloat(localStorage.getItem('risk_rr')       ?? '1.2')

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
    hint.textContent = 'Support line placed — drag to reposition'
    hint.classList.remove('hidden')
    setTimeout(() => { hint.classList.add('hidden'); setDrawMode(false) }, 2000)
  })

  document.getElementById('draw-resistance')?.addEventListener('click', () => {
    chart.startDrawSR('resistance')
    document.getElementById('draw-resistance')!.classList.add('active')
    hint.textContent = 'Resistance line placed — drag to reposition'
    hint.classList.remove('hidden')
    setTimeout(() => { hint.classList.add('hidden'); setDrawMode(false) }, 2000)
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
    { id: 'toggle-zones',     fn: v => chart.toggleZones(v) },
    { id: 'toggle-structure', fn: v => chart.toggleStructure(v) },
    { id: 'toggle-signals',   fn: v => chart.toggleSignals(v) },
    { id: 'toggle-patterns',  fn: v => chart.togglePatterns(v) },
    { id: 'toggle-trade',     fn: v => chart.toggleTradeLines(v) },
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
    })
  })
}

// ── cTrader status ────────────────────────────────────────────────────────────
async function checkCTraderStatus(): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/ctrader/status')
    const data = await res.json() as { connected: boolean }
    const dot  = document.getElementById('ctrader-status-dot')!
    const txt  = document.getElementById('ctrader-status-text')!
    const btn  = document.getElementById('ctrader-connect-btn')!
    const exec = document.getElementById('execute-trade-btn')!
    if (data.connected) {
      dot.className  = 'status-dot connected'
      txt.textContent = 'Connected (Demo)'
      btn.textContent = '✓ Connected'
      btn.classList.add('connected')
      exec.classList.remove('hidden')
    } else {
      dot.className  = 'status-dot disconnected'
      txt.textContent = 'Not connected'
      btn.textContent = 'Connect cTrader'
      btn.classList.remove('connected')
      exec.classList.add('hidden')
    }
    return data.connected
  } catch { return false }
}

function initCTrader(): void {
  document.getElementById('ctrader-connect-btn')?.addEventListener('click', () => {
    window.location.href = '/auth/ctrader'
  })
  document.getElementById('execute-trade-btn')?.addEventListener('click', showExecuteModal)

  // Check if just returned from OAuth
  if (new URLSearchParams(window.location.search).get('ctrader') === 'connected') {
    history.replaceState({}, '', '/')
  }
  checkCTraderStatus()
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
      const lots = (p.volume / 100).toFixed(2)
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
      const lots   = (d.volume / 100).toFixed(2)
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
  const amount = accountBalance * (riskPercent / 100)
  const fmt = `£${amount.toFixed(2)}`
  const displayEl = document.getElementById('risk-amount-display')
  const noteEl    = document.getElementById('risk-note-amount')
  const riskEl    = document.getElementById('tp-risk')
  if (displayEl) displayEl.textContent = fmt
  if (noteEl)    noteEl.textContent    = fmt
  if (riskEl && riskEl.textContent === '—') return  // don't overwrite real value
}

function initRiskSettings(): void {
  const balanceInput = el<HTMLInputElement>('risk-balance')
  const percentInput = el<HTMLInputElement>('risk-percent')
  const rrInput      = el<HTMLInputElement>('risk-rr')
  const btn          = el<HTMLButtonElement>('risk-settings-btn')
  const dropdown     = el('risk-dropdown')

  // Restore saved values
  balanceInput.value = String(accountBalance)
  percentInput.value = String(riskPercent)
  rrInput.value      = String(rewardRisk)
  updateRiskDisplay()

  // Toggle dropdown
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const open = dropdown.classList.toggle('hidden') === false
    btn.classList.toggle('active', open)
  })

  // Close on outside click
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
          body: JSON.stringify({ accountBalance, riskPercent, rewardRisk }),
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
    riskPercent    = parseFloat(percentInput.value) || 1
    rewardRisk     = parseFloat(rrInput.value)      || 1.2
    localStorage.setItem('risk_balance', String(accountBalance))
    localStorage.setItem('risk_percent', String(riskPercent))
    localStorage.setItem('risk_rr',      String(rewardRisk))
    updateRiskDisplay()
    saveToKv()
  }

  balanceInput.addEventListener('input', onChange)
  percentInput.addEventListener('input', onChange)
  rrInput.addEventListener('input', onChange)

  // Sync to KV once on load so Claude Desktop always has the current values
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
  initDrawingTools()
  initOverlayToggles()
  initRiskSettings()
  initNews()
  initCTrader()
  initExecuteModal()
  document.getElementById('refresh-positions')?.addEventListener('click', loadPositions)
  document.getElementById('refresh-history')?.addEventListener('click', loadHistory)
  document.getElementById('history-days')?.addEventListener('change', loadHistory)

  // Update pair/TF on chart after URL params applied
  chart.setPair(activePair)
  tradePanel.setPair(activePair)

  loadAll()
}

init()
