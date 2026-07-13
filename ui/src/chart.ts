import { init, registerOverlay } from 'klinecharts'
import type { Chart } from 'klinecharts'
import type { CandleData, Zone, Signal, SwingPoint, AnalysisResult, TrendlineOverlayResult, TrendlineOverlayLine } from './api'
import {
  srZoneOverlay,
  tradeRectOverlay,
  hLineOverlay,
  swingLabelOverlay,
  signalMarkerOverlay,
  hnsOverlay,
  trendLineOverlay,
} from './overlay'

// Register custom overlays once
registerOverlay(srZoneOverlay)
registerOverlay(tradeRectOverlay)
registerOverlay(hLineOverlay)
registerOverlay(swingLabelOverlay)
registerOverlay(signalMarkerOverlay)
registerOverlay(hnsOverlay)
registerOverlay(trendLineOverlay)

export interface TradeLinesState {
  entry: number
  sl: number
  tp: number
}

type TradeLinesChangeCallback = (state: TradeLinesState) => void

// Pip value: JPY pairs have 2 decimal places, others have 5
function pipFactor(pair: string): number {
  return pair.includes('JPY') ? 100 : 10000
}

export class TradingChart {
  private chart: Chart
  private pair: string = 'EUR/USD'
  private currentPrice: number = 0
  private data: CandleData[] = []

  // Trade line overlay IDs
  private entryId:  string | null = null
  private slId:     string | null = null
  private tpId:     string | null = null
  private slZoneId: string | null = null
  private tpZoneId: string | null = null
  private visTradeLines = false

  // Zone overlay IDs
  private zoneIds: string[] = []
  // Swing label overlay IDs
  private swingIds: string[] = []
  // Signal overlay IDs
  private signalIds: string[] = []
  // Pattern overlay IDs
  private patternIds: string[] = []
  // Trendline overlay IDs
  private trendlineIds: string[] = []

  // User-drawn overlay IDs (S/R lines + manual trade setups)
  private userDrawingIds: string[] = []

  // Visibility state for each overlay type
  private visZones      = false  // default off — user draws their own
  private visStructure  = true
  private visSignals    = true
  private visPatterns   = true
  private visTrendlines = true

  // Stored data for re-render on toggle
  private lastZones:     Zone[]       = []
  private lastStructure: SwingPoint[] = []
  private lastSignals:   Signal[]     = []
  private lastCandles:   CandleData[] = []
  private lastPatterns:    AnalysisResult['patterns'] = []
  private lastTrendlines:  TrendlineOverlayResult = { resistanceLines: [], supportLines: [] }

  // ATR-derived suggested stop in pips
  private suggestedStopPips = 30
  // Trade direction: 1 = long, -1 = short
  private direction: 1 | -1 = 1
  // Weekly+Daily zones used for TP targeting in swing trades
  private htfZones: Zone[] = []

  private onTradeLinesChange: TradeLinesChangeCallback | null = null
  onDrawingComplete: (() => void) | null = null

  constructor(containerId: string) {
    const container = document.getElementById(containerId)
    if (!container) throw new Error(`Container #${containerId} not found`)

    this.chart = init(containerId, {
      styles: {
        grid: {
          show: true,
          horizontal: { color: '#21262d', size: 1, style: 'dashed', dashedValue: [4, 4] },
          vertical:   { color: '#21262d', size: 1, style: 'dashed', dashedValue: [4, 4] },
        },
        candle: {
          type: 'candle_solid',
          bar: {
            upColor:        '#3fb950',
            downColor:      '#f85149',
            noChangeColor:  '#7d8590',
            upBorderColor:  '#3fb950',
            downBorderColor:'#f85149',
            noChangeBorderColor: '#7d8590',
            upWickColor:    '#3fb950',
            downWickColor:  '#f85149',
            noChangeWickColor: '#7d8590',
          },
          priceMark: {
            show: true,
            high: { show: true, color: '#7d8590', textOffset: 5, textSize: 10, textFamily: 'monospace', textWeight: 'normal' },
            low:  { show: true, color: '#7d8590', textOffset: 5, textSize: 10, textFamily: 'monospace', textWeight: 'normal' },
            last: {
              show: true,
              upColor:   '#3fb950',
              downColor: '#f85149',
              noChangeColor: '#7d8590',
              line: { show: true, style: 'dashed', dashedValue: [4, 4], size: 1 },
              text: {
                show: true,
                style: 'fill',
                size: 12,
                paddingLeft: 4,
                paddingRight: 4,
                paddingTop: 2,
                paddingBottom: 2,
                borderRadius: 2,
                color: '#0d1117',
                family: 'monospace',
                weight: 'normal',
              },
            },
          },
          tooltip: {
            showRule: 'always',
            showType: 'standard',
            labels: ['T', 'O', 'H', 'L', 'C'],
            defaultValue: 'n/a',
            rect: {
              offsetLeft: 8,
              offsetTop: 8,
              offsetRight: 8,
              borderRadius: 4,
              borderSize: 1,
              borderColor: '#30363d',
              color: '#161b22',
            },
            text: {
              size: 12,
              family: 'monospace',
              weight: 'normal',
              color: '#e6edf3',
              marginLeft: 8,
              marginTop: 6,
              marginRight: 8,
              marginBottom: 6,
            },
          },
        },
        xAxis: {
          show: true,
          size: 'auto',
          axisLine: { show: true, color: '#30363d', size: 1 },
          tickLine: { show: true, size: 5, length: 3, color: '#30363d' },
          tickText: { show: true, color: '#7d8590', family: 'monospace', weight: 'normal', size: 12, marginStart: 4, marginEnd: 4 },
        },
        yAxis: {
          show: true,
          size: 'auto',
          position: 'right',
          type: 'normal',
          axisLine: { show: true, color: '#30363d', size: 1 },
          tickLine: { show: true, size: 5, length: 3, color: '#30363d' },
          tickText: { show: true, color: '#7d8590', family: 'monospace', weight: 'normal', size: 12, marginStart: 4, marginEnd: 4 },
        },
        separator: { size: 1, color: '#30363d', fill: true, activeBackgroundColor: 'rgba(88,166,255,0.08)' },
        crosshair: {
          show: true,
          horizontal: { show: true, line: { show: true, style: 'dashed', dashedValue: [4, 4], size: 1, color: '#58a6ff' }, text: { show: true, style: 'fill', color: '#e6edf3', size: 12, family: 'monospace', weight: 'normal', borderRadius: 2, borderSize: 1, borderColor: '#30363d', paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, backgroundColor: '#161b22' } },
          vertical:   { show: true, line: { show: true, style: 'dashed', dashedValue: [4, 4], size: 1, color: '#58a6ff' }, text: { show: true, style: 'fill', color: '#e6edf3', size: 12, family: 'monospace', weight: 'normal', borderRadius: 2, borderSize: 1, borderColor: '#30363d', paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, backgroundColor: '#161b22' } },
        },
        overlay: {
          point: { color: '#ffffff', borderColor: '#ffffff', borderSize: 1, radius: 5, activeRadius: 7, activeColor: '#ffffff', activeBorderColor: '#ffffff', activeBorderSize: 1 },
          line: { style: 'solid', smooth: false, color: '#58a6ff', size: 1, dashedValue: [4, 4] },
          rect: { style: 'fill', color: 'rgba(88,166,255,0.08)', borderColor: '#58a6ff', borderSize: 1, borderStyle: 'solid', borderRadius: 0, dashedValue: [4, 4] },
          text: { style: 'fill', color: '#e6edf3', size: 13, family: 'monospace', weight: 'normal', borderRadius: 2, borderSize: 1, borderColor: '#30363d', paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, backgroundColor: '#161b22' },
          rectText: { style: 'fill', color: '#e6edf3', size: 13, family: 'monospace', weight: 'normal', borderRadius: 2, borderSize: 1, borderColor: '#30363d', paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, backgroundColor: '#161b22' },
        },
      },
      timezone: 'UTC',
      locale: 'en-US',
    })!

    this.chart.setPriceVolumePrecision(5, 0)
  }

  setPair(pair: string): void {
    this.pair = pair
    const dec = pair.includes('JPY') ? 3 : 5
    this.chart.setPriceVolumePrecision(dec, 0)
  }

  setOnTradeLinesChange(cb: TradeLinesChangeCallback): void {
    this.onTradeLinesChange = cb
  }

  // klinecharts measures its container's pixel size at init/candle-apply time. If the Chart
  // tab isn't the active tab yet (container is display:none, width/height report 0), it can
  // end up sizing its internal canvases from that stale zero/garbage measurement — call this
  // once the tab becomes visible again so it remeasures against the real, laid-out size.
  resize(): void {
    this.chart.resize()
  }

  applyCandles(candles: CandleData[]): void {
    this.data = candles
    const data = candles.map(c => ({
      timestamp: c.timestamp,
      open:  c.open,
      high:  c.high,
      low:   c.low,
      close: c.close,
    }))
    this.chart.applyNewData(data)

    if (candles.length > 0) {
      this.currentPrice = candles[candles.length - 1]!.close
      this.resetTradeLines()
    }
  }

  applyZones(zones: Zone[]): void {
    this.lastZones = zones
    for (const id of this.zoneIds) this.chart.removeOverlay({ id })
    this.zoneIds = []

    if (!this.visZones) return

    for (const zone of zones) {
      const isResistance = zone.type === 'resistance'
      const color = isResistance ? '#f85149' : '#3fb950'
      const tf = zone.timeframe === 'W' ? 'Weekly'
        : zone.timeframe === 'D' ? 'Daily'
        : zone.timeframe === '4H' ? '4H'
        : '1H'
      const zoneType  = isResistance ? 'Resistance' : 'Support'
      const strength  = zone.strength >= 70 ? 'Strong' : zone.strength >= 40 ? 'Moderate' : 'Weak'
      const dec       = zone.high > 10 ? 3 : 5
      const label     = `${tf} ${strength} ${zoneType}  ${zone.low.toFixed(dec)}–${zone.high.toFixed(dec)}`

      const midTimestamp = this.data[Math.floor(this.data.length / 2)]?.timestamp ?? Date.now()
      const result = this.chart.createOverlay({
        name: 'srZone',
        points: [
          { timestamp: midTimestamp, value: zone.low },
          { timestamp: midTimestamp, value: zone.high },
        ],
        extendData: { color, label },
        lock: true,
      })
      if (typeof result === 'string') this.zoneIds.push(result)
    }
  }

  applySwingPoints(swingPoints: SwingPoint[]): void {
    this.lastStructure = swingPoints
    for (const id of this.swingIds) this.chart.removeOverlay({ id })
    this.swingIds = []

    if (!this.visStructure) return

    // Find the latest timestamp for each label type
    const isLatestMap: Record<string, number> = {}
    for (const sp of swingPoints) {
      if (isLatestMap[sp.label] === undefined || sp.timestamp > isLatestMap[sp.label]!) {
        isLatestMap[sp.label] = sp.timestamp
      }
    }

    for (const sp of swingPoints) {
      const above   = sp.label === 'HH' || sp.label === 'LH'
      const bullish = sp.label === 'HH' || sp.label === 'HL'
      const isLatest = isLatestMap[sp.label] === sp.timestamp

      const result = this.chart.createOverlay({
        name: 'swingLabel',
        points: [{ timestamp: sp.timestamp, value: sp.price }],
        extendData: { label: sp.label, above, bullish, isLatest },
        lock: true,
      })
      if (typeof result === 'string') this.swingIds.push(result)
    }
  }

  applySignals(signals: Signal[], candles: CandleData[]): void {
    this.lastSignals  = signals
    this.lastCandles  = candles
    for (const id of this.signalIds) this.chart.removeOverlay({ id })
    this.signalIds = []

    if (!this.visSignals) return

    const bullishTypes = new Set(['bullish_engulfing', 'hammer'])

    // Only render signals from the last 10 candles — older signals are stale
    // and confuse the trade lines (they can appear inside the SL zone)
    const cutoff = candles.length > 10
      ? candles[candles.length - 10]!.timestamp
      : 0
    const recentSignals = signals.filter(s => s.timestamp >= cutoff)

    for (const sig of recentSignals) {
      const candle = candles.find(c => c.timestamp === sig.timestamp)
        ?? candles.find(c => Math.abs(c.timestamp - sig.timestamp) < 3600_000)
      if (!candle) continue

      const bullish = bullishTypes.has(sig.type)
      const price   = bullish ? candle.low : candle.high

      const result = this.chart.createOverlay({
        name: 'signalMarker',
        points: [{ timestamp: candle.timestamp, value: price }],
        extendData: { bullish },
        lock: true,
      })
      if (typeof result === 'string') this.signalIds.push(result)
    }
  }

  applyPatterns(patterns: AnalysisResult['patterns']): void {
    this.lastPatterns = patterns
    for (const id of this.patternIds) this.chart.removeOverlay({ id })
    this.patternIds = []

    if (!this.visPatterns || !patterns) return

    for (const p of patterns) {
      if (!p.extendedData) continue
      const ed = p.extendedData
      const isInverse = p.type === 'inverse_head_and_shoulders'
      const label = isInverse ? 'IH&S' : 'H&S'
      const confirmed = p.status === 'confirmed'
      const color = confirmed ? '#f85149' : '#e3b341'

      const result = this.chart.createOverlay({
        name: 'hns',
        points: [
          { timestamp: ed.leftShoulderTimestamp, value: ed.leftShoulderPrice },
          { timestamp: ed.headTimestamp, value: ed.headPrice },
          { timestamp: ed.rightShoulderTimestamp, value: ed.rightShoulderPrice },
        ],
        extendData: {
          label,
          color,
          confidence: p.confidence,
          necklinePrice: ed.necklinePrice,
          confirmed,
        },
        lock: true,
      })
      if (typeof result === 'string') this.patternIds.push(result)
    }
  }

  setChartType(type: 'candle_solid' | 'area'): void {
    this.chart.setStyles({ candle: { type } })
  }

  setDirection(dir: 'buy' | 'sell'): void {
    this.direction = dir === 'buy' ? 1 : -1
    if (this.currentPrice > 0) this.resetTradeLines()
  }

  setHtfZones(zones: Zone[]): void {
    this.htfZones = zones
    if (this.currentPrice > 0) this.resetTradeLines()
  }

  setSuggestedStop(atr: number): void {
    const factor = pipFactor(this.pair)
    const pips = Math.round(atr * factor)
    this.suggestedStopPips = Math.max(20, Math.min(100, pips))
  }

  // ── Toggle methods ────────────────────────────────────────────────────────────

  toggleZones(show: boolean): void {
    this.visZones = show
    for (const id of this.zoneIds) this.chart.removeOverlay({ id })
    this.zoneIds = []
    if (show) this.applyZones(this.lastZones)
  }

  toggleStructure(show: boolean): void {
    this.visStructure = show
    for (const id of this.swingIds) this.chart.removeOverlay({ id })
    this.swingIds = []
    if (show) this.applySwingPoints(this.lastStructure)
  }

  toggleSignals(show: boolean): void {
    this.visSignals = show
    for (const id of this.signalIds) this.chart.removeOverlay({ id })
    this.signalIds = []
    if (show) this.applySignals(this.lastSignals, this.lastCandles)
  }

  toggleTradeLines(show: boolean): void {
    this.visTradeLines = show
    if (show) {
      if (this.currentPrice > 0) this.resetTradeLines()
    } else {
      this.removeTradeOverlays()
    }
  }

  togglePatterns(show: boolean): void {
    this.visPatterns = show
    for (const id of this.patternIds) this.chart.removeOverlay({ id })
    this.patternIds = []
    if (show) this.applyPatterns(this.lastPatterns)
  }

  applyTrendlines(result: TrendlineOverlayResult): void {
    this.lastTrendlines = result
    for (const id of this.trendlineIds) this.chart.removeOverlay({ id })
    this.trendlineIds = []
    if (!this.visTrendlines) return

    const drawLine = (line: TrendlineOverlayLine, color: string, dash: boolean) => {
      const id = this.chart.createOverlay({
        name: 'trendLine',
        points: [
          { timestamp: line.p1Timestamp, value: line.p1Price },
          { timestamp: line.p2Timestamp, value: line.p2Price },
        ],
        lock: true,
        extendData: { color, label: '', dash },
      })
      if (typeof id === 'string') this.trendlineIds.push(id)
    }

    // Resistance lines = red; most recent (index 0) is solid, older ones are dashed
    result.resistanceLines.forEach((line, i) =>
      drawLine(line, 'rgba(239,83,80,0.9)', i > 0),
    )
    // Support lines = blue; most recent solid, older dashed
    result.supportLines.forEach((line, i) =>
      drawLine(line, 'rgba(41,182,246,0.9)', i > 0),
    )
  }

  toggleTrendlines(show: boolean): void {
    this.visTrendlines = show
    for (const id of this.trendlineIds) this.chart.removeOverlay({ id })
    this.trendlineIds = []
    if (show) this.applyTrendlines(this.lastTrendlines)
  }

  // ── Trade lines ───────────────────────────────────────────────────────────────

  getTradeLinesState(): TradeLinesState {
    const getPrice = (id: string | null): number => {
      if (!id) return 0
      const overlay = this.chart.getOverlayById(id)
      const o = Array.isArray(overlay) ? overlay[0] : overlay
      return o?.points[0]?.value ?? 0
    }
    return {
      entry: getPrice(this.entryId),
      sl:    getPrice(this.slId),
      tp:    getPrice(this.tpId),
    }
  }

  private removeTradeOverlays(): void {
    for (const id of [this.entryId, this.slId, this.tpId, this.slZoneId, this.tpZoneId]) {
      if (id) this.chart.removeOverlay({ id })
    }
    this.entryId = this.slId = this.tpId = this.slZoneId = this.tpZoneId = null
  }

  private createZoneRect(midTs: number, price1: number, price2: number, color: string, label: string): string | null {
    const result = this.chart.createOverlay({
      name: 'tradeRect',
      points: [{ timestamp: midTs, value: price1 }, { timestamp: midTs, value: price2 }],
      extendData: { color, label },
      lock: true,
    })
    return typeof result === 'string' ? result : null
  }

  private resetTradeLines(): void {
    if (!this.visTradeLines) return
    this.removeTradeOverlays()

    const factor  = pipFactor(this.pair)
    const d       = this.direction   // 1 = long, -1 = short
    const atrPips = this.suggestedStopPips > 0 ? this.suggestedStopPips : 30
    const buffer  = atrPips * 0.3 / factor
    const midTs   = this.data[Math.floor(this.data.length / 2)]?.timestamp ?? Date.now()

    // SL uses current-TF zones (tight, near current price)
    const tfSupports    = this.lastZones.filter(z => z.type === 'support'    && !z.isBroken)
    const tfResistances = this.lastZones.filter(z => z.type === 'resistance' && !z.isBroken)

    // TP uses Weekly+Daily zones — swing trades target major structure levels
    const htfResistances = this.htfZones.filter(z => z.type === 'resistance' && !z.isBroken)
    const htfSupports    = this.htfZones.filter(z => z.type === 'support'    && !z.isBroken)

    let entry: number
    let sl: number
    let tp: number

    if (d === 1) {
      // Long: enter at current-TF support top, SL below its floor, TP at nearest W/D resistance
      const nearSupport    = tfSupports.sort((a, b) => b.high - a.high)
                                       .find(z => z.high <= this.currentPrice + atrPips * 2 / factor)
      if (nearSupport) {
        entry = nearSupport.high
        sl    = nearSupport.low - buffer
      } else {
        entry = this.currentPrice
        sl    = entry - atrPips / factor
      }
      // TP: nearest W/D resistance above entry — this is the swing target
      const htfResistance = htfResistances.sort((a, b) => a.low - b.low)
                                          .find(z => z.low > entry)
      tp = htfResistance ? htfResistance.low : entry + Math.abs(entry - sl) * 3
    } else {
      // Short: enter at current-TF resistance bottom, SL above its ceiling, TP at nearest W/D support
      const nearResistance = tfResistances.sort((a, b) => a.low - b.low)
                                          .find(z => z.low >= this.currentPrice - atrPips * 2 / factor)
      if (nearResistance) {
        entry = nearResistance.low
        sl    = nearResistance.high + buffer
      } else {
        entry = this.currentPrice
        sl    = entry + atrPips / factor
      }
      // TP: nearest W/D support below entry — this is the swing target
      const htfSupport = htfSupports.sort((a, b) => b.high - a.high)
                                    .find(z => z.high < entry)
      tp = htfSupport ? htfSupport.high : entry - Math.abs(sl - entry) * 3
    }

    const stopPips = Math.abs(entry - sl) * factor
    const tpPips   = Math.abs(tp - entry) * factor
    const rr       = stopPips > 0 ? tpPips / stopPips : 0

    // Draw narrow zone highlights AT the SL and TP levels — not a giant band between them
    this.slZoneId = this.createZoneRect(midTs, sl + buffer, sl - buffer, '#f85149',
      `Stop: ${stopPips.toFixed(1)} pips  |  £100 risk`)
    this.tpZoneId = this.createZoneRect(midTs, tp - buffer, tp + buffer, '#3fb950',
      `Take Profit: ${tpPips.toFixed(1)} pips  |  £${(100 * rr).toFixed(0)} reward  |  R:R ${rr.toFixed(1)}`)

    const onChange = () => {
      const state = this.getTradeLinesState()
      if (this.slZoneId) this.chart.removeOverlay({ id: this.slZoneId })
      if (this.tpZoneId) this.chart.removeOverlay({ id: this.tpZoneId })
      const f      = pipFactor(this.pair)
      const stop   = Math.abs(state.entry - state.sl) * f
      const reward = Math.abs(state.tp - state.entry) * f
      const rr2    = stop > 0 ? reward / stop : 0
      const buf    = stop * 0.1 / f
      this.slZoneId = this.createZoneRect(midTs, state.sl + buf, state.sl - buf, '#f85149',
        `Stop: ${stop.toFixed(1)} pips  |  £100 risk`)
      this.tpZoneId = this.createZoneRect(midTs, state.tp - buf, state.tp + buf, '#3fb950',
        `Take Profit: ${reward.toFixed(1)} pips  |  £${(100 * rr2).toFixed(0)} reward  |  R:R ${rr2.toFixed(1)}`)
      this.onTradeLinesChange?.(state)
    }

    // Timestamp needed so KLineChart can place the drag handle on the X axis
    const dragTs = this.data[Math.floor(this.data.length * 0.75)]?.timestamp ?? Date.now()

    const mkLine = (value: number, color: string, label: string, info: string) => {
      const r = this.chart.createOverlay({
        name: 'hLine',
        points: [{ timestamp: dragTs, value }],
        extendData: { color, label, info },
        lock: false,
        onPressedMoveEnd: onChange,
      })
      return typeof r === 'string' ? r : null
    }

    this.entryId = mkLine(entry, '#f0c040', 'ENTRY', '')
    this.slId    = mkLine(sl,    '#f85149', 'SL',    `${stopPips.toFixed(1)} pips`)
    this.tpId    = mkLine(tp,    '#3fb950', 'TP',    `${tpPips.toFixed(1)} pips  |  R:R ${rr.toFixed(1)}`)

    setTimeout(onChange, 100)
  }

  // ── User drawing tools ────────────────────────────────────────────────────────

  startDrawSR(type: 'support' | 'resistance'): string | null {
    const color = type === 'support' ? '#3fb950' : '#f85149'
    const label = type === 'support' ? 'Support' : 'Resistance'

    // totalStep:2 means the overlay waits for one click to set the price level.
    // createOverlay without points puts it in drawing mode — line follows cursor, click to commit.
    const result = this.chart.createOverlay({
      name: 'hLine',
      extendData: { color, label, info: '' },
      lock: false,
      onDrawEnd: () => { this.onDrawingComplete?.() },
    })
    if (typeof result === 'string') {
      this.userDrawingIds.push(result)
      return result
    }
    return null
  }

  cancelDraw(): void {
    this.chart.cancelDraw?.()
  }

  placeTradeSetup(direction: 'buy' | 'sell'): void {
    const d       = direction === 'buy' ? 1 : -1
    const factor  = pipFactor(this.pair)
    const atrPips = this.suggestedStopPips > 0 ? this.suggestedStopPips : 30
    const buffer  = atrPips * 0.3 / factor
    const dragTs  = this.data[Math.floor(this.data.length * 0.75)]?.timestamp ?? Date.now()

    const tfSupports    = this.lastZones.filter(z => z.type === 'support'    && !z.isBroken)
    const tfResistances = this.lastZones.filter(z => z.type === 'resistance' && !z.isBroken)
    const htfResistances = this.htfZones.filter(z => z.type === 'resistance' && !z.isBroken)
    const htfSupports    = this.htfZones.filter(z => z.type === 'support'    && !z.isBroken)

    let entry: number, sl: number, tp: number

    if (d === 1) {
      const nearSupport    = tfSupports.sort((a, b) => b.high - a.high)
                                       .find(z => z.high <= this.currentPrice + atrPips * 2 / factor)
      const htfResistance  = htfResistances.sort((a, b) => a.low - b.low)
                                           .find(z => z.low > (nearSupport?.high ?? this.currentPrice))
      entry = nearSupport ? nearSupport.high : this.currentPrice
      sl    = nearSupport ? nearSupport.low - buffer : entry - atrPips / factor
      tp    = htfResistance ? htfResistance.low : entry + Math.abs(entry - sl) * 3
    } else {
      const nearResistance = tfResistances.sort((a, b) => a.low - b.low)
                                          .find(z => z.low >= this.currentPrice - atrPips * 2 / factor)
      const htfSupport     = htfSupports.sort((a, b) => b.high - a.high)
                                        .find(z => z.high < (nearResistance?.low ?? this.currentPrice))
      entry = nearResistance ? nearResistance.low : this.currentPrice
      sl    = nearResistance ? nearResistance.high + buffer : entry + atrPips / factor
      tp    = htfSupport ? htfSupport.high : entry - Math.abs(sl - entry) * 3
    }

    const factor2   = pipFactor(this.pair)
    const stopPips  = Math.abs(entry - sl) * factor2
    const tpPips    = Math.abs(tp - entry) * factor2
    const rr        = stopPips > 0 ? tpPips / stopPips : 0
    const entryColor = direction === 'buy' ? '#f0c040' : '#c080f0'

    const mkLine = (value: number, color: string, label: string, info: string): string | null => {
      const r = this.chart.createOverlay({
        name: 'hLine',
        points: [{ timestamp: dragTs, value }],
        extendData: { color, label, info },
        lock: false,
        groupId: `trade-${Date.now()}`,
      })
      const id = typeof r === 'string' ? r : null
      if (id) this.userDrawingIds.push(id)
      return id
    }

    mkLine(entry, entryColor, direction === 'buy' ? 'LONG ENTRY' : 'SHORT ENTRY', '')
    mkLine(sl,    '#f85149',  'SL',   `${stopPips.toFixed(1)} pips`)
    mkLine(tp,    '#3fb950',  'TP',   `${tpPips.toFixed(1)} pips  R:R ${rr.toFixed(1)}`)
  }

  clearUserDrawings(): void {
    for (const id of this.userDrawingIds) {
      this.chart.removeOverlay({ id })
    }
    this.userDrawingIds = []
  }

  destroy(): void {
    this.chart.destroy?.()
  }
}
