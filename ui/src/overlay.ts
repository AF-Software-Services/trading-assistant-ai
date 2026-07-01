import type { OverlayTemplate } from 'klinecharts'

/**
 * Custom overlay: horizontal zone band (support or resistance rectangle).
 * Points: [{ value: priceLow }, { value: priceHigh }]
 */
export const srZoneOverlay: OverlayTemplate = {
  name: 'srZone',
  // Two points: [{ value: priceLow }, { value: priceHigh }]
  // KLineChart converts these to pixel y-coordinates for us
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
          color: color + '30',
          borderColor: color + '70',
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
  createPointFigures ({ overlay, coordinates, barsRange, defaultStyles, xAxis, yAxis }) {
    if (!yAxis || coordinates.length === 0) return []
    const extData = overlay.extendData as { color: string; label: string }
    const color = extData?.color ?? '#ffffff'
    const label = extData?.label ?? ''
    const y = coordinates[0]?.y ?? 0
    const price = overlay.points[0]?.value ?? 0

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
          text: `${label} ${price.toFixed(5)}`,
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
 */
export const swingLabelOverlay: OverlayTemplate = {
  name: 'swingLabel',
  totalStep: 1,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures ({ overlay, coordinates }) {
    if (coordinates.length === 0) return []
    const extData = overlay.extendData as { label: string; above: boolean }
    const label = extData?.label ?? ''
    const above = extData?.above ?? true
    const { x, y } = coordinates[0]!
    const offsetY = above ? y - 18 : y + 6
    return [
      {
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
          color: '#58a6ff',
          size: 10,
          family: 'monospace',
          weight: '700',
        },
      },
    ]
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
    }
    if (!extData) return []

    const { label, color, confidence, necklinePrice } = extData
    const [left, head, right] = coordinates as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }]

    // Neckline y pixel
    const necklineY = yAxis ? (yAxis as { convertToPixel: (v: number) => number }).convertToPixel(necklinePrice) : (left.y + right.y) / 2

    const figures: ReturnType<NonNullable<OverlayTemplate['createPointFigures']>> = []

    // Lines connecting left → head → right
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

    // Neckline (horizontal across the pattern)
    figures.push({
      type: 'line',
      attrs: { coordinates: [{ x: left.x, y: necklineY }, { x: right.x, y: necklineY }] },
      styles: { style: 'dashed', color: '#e3b341', size: 1, dashedValue: [4, 4] },
    })

    // Label at head
    figures.push({
      type: 'text',
      attrs: {
        x: head.x,
        y: head.y - 18,
        text: `${label} ${confidence}%`,
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
 * Signal marker (BE↑ / BE↓) below/above candles.
 */
export const signalMarkerOverlay: OverlayTemplate = {
  name: 'signalMarker',
  totalStep: 1,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures ({ overlay, coordinates }) {
    if (coordinates.length === 0) return []
    const extData = overlay.extendData as { label: string; bullish: boolean }
    const label   = extData?.label ?? ''
    const bullish = extData?.bullish ?? true
    const { x, y } = coordinates[0]!
    const offsetY = bullish ? y + 6 : y - 18
    return [
      {
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
          color: bullish ? '#3fb950' : '#f85149',
          size: 11,
          family: 'sans-serif',
          weight: '700',
        },
      },
    ]
  },
}
