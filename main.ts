// Deep-dip bounce bot for the BTC race: long-only mean reversion
// on 1-minute cbBTC bars, for make.fun competition
// "Race a BTC trading bot live for 24 hours" (btc-race-24h-20261115-0828).
//
// Strategy (tuned on this competition's published dev window, 1,440
// one-minute bars of CBBTC/USDC):
//   - Buy the dip, but ONLY when the dip is deep: when the latest close is
//     within 0.10% of the lowest close of the last 60 bars, the bar bounced
//     (close above the previous bar's close), AND the close is at least 4%
//     below the highest close of the last 480 bars. Buy with all available
//     cash.
//   - Sell: take profit at +3.0% over the entry close, stop out at -1.5%
//     under it, or exit after 60 bars held, whichever comes first.
//   - Stop-loss cooldown: after a stop-loss exit, no new position is
//     opened for the next 60 bars. A stop means the dip just proved it was
//     not a bounce; re-buying the next dip immediately risks a second
//     loss on the same slide. (On the dev window no trade hits the stop,
//     so the cooldown never triggers there; it only caps the unseen
//     window, like the breaker below.)
//   - Drawdown circuit-breaker: once equity has fallen 3% below its peak,
//     stop opening new positions for the rest of the window (exits are
//     never blocked). The race window is a different 24h from the dev
//     window; the breaker caps the worst case instead of letting the bot
//     keep buying dips in a waterfall it cannot see coming.
//   - One position at most, full size, at most one order per batch.
//
// Why the deep filter: this dev window falls -4.0% overall (67,216 ->
// 64,524) in two waterfalls (hours 5-7 to -2.9%, hours 13-17 to -6.8%)
// with one sharp rebound in hours 17-19 (+5.5% off the low, 62,082 ->
// 65,480). Plain dip-bounce and the prior round's trend-filtered version
// both lose on this window (the prior round's bot: -$39.65 on the kit
// grader; 5,120 trend-filtered dip-bounce configs: 0 positive). The
// deep-dip filter stays out of both waterfalls and only fires near the
// deep low, where the rebound lives. Local backtest of the same fill
// model (4 bps fee, 2 bps slippage, constant-product impact against the
// bar's open depth, fills at the next bar's open): net PnL +$37.20, 4
// trades, max drawdown 1.12%. The parameter region is wide, not a narrow
// pocket (1,027 of 1,944 deep-dip configs positive; the top cluster is
// identical across 60/90/120/240-bar lookbacks and 1.0%/1.5% stops).
// Treat the dev number as a gate pass, not a forecast: local backtests
// have overstated server gains ~2x in earlier rounds, and the race window
// is a different 24h.
//
// Determinism: float64 closes only, no clock, no environment, no randomness,
// so two runs on the same bars produce the same orders. Warm-up batches
// (if any) only build history; no orders are placed on them.

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Dip window: the low is the lowest close of the last 60 bars. */
const LOOKBACK_BARS = 60;
/** Deep window: the high is the highest close of the last 480 bars. */
const DEEP_BARS = 480;
/** Buy when the close is within this of the 60-bar low (10 bps). */
const DIP_BPS = 10;
/** Buy only when the close is at least this far below the 480-bar high (400 bps = 4%). */
const DEEP_DROP_BPS = 400;
/** Take profit / stop loss vs the entry close (300 / 150 bps). */
const TARGET_BPS = 300;
const STOP_BPS = 150;
/** Exit a position held this many CBBTC bars, whatever the price. */
const MAX_HOLD_BARS = 60;
/** After a stop-loss exit, wait this many bars before opening a new position. */
const COOLDOWN_BARS = 60;
const MAX_SLIPPAGE_BPS = 100;
/** Halt new entries once equity has fallen this far below its peak (300 bps = 3%). */
const MAX_DD_BPS = 300;

/** The closes of the last DEEP_BARS + 1 bars, oldest first. */
const closes: number[] = [];
/** The close of the previous CBBTC bar, for the bounce check. */
let prevClose: number | null = null;
/** How many CBBTC bars have been seen. */
let barsSeen = 0;
/** The close the current position was entered on, and the bar count then. */
let entryClose: number | null = null;
let entryBarsSeen = 0;
/** Peak equity seen (quote units) and whether the drawdown breaker tripped. */
let peakEquity: bigint | null = null;
let breakerTripped = false;
/** No new position before this bar count (set by a stop-loss exit). */
let cooldownUntil = 0;

await runBars({
  onBatch(state: BarsState, batch) {
    const orders: (BuyInput | SellInput)[] = [];
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      const close = Number(bar.c);
      barsSeen += 1;
      // Drawdown circuit-breaker, tracked on the harness's own equity
      // figure (cash + positions at the latest close): once equity has
      // fallen MAX_DD_BPS below its peak, no new positions are opened.
      // Deterministic bigint math only, so replays match byte for byte.
      if (peakEquity === null || state.equity > peakEquity) peakEquity = state.equity;
      if (!breakerTripped && state.equity * 10000n < peakEquity * (10000n - BigInt(MAX_DD_BPS))) breakerTripped = true;
      closes.push(close);
      if (closes.length > DEEP_BARS + 1) closes.shift();

      const held = state.positions.get(SYMBOL);
      // A sell decided on the previous bar has filled when the position is
      // gone; only then forget the entry (a rejected sell keeps it, so the
      // exit is retried instead of buying into a position still held).
      if (held === undefined && entryClose !== null) entryClose = null;
      if (held !== undefined && entryClose !== null) {
        const up = close * 10000 >= entryClose * (10000 + TARGET_BPS);
        const down = close * 10000 <= entryClose * (10000 - STOP_BPS);
        const stale = barsSeen - entryBarsSeen >= MAX_HOLD_BARS;
        if (up || down || stale) {
          if (down) cooldownUntil = barsSeen + COOLDOWN_BARS;
          orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      } else if (
        held === undefined &&
        !breakerTripped &&
        !state.warmingUp &&
        closes.length >= DEEP_BARS + 1 &&
        prevClose !== null
      ) {
        let low = closes[closes.length - LOOKBACK_BARS];
        for (let i = closes.length - LOOKBACK_BARS; i < closes.length; i++) {
          if (closes[i] < low) low = closes[i];
        }
        let high = closes[0];
        for (let i = 0; i < closes.length; i++) {
          if (closes[i] > high) high = closes[i];
        }
        const nearLow = close * 10000 <= low * (10000 + DIP_BPS);
        const bounced = close > prevClose;
        // Deep-dip filter: at least 4% below the 480-bar high.
        const deepDip = close * 10000 <= high * (10000 - DEEP_DROP_BPS);
        // Stop-loss cooldown: no re-entry until the cooldown expires.
        const cooledDown = barsSeen >= cooldownUntil;
        if (nearLow && bounced && deepDip && cooledDown) {
          const room = state.weightRoom(SYMBOL);
          const notional = state.cash < room ? state.cash : room;
          if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
            orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
            entryClose = close;
            entryBarsSeen = barsSeen;
          }
        }
      }
      prevClose = close;
    }
    return orders;
  },
});
