const BASE = ''

export interface CandleData {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
}

export interface Zone {
  type: 'support' | 'resistance'
  high: number
  low: number
  timeframe: string
  strength: number
}

export interface Signal {
  type: string
  confidence: number
  timestamp: number
  price: number
}

export interface SwingPoint {
  label: 'HH' | 'HL' | 'LH' | 'LL'
  price: number
  timestamp: number
}

export interface AnalysisResult {
  pair: string
  trend: string
  zones: Zone[]
  structure: {
    trend: string
    swingPoints: SwingPoint[]
  }
  signals: Signal[]
  buyScore: number
  sellScore: number
  patterns?: Array<{
    type: string
    status: string
    neckline?: number
    target?: number
    confidence: number
    extendedData?: {
      leftShoulderTimestamp: number
      leftShoulderPrice: number
      headTimestamp: number
      headPrice: number
      rightShoulderTimestamp: number
      rightShoulderPrice: number
      necklinePrice: number
    }
  }>
}

export interface TradeIdea {
  pair: string
  direction: 'BUY' | 'SELL'
  entry: number
  stopLoss: number
  takeProfit: number
  riskReward: number
  riskAmount: number
  rewardAmount: number
  notes?: string
}

export async function getCandles(
  pair: string,
  timeframe: string,
  count = 200
): Promise<CandleData[]> {
  const encodedPair = encodeURIComponent(pair)
  const res = await fetch(
    `${BASE}/api/v1/candles/${encodedPair}?timeframe=${timeframe}&count=${count}`
  )
  if (!res.ok) throw new Error(`Candles fetch failed: ${res.status}`)
  const data = await res.json() as { candles: CandleData[] }
  return data.candles
}

export async function getAnalysis(pair: string): Promise<AnalysisResult> {
  const encodedPair = encodeURIComponent(pair)
  const res = await fetch(`${BASE}/api/v1/analysis/${encodedPair}`)
  if (!res.ok) throw new Error(`Analysis fetch failed: ${res.status}`)
  return res.json() as Promise<AnalysisResult>
}

export async function saveTradeIdea(idea: TradeIdea): Promise<{ id: string; createdAt: number }> {
  const res = await fetch(`${BASE}/api/v1/trade-ideas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(idea),
  })
  if (!res.ok) throw new Error(`Save failed: ${res.status}`)
  return res.json() as Promise<{ id: string; createdAt: number }>
}
