# Deep-Dip Bounce BTC Bot — make.fun "Race a BTC trading bot live for 24 hours"

A long-only mean-reversion bot that trades Coinbase Wrapped BTC (cbBTC)
against USDC on 1-minute on-chain bars, for the make.fun competition
`btc-race-24h-20261115-0828`. It starts with $1,000 of paper money; nothing is
traded for real.

## Strategy

- **Buy the dip — but only a deep one:** when the latest close is within
  0.10% of the lowest close of the last 60 bars **and** the bar bounced
  (close above the previous bar's close) **and** the close is at least 4%
  below the highest close of the last 480 bars, buy with all available cash.
- **Sell:** take profit at +3.0% over the entry close, stop out at -1.5%
  under it, or exit after 60 bars held, whichever comes first.
- **Drawdown circuit-breaker:** once equity has fallen 3% below its peak,
  no new positions are opened for the rest of the window (exits are never
  blocked).
- At most one open position, full size, at most one order per batch.

## Why this, and not the prior round's trend-filtered dip-bounce

The published dev window falls -4.0% overall (67,216 -> 64,524) in two
waterfalls (hours 5-7 to -2.9%, hours 13-17 to -6.8%) with one sharp
rebound in hours 17-19 (+5.5% off the low, 62,082 -> 65,480). The prior
round's trend-filtered dip-bounce bot scores -$39.65 on this window on the
kit grader, and a 5,120-config grid of trend-filtered dip-bounce has zero
positive configs: the trend filter that saved the prior round now blocks
the only winning trade, because the rebound follows a deeply negative
120-bar return. The deep-dip filter stays out of both waterfalls and only
fires near the deep low, where the rebound lives. Buy-and-hold loses
about -$40 on the same window.

## Dev-window result (kit grade-local, --driver process)

- **Net PnL +$34.03 USDC** (return +3.40%) — passes the dev gate (> $0).
- 4 trades, win rate 100%, max drawdown 1.07%, exposure 7.4%.
- Fees $1.62; guardrails met; L1 regrade reproduced.
- A local Python backtest of the same fill model gave +$37.20 (4 trades);
  the small gap is the entry-price convention (decision-bar close vs fill).

## Honest caveats

- This entry is a gate pass, not a forecast — the race window is a
  different 24 hours, and local backtests have overstated server gains ~2x
  in earlier rounds.
- The parameter region is wide, not a narrow pocket: 1,027 of 1,944
  deep-dip configs are positive, and the top cluster is identical across
  60/90/120/240-bar lookbacks and 1.0%/1.5% stops. The bot sits out most
  of the window (exposure 7.4%): in a race window with no deep dip it may
  trade little or nothing.

## Files

- `main.ts` — the bot (Node 22, TypeScript, erasable syntax only). Speaks
  `agent-fun/bars-replay/v1`: newline-delimited JSON on stdin/stdout, one
  reply per batch. Standard library only, plus the vendored SDK shim.
- `vendor/makefun-bars.ts` — byte-identical copy of this competition kit's
  `sdk/makefun-bars.ts` shim (includes warm-up batch support).

## Run it locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

Deterministic: float64 closes only, no clock, no environment, no randomness,
so two runs on the same bars produce the same orders.
