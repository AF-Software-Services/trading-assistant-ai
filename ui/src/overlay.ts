import type { OverlayTemplate } from 'klinecharts'

/**
 * Custom overlay: horizontal zone band (support or resistance rectangle).
 * Points: [{ value: priceLow }, { value: priceHigh }]
 */
export const srZoneOverlay: OverlayTemplate = {
  name: 'srZone',
  totalStep: 1,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: () => [],
  createPanesFigures ({ overlay, coordinateToBar, barsRange, defaultStyles, xAxis, yAxis }) {
    if (!yAxis) return []
    const extData = overlay.extendData as {
      priceLow: number
      priceHigh: number
      color: string
      label: string
    }
    if (!extData) return []

    const { priceLow, priceHigh, color, label } = extData

    const yHigh = yAxis.convertToPixel(priceHigh)
    const yLow  = yAxis.convertToPixel(priceLow)
    const height = Math.abs(yLow - yHigh)
    const yTop   = Math.min(yHigh, yLow)

    return [
      {
        type: 'rect',
        attrs: {
          x: 0,
          y: yTop,
          width: 99999, // fill full width
          height: Math.max(height, 1),
        },
        styles: {
          style: 'fill',
          color: color + '33', // 20% opacity
          borderColor: color + '88',
          borderSize: 1,
          borderStyle: 'solid',
        },
      },
      {
        type: 'text',
        attrs: {
          x: 6,
          y: yTop + 3,
          text: label,
          align: 'left',
          baseline: 'top',
        },
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
