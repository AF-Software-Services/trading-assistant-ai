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
 * Custom overlay: draggable horizontal line (Entry / SL / TP).
 * Single point: [{ value: price }]
 */
export const hLineOverlay: OverlayTemplate = {
  name: 'hLine',
  totalStep: 1,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures ({ overlay, coordinates, yAxis, bounding }) {
    if (!yAxis || coordinates.length === 0) return []
    const extData = overlay.extendData as { color: string; label: string }
    const color = extData?.color ?? '#ffffff'
    const label = extData?.label ?? ''
    const y = coordinates[0]?.y ?? 0
    const price = overlay.points[0]?.value ?? 0
    const dec = price > 10 ? 3 : 5

    const chartTop    = (bounding as { top?: number }).top ?? 0
    const chartBottom = (bounding as { bottom?: number }).bottom ?? 99999
    const isAbove = y < chartTop
    const isBelow = y > chartBottom

    // Line is off screen — draw an edge arrow indicator
    if (isAbove || isBelow) {
      const edgeY  = isAbove ? chartTop + 14 : chartBottom - 14
      const arrow  = isAbove ? '▲' : '▼'
      const bgH    = 18
      const textW  = 110
      return [
        {
          type: 'rect',
          attrs: { x: 4, y: edgeY - bgH / 2, width: textW, height: bgH },
          styles: {
            style: 'fill',
            color: '#0d1117',
            borderColor: color,
            borderSize: 1,
            borderStyle: 'solid',
          },
        },
        {
          type: 'text',
          attrs: {
            x: 8,
            y: edgeY - bgH / 2 + 2,
            text: `${arrow} ${label} ${price.toFixed(dec)}`,
            align: 'left',
            baseline: 'top',
          },
          styles: {
            style: 'fill',
            color,
            size: 11,
            family: 'monospace',
            weight: '700',
          },
        },
      ]
    }

    return [
      {
        type: 'line',
        attrs: {
          coordinates: [
            { x: 0,     y },
            { x: 99999, y },
          ],
        },
        styles: {
          style: 'solid',
          color,
          size: 1,
        },
      },
      {
        type: 'text',
        attrs: {
          x: 6,
          y: y - 13,
          text: `${label} ${price.toFixed(dec)}`,
          align: 'left',
          baseline: 'top',
        },
        styles: {
          style: 'fill',
          color,
          size: 11,
          family: 'monospace',
          weight: '600',
        },
      },
    ]
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
