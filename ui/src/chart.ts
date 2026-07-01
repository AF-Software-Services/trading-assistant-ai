import { init, registerOverlay } from 'klinecharts'
import type { Chart } from 'klinecharts'
import type { CandleData, Zone, Signal, SwingPoint, AnalysisResult } from './api'
import {
  srZoneOverlay,
  tradeZoneOverlay,
  swingLabelOverlay,
  signalMarkerOverlay,
  hnsOverlay,
} from './overlay'

// Register custom overlays once
registerOverlay(srZoneOverlay)
registerOverlay(tradeZoneOverlay)
registerOverlay(swingLabelOverlay)
registerOverlay(signalMarkerOverlay)
registerOverlay(hnsOverlay)

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

  // Single trade zone overlay (entry + SL + TP)
  private tradeZoneId: string | null = null

  // Zone overlay IDs
  private zoneIds: string[] = []
  // Swing label overlay IDs
  private swingIds: string[] = []
  // Signal overlay IDs
  private signalIds: string[] = []
  // Pattern overlay IDs
  private patternIds: string[] = []

  // Visibility state for each overlay type
  private visZones     = true
  private visStructure = true
  private visSignals   = true
  private visPatterns  = true

  // Stored data for re-render on toggle
  private lastZones:     Zone[]       = []
  private lastStructure: SwingPoint[] = []
  private lastSignals:   Signal[]     = []
  private lastCandles:   CandleData[] = []
  private lastPatterns:  AnalysisResult['patterns'] = []

  // ATR-derived suggested stop in pips
  private suggestedStopPips = 30
  // Trade direction: 1 = long, -1 = short
  private direction: 1 | -1 = 1

  private onTradeLinesChange: TradeLinesChangeCallback | null = null

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
      const tfLabel = zone.timeframe === 'W' ? 'W'
        : zone.timeframe === 'D' ? 'D'
        : 'I'

      const midTimestamp = this.data[Math.floor(this.data.length / 2)]?.timestamp ?? Date.now()
      const result = this.chart.createOverlay({
        name: 'srZone',
        points: [
          { timestamp: midTimestamp, value: zone.low },
          { timestamp: midTimestamp, value: zone.high },
        ],
        extendData: { color, label: tfLabel },
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

    for (const sig of signals) {
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

  setDirection(dir: 'buy' | 'sell'): void {
    this.direction = dir === 'buy' ? 1 : -1
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

  togglePatterns(show: boolean): void {
    this.visPatterns = show
    for (const id of this.patternIds) this.chart.removeOverlay({ id })
    this.patternIds = []
    if (show) this.applyPatterns(this.lastPatterns)
  }

  // ── Trade lines ───────────────────────────────────────────────────────────────

  getTradeLinesState(): TradeLinesState {
    if (!this.tradeZoneId) return { entry: 0, sl: 0, tp: 0 }
    const overlays = this.chart.getOverlayById(this.tradeZoneId)
    const overlay  = Array.isArray(overlays) ? overlays[0] : overlays
    return {
      entry: overlay?.points[0]?.value ?? 0,
      sl:    overlay?.points[1]?.value ?? 0,
      tp:    overlay?.points[2]?.value ?? 0,
    }
  }

  private resetTradeLines(): void {
    if (this.tradeZoneId) this.chart.removeOverlay({ id: this.tradeZoneId })

    const factor     = pipFactor(this.pair)
    const dec        = this.pair.includes('JPY') ? 3 : 5
    const entry      = this.currentPrice
    const stopPips   = this.suggestedStopPips > 0 ? this.suggestedStopPips : 30
    const d          = this.direction
    const sl         = entry - d * (stopPips / factor)
    const tp         = entry + d * (stopPips * 5 / factor)
    const rewardPips = stopPips * 5
    const rr         = 5

    const onChange = () => {
      const state = this.getTradeLinesState()
      // Recompute extendData from current dragged values so zone labels stay accurate
      const currentFactor   = pipFactor(this.pair)
      const currentStop     = Math.abs(state.entry - state.sl) * currentFactor
      const currentReward   = Math.abs(state.tp    - state.entry) * currentFactor
      const currentRR       = currentStop > 0 ? currentReward / currentStop : 0
      this.chart.overrideOverlay({
        id: this.tradeZoneId!,
        extendData: {
          dec,
          stopPips:   +currentStop.toFixed(1),
          rewardPips: +currentReward.toFixed(1),
          reward:     +(currentStop > 0 ? 100 * currentRR : 0).toFixed(0),
          rr:         +currentRR.toFixed(1),
        },
      })
      this.onTradeLinesChange?.(state)
    }

    const result = this.chart.createOverlay({
      name: 'tradeZone',
      points: [{ value: entry }, { value: sl }, { value: tp }],
      extendData: { dec, stopPips, rewardPips, reward: +(stopPips > 0 ? 100 * rr : 0), rr },
      lock: false,
      onPressedMoveEnd: onChange,
    })

    this.tradeZoneId = typeof result === 'string' ? result : null
    setTimeout(onChange, 100)
  }

  destroy(): void {
    this.chart.destroy?.()
  }
}
