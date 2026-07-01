import type { TradeLinesState } from './chart'
import type { TradeIdea } from './api'
import { saveTradeIdea } from './api'

function pipFactor(pair: string): number {
  return pair.includes('JPY') ? 100 : 10000
}

function el(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement
}

export class TradePanel {
  private pair: string = 'EUR/USD'
  private state: TradeLinesState = { entry: 0, sl: 0, tp: 0 }

  constructor() {
    el('save-trade-btn').addEventListener('click', () => this.saveTrade())
  }

  setPair(pair: string): void {
    this.pair = pair
  }

  update(state: TradeLinesState): void {
    this.state = state
    this.render()
  }

  private render(): void {
    const { entry, sl, tp } = this.state
    if (entry === 0) return

    const factor = pipFactor(this.pair)
    const stopPips = Math.abs(entry - sl) * factor
    const tpPips   = Math.abs(tp - entry) * factor
    const rr        = stopPips > 0 ? tpPips / stopPips : 0
    const direction: 'BUY' | 'SELL' = tp > entry ? 'BUY' : 'SELL'
    const risk    = 100
    const reward  = risk * rr

    const dec = this.pair.includes('JPY') ? 3 : 5

    el('tp-direction').textContent = direction
    el('tp-direction').className = `value ${direction === 'BUY' ? 'buy' : 'sell'}`

    el('tp-entry').textContent = entry.toFixed(dec)
    el('tp-sl').textContent    = sl.toFixed(dec)
    el('tp-tp').textContent    = tp.toFixed(dec)
    el('tp-stop-pips').textContent = stopPips.toFixed(1)
    const rrLabel = rr >= 5 ? `${rr.toFixed(1)} ✓` : rr >= 3 ? `${rr.toFixed(1)}` : `${rr.toFixed(1)} ✗ (min 3:1)`
    el('tp-rr').textContent    = rrLabel
    el('tp-rr').style.color    = rr >= 5 ? 'var(--buy)' : rr >= 3 ? '#e3b341' : 'var(--sell)'
    el('tp-risk').textContent  = `£${risk.toFixed(0)} (max loss)`
    el('tp-reward').textContent = `£${reward.toFixed(0)}`

    // Position size: standard lots needed to risk exactly £100 at this stop distance
    // Non-JPY: £1/pip/mini lot — JPY: ~£0.067/pip/mini lot (approx at current rate)
    const pipValue = this.pair.includes('JPY') ? 0.067 : 1.0
    const lots = stopPips > 0 ? (risk / (stopPips * pipValue)) / 10 : 0
    el('tp-lots').textContent = lots > 0 ? `${lots.toFixed(2)} lots` : '—'
  }

  private async saveTrade(): Promise<void> {
    const { entry, sl, tp } = this.state
    if (entry === 0) return

    const factor  = pipFactor(this.pair)
    const stopPips = Math.abs(entry - sl) * factor
    const tpPips   = Math.abs(tp - entry) * factor
    const rr       = stopPips > 0 ? tpPips / stopPips : 0
    const direction: 'BUY' | 'SELL' = tp > entry ? 'BUY' : 'SELL'

    const idea: TradeIdea = {
      pair: this.pair,
      direction,
      entry,
      stopLoss: sl,
      takeProfit: tp,
      riskReward: rr,
      riskAmount: 100,
      rewardAmount: 100 * rr,
    }

    const btn = el('save-trade-btn') as HTMLButtonElement
    const status = el('save-status')
    btn.disabled = true
    btn.textContent = 'Saving…'
    status.className = 'hidden'

    try {
      const result = await saveTradeIdea(idea)
      status.textContent = `Saved (ID: ${result.id.slice(0, 8)}…)`
      status.className = ''
      status.style.color = 'var(--buy)'
    } catch (err) {
      status.textContent = `Error: ${(err as Error).message}`
      status.className = ''
      status.style.color = 'var(--sell)'
    } finally {
      btn.disabled = false
      btn.textContent = 'Save Trade Idea'
    }
  }
}
