import type { OverlayTemplate } from 'klinecharts'

/**
 * Custom overlay: horizontal zone band (support or resistance rectangle).
 * Points: [{ value: priceLow }, { value: priceHigh }]
 */
export const srZoneOverlay: OverlayTemplate = {
  name: 'srZone',
  totalStep: 3,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures ({ overlay, coordinates }) {
    if (coordinates.length < 2) return []
    const extData = overlay.extendData as { color: string; label: string }
    if (!extData) return []

    const { color, label } = extData
    const y1   = coordinates[0]!.y
    const y2   = coordinates[1]!.y
    const yTop = Math.min(y1, y2)
    const height = Math.max(Math.abs(y1 - y2), 2)

    return [
      {
        type: 'rect',
        attrs: { x: 0, y: yTop, width: 99999, height },
        styles: {
          style: 'fill',
          color: color + '40',
          borderColor: color + '99',
          borderSize: 1,
          borderStyle: 'solid',
        },
      },
      {
        type: 'text',
        attrs: { x: 8, y: yTop + 2, text: label, align: 'left', baseline: 'top' },
        styles: {
          style: 'fill',
          color: color + 'cc',
          size: 10,
          family: 'monospace',
          weight: '600',
        },
      },
    ]
  },
}

/**
 * Trade zone overlay — entry, SL and TP in one overlay.
 * Points: [entry, sl, tp]
 * extendData: { dec: number; stopPips: number; rewardPips: number; reward: number; rr: number }
 */
export const tradeZoneOverlay: OverlayTemplate = {
  name: 'tradeZone',
  totalStep: 4,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures ({ overlay, coordinates, bounding }) {
    if (coordinates.length < 3) return []

    const extData = overlay.extendData as {
      dec: number
      stopPips: number
      rewardPips: number
      reward: number
      rr: number
    }
    const dec        = extData?.dec        ?? 5
    const stopPips   = extData?.stopPips   ?? 0
    const rewardPips = extData?.rewardPips ?? 0
    const reward     = extData?.reward     ?? 0
    const rr         = extData?.rr         ?? 0

    const entryY = coordinates[0]!.y
    const slY    = coordinates[1]!.y
    const tpY    = coordinates[2]!.y
    const entry  = overlay.points[0]?.value ?? 0
    const sl     = overlay.points[1]?.value ?? 0
    const tp     = overlay.points[2]?.value ?? 0

    const b: Record<string, number> = bounding as unknown as Record<string, number>
    const chartTop    = b['top']    ?? 0
    const chartBottom = b['bottom'] ?? 99999

    type Fig = ReturnType<NonNullable<OverlayTemplate['createPointFigures']>>[number]
    const figs: Fig[] = []

    // ── Colored zone rectangles ──────────────────────────────────────────────
    const slTop = Math.max(chartTop,    Math.min(entryY, slY))
    const slBot = Math.min(chartBottom, Math.max(entryY, slY))
    if (slBot > slTop) {
      figs.push({
        type: 'rect',
        attrs: { x: 0, y: slTop, width: 99999, height: slBot - slTop },
        styles: { style: 'fill', color: 'rgba(248,81,73,0.13)', borderColor: 'transparent', borderSize: 0 },
      })
    }
    const tpTop = Math.max(chartTop,    Math.min(entryY, tpY))
    const tpBot = Math.min(chartBottom, Math.max(entryY, tpY))
    if (tpBot > tpTop) {
      figs.push({
        type: 'rect',
        attrs: { x: 0, y: tpTop, width: 99999, height: tpBot - tpTop },
        styles: { style: 'fill', color: 'rgba(63,185,80,0.09)', borderColor: 'transparent', borderSize: 0 },
      })
    }

    // ── Helper: draw a horizontal line or off-screen edge indicator ──────────
    function addLine(y: number, color: string, price: number, label: string, info: string) {
      const above = y < chartTop
      const below = y > chartBottom
      if (above || below) {
        const ey = above ? chartTop + 14 : chartBottom - 14
        const arrow = above ? '▲' : '▼'
        const txt = `${arrow} ${label}  ${price.toFixed(dec)}  ${info}`
        figs.push({
          type: 'rect',
          attrs: { x: 4, y: ey - 9, width: txt.length * 7 + 8, height: 18 },
          styles: { style: 'fill', color: '#0d1117', borderColor: color, borderSize: 1, borderStyle: 'solid' },
        })
        figs.push({
          type: 'text',
          attrs: { x: 8, y: ey - 7, text: txt, align: 'left', baseline: 'top' },
          styles: { style: 'fill', color, size: 11, family: 'monospace', weight: '700' },
        })
      } else {
        figs.push({
          type: 'line',
          attrs: { coordinates: [{ x: 0, y }, { x: 99999, y }] },
          styles: { style: 'solid', color, size: 1 },
        })
        figs.push({
          type: 'text',
          attrs: { x: 8, y: y + 2, text: `${label}  ${price.toFixed(dec)}  ${info}`, align: 'left', baseline: 'top' },
          styles: { style: 'fill', color, size: 10, family: 'monospace', weight: '600' },
        })
      }
    }

    addLine(entryY, '#e6edf3', entry, 'ENTRY', '')
    addLine(slY,    '#f85149', sl,    'SL',    stopPips   > 0 ? `${stopPips.toFixed(1)} pips  |  £100 risk`             : '')
    addLine(tpY,    '#3fb950', tp,    'TP',    rewardPips > 0 ? `${rewardPips.toFixed(1)} pips  |  £${reward.toFixed(0)} reward  |  ${rr.toFixed(1)}:1` : '')

    // Zone labels centred in each coloured band (only if zone has enough height)
    const slMid = (slTop + slBot) / 2
    const tpMid = (tpTop + tpBot) / 2
    if (slBot - slTop > 20 && stopPips > 0) {
      figs.push({
        type: 'text',
        attrs: { x: 8, y: slMid - 6, text: `Stop: ${stopPips.toFixed(1)} pips  |  £100 max loss`, align: 'left', baseline: 'top' },
        styles: { style: 'fill', color: '#f85149', size: 10, family: 'monospace', weight: '400' },
      })
    }
    if (tpBot - tpTop > 20 && rewardPips > 0) {
      figs.push({
        type: 'text',
        attrs: { x: 8, y: tpMid - 6, text: `Target: ${rewardPips.toFixed(1)} pips  |  £${reward.toFixed(0)} reward  |  R:R ${rr.toFixed(1)}`, align: 'left', baseline: 'top' },
        styles: { style: 'fill', color: '#3fb950', size: 10, family: 'monospace', weight: '400' },
      })
    }

    return figs
  },
}

/**
 * Swing-point text annotation.
 * Single point: [{ timestamp, value }]
 * extendData: { label: string; above: boolean; bullish: boolean; isLatest: boolean }
 */
export const swingLabelOverlay: OverlayTemplate = {
  name: 'swingLabel',
  totalStep: 1,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures ({ overlay, coordinates }) {
    if (coordinates.length === 0) return []
    const extData = overlay.extendData as { label: string; above: boolean; bullish: boolean; isLatest: boolean }
    const label    = extData?.label ?? ''
    const above    = extData?.above ?? true
    const bullish  = extData?.bullish ?? true
    const isLatest = extData?.isLatest ?? false
    const { x, y } = coordinates[0]!
    const pointY = y
    const offsetY = above ? y - 20 : y + 6

    const dotColor = bullish ? '#3fb950' : '#f85149'

    const figures: ReturnType<NonNullable<OverlayTemplate['createPointFigures']>> = []

    // Small dot at the pivot point
    figures.push({
      type: 'circle',
      attrs: { x, y: pointY, r: 3 },
      styles: { style: 'fill', color: dotColor },
    })

    // Label text
    figures.push({
      type: 'text',
      attrs: {
        x,
        y: offsetY,
        text: label,
        align: 'center',
        baseline: 'top',
      },
      styles: {
        style: 'fill',
        color: isLatest ? '#ffffff' : '#58a6ff',
        size: isLatest ? 12 : 10,
        family: 'monospace',
        weight: isLatest ? '800' : '700',
      },
    })

    return figures
  },
}

/**
 * Head & Shoulders / Inverse H&S pattern overlay.
 * Three points: [leftShoulder, head, rightShoulder]
 * extendData: { label, color, confidence, necklinePrice }
 */
export const hnsOverlay: OverlayTemplate = {
  name: 'hns',
  totalStep: 4,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures ({ overlay, coordinates, yAxis }) {
    if (coordinates.length < 3) return []
    const extData = overlay.extendData as {
      label: string
      color: string
      confidence: number
      necklinePrice: number
      confirmed: boolean
    }
    if (!extData) return []

    const { label, color, confidence, necklinePrice, confirmed } = extData
    const [left, head, right] = coordinates as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }]

    const necklineY = yAxis ? (yAxis as { convertToPixel: (v: number) => number }).convertToPixel(necklinePrice) : (left.y + right.y) / 2

    const figures: ReturnType<NonNullable<OverlayTemplate['createPointFigures']>> = []

    figures.push({
      type: 'line',
      attrs: { coordinates: [{ x: left.x, y: left.y }, { x: head.x, y: head.y }] },
      styles: { style: 'solid', color, size: 1 },
    })
    figures.push({
      type: 'line',
      attrs: { coordinates: [{ x: head.x, y: head.y }, { x: right.x, y: right.y }] },
      styles: { style: 'solid', color, size: 1 },
    })

    figures.push({
      type: 'line',
      attrs: { coordinates: [{ x: left.x, y: necklineY }, { x: right.x, y: necklineY }] },
      styles: { style: 'dashed', color: '#e3b341', size: 1, dashedValue: [4, 4] },
    })

    // Label with diamond symbol
    const symbol = confirmed ? '◆' : '◇'
    figures.push({
      type: 'text',
      attrs: {
        x: head.x,
        y: head.y - 18,
        text: `${symbol} ${label} ${confidence}%`,
        align: 'center',
        baseline: 'top',
      },
      styles: {
        style: 'fill',
        color,
        size: 10,
        family: 'monospace',
        weight: '700',
      },
    })

    return figures
  },
}

/**
 * Signal marker (engulfing) below/above candles.
 * extendData: { bullish: boolean }
 */
export const signalMarkerOverlay: OverlayTemplate = {
  name: 'signalMarker',
  totalStep: 1,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures ({ overlay, coordinates }) {
    if (coordinates.length === 0) return []
    const extData = overlay.extendData as { bullish: boolean }
    const bullish = extData?.bullish ?? true
    const { x, y } = coordinates[0]!
    const offsetY = bullish ? y + 8 : y - 24

    return [
      // Background rect for readability
      {
        type: 'rect',
        attrs: { x: x - 24, y: offsetY - 1, width: 48, height: 16 },
        styles: {
          style: 'fill',
          color: bullish ? '#1a3a1a' : '#3a1a1a',
          borderColor: bullish ? '#3fb950' : '#f85149',
          borderSize: 1,
          borderStyle: 'solid',
        },
      },
      // Arrow + label text
      {
        type: 'text',
        attrs: { x, y: offsetY, text: bullish ? '▲ Bull' : '▼ Bear', align: 'center', baseline: 'top' },
        styles: {
          style: 'fill',
          color: bullish ? '#3fb950' : '#f85149',
          size: 10,
          family: 'sans-serif',
          weight: '700',
        },
      },
    ]
  },
}
