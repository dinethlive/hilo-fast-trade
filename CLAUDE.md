# HiLo-Fast — project guide for Claude

Time-block paired Deriv CLI. Computes a non-repainting predicted high /
predicted low per N-minute block, then opens TWO Deriv contracts at every
fresh block boundary — one guarding the upper line (predH), one the lower
(predL) — streams their live P/L, and closes the pair early when their
summed profit hits a block-TP target.

Both modes are **stay-in-range** bets (price should end up / remain inside
`[predL, predH]`); they differ only in path sensitivity:

- **higher-lower** (default): LOWER @ predH + HIGHER @ predL. Checks
  EXIT spot only — intrabar breaches that come back are fine. Lower payout,
  higher win rate.
- **no-touch**: NOTOUCH @ predH + NOTOUCH @ predL. Any intrabar touch of
  either barrier loses that leg. Higher payout, lower win rate.

## Runtime

- **Bun + TypeScript** (no Node). Scripts in `package.json`. Strict TS; JSX via `react-jsx`.
- **Ink 5 + React 18** for the TUI. `Zustand v5` (`create` from `zustand`) for state.
- Entry: `src/index.tsx`. Default renders the Ink TUI; `--no-ui` falls back to plain coloured stdout logs.
- Dev loop: `bun run typecheck`, `bun src/index.tsx --dry-run`.

## Layout

```
src/
  index.tsx                 # argv parse → setConfig → render <App/> (or plain log if --no-ui)
  cli/args.ts               # flag/env parser. Env overrides defaults; flags override env.
  constants/api.ts          # Deriv URLs, defaults (symbol, stake, block size, TP, mode, etc.)
  engine/
    blockClock.ts           # wall-clock, UTC-midnight-aligned block emitter (block-start / block-end)
    rangePredictor.ts       # pure function: candles → { blockOpen, predictedHigh, predictedLow, source }
  services/
    derivRest.ts            # OAuth listAccounts + getOtpUrl (one-time auth URL)
    derivWS/
      client.ts             # Deriv WS client: session rollover, reconnect, proposal/buy/sell, candles, contracts_for
      types.ts              # Public types (HiLoContractType, ContractUpdate, Candle, ContractConstraints, …)
      normalize.ts          # Raw-payload → typed-payload conversions
      index.ts              # Barrel re-export
  trading/
    config.ts               # HiLoConfig (symbol, stake, blockMinutes, mode, blockTp, sessionTp/Sl, …) + TradeMode union
    trader.ts               # Main bot: connect, candles, blockClock → onBlockStart → openPair, onBlockEnd → realise
    pairTrader.ts           # Owns current-block pair state; opens both legs; TP-driven sell; dispatches contract_type per mode
  state/
    store.ts                # Zustand store: config, status, account, lastSpot, currentPair, session, transcript, menuStack
  ui/
    App.tsx                 # Top-level Ink layout; owns Trader ref via CmdCtx; gates Prompt vs SelectMenu on menuStack
    Header.tsx              # Banner + 3-card row (MARKET, BLOCK, SESSION)
    BlockPanel.tsx          # ACTIVE PAIR panel: two leg boxes + TP progress bar (mode-aware labels)
    Transcript.tsx          # Last 30 log lines (Row components)
    Prompt.tsx              # `❯` input with /-autocomplete menu, history, Esc/Tab/Enter
    SelectMenu.tsx          # Nested-menu renderer driven by store.menuStack (↑↓, 1–9, Enter, Esc/←)
    Footer.tsx              # `/help · /start · /quit · Ctrl+C · clock`
    commands.ts             # Slash-command registry + dispatcher + patchCfg + submenu builders
    theme.ts                # Colour palette + fmtMoney/fmtPrice/fmtTime/fmtCountdown
    header/                 # Banner, StatusPill, MarketCard, BlockCard, SessionCard, primitives (Card/Metric/Gauge)
    transcript/             # Row.tsx, body.tsx (kind routers), labels.ts, kv.tsx
```

## Slash commands (src/ui/commands.ts)

- **Lifecycle**: `/start`, `/stop` (alias `/halt`), `/quit` (aliases `/exit`, `/q`).
- **Soft config** (hot-swap; affects the current and future blocks):
  `/block-tp <usd>` (aliases `/tp`, `/btp`), `/session-tp <usd|off>` (alias `/stp`),
  `/session-sl <usd|off>` (alias `/ssl`), `/stake <usd>`.
- **Hard config** (auto-stops the bot; user must `/start` again to re-validate):
  `/mode [higher-lower|no-touch]`, `/range-mode [hybrid|historical|atr]` (alias `/rm`),
  `/symbol <sym>`, `/block <min>`.
- **Introspection**: `/status` (alias `/st`), `/cfg`, `/clear` (alias `/cls`), `/help` (alias `/?`).

`/mode` and `/range-mode` pushed with no argument open a nested SelectMenu
(numbered picker, ↑↓ / 1–9 / Enter / Esc). Direct-arg form bypasses the menu.

The Trader exposes `patchConfig(patch)` which accepts the **soft** set only and
throws on hard-field changes. `commands.ts::patchCfg` routes through
`trader.patchConfig` when a Trader exists, or writes the store directly when
idle. One `setConfig` call per patch — the store notifies subscribers exactly once.

## Deriv API primitives used

- **Auth**: REST `listAccounts` → `getOtpUrl` → `wss://.../ws/demo?otp=…`. No legacy `authorize` flow.
- **Candles**: `ticks_history` with `style=candles`, `granularity = blockMinutes * 60`. Allowed granularities: 60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400. Live updates stream via the `ohlc` msg_type when `subscribe: 1`.
- **Proposal**: `{proposal:1, contract_type:'HIGHER'|'LOWER'|'NOTOUCH', amount, basis:'stake', currency, duration, duration_unit, underlying_symbol, barrier}`. Barrier is an absolute price string from the predictor (`+N` / `-N` relative forms are also accepted by Deriv but we always pass absolute).
  - `duration_unit` depends on contract type:
    - `HIGHER` / `LOWER`: `'s'` (seconds) — full block-end resolution works.
    - `NOTOUCH`: `'m'` (minutes) — synthetics only offer minute-resolution NOTOUCH, even though `contracts_for` reports a wider `5s..31536000s` range. Submitting seconds returns `"Trading is not offered for this duration"`. We round to `cfg.blockMinutes`.
- **Buy**: `{buy: proposal.id, price: ask_price * (1 + slippagePct), subscribe: 1}`. Default 10% slippage pad; setting `price = ask_price` exactly would bounce with `[PriceMoved]` on any intrabar drift between proposal and buy dispatch.
- **Live P/L**: `proposal_open_contract` subscription; read `profit`, `bid_price`, `is_valid_to_sell`, `status` ('open'|'won'|'lost'|'sold'|'cancelled').
- **Sell**: `{sell: contract_id, price: 0}` where 0 = accept market. **Only call when `is_valid_to_sell === 1`** — Deriv rejects sells otherwise. Non-sellable legs ride to expiry.
- **Symbol guard**: `contracts_for` must list the contract type(s) required by the current mode — `HIGHER` and `LOWER` for `higher-lower`, or `NOTOUCH` for `no-touch`. `Trader.verifySymbolSupports` also extracts per-contract-type duration bounds (`min_contract_duration` / `max_contract_duration`) and hands them to `PairTrader.setConstraints` for pre-submit validation, so we fail fast with clear warnings instead of eating server errors.

## Invariants (don't break these)

- **Prediction is locked per block.** Once `predictRange` has run at block-start, `predictedHigh` / `predictedLow` must not change intrabar. Guarantees non-repaint. Don't call it more than once per block from the Trader.
- **One pair per block.** `pairTrader` opens the two legs in parallel via `Promise.allSettled`; never a second pair before the current block ends.
- **Both modes are stay-in-range.** `higher-lower` = LOWER @ predH + HIGHER @ predL (exit-spot only). `no-touch` = NOTOUCH @ predH + NOTOUCH @ predL (no intrabar touch). Don't confuse with a breakout strategy.
- **Barrier sanity**: upper leg is skipped if `predictedHigh <= spot`; lower leg is skipped if `predictedLow >= spot`. The barrier must be on the right side of current spot for the bet to be meaningful (regardless of mode).
- **Fresh blocks only.** `Trader.start()` does NOT fire `onBlockStart` for the in-progress block — it waits for the next UTC-aligned boundary. This aligns the contract duration 1:1 with the block and keeps the prediction fresh.
- **NOTOUCH duration resolution**: NOTOUCH is submitted in minutes, so the pair skips any block where the full `blockMinutes` isn't available. Paired with the fresh-block-only rule, this never triggers in practice.
- **UTC-midnight grid**: `BlockClock` floors `nowSec / blockSec`, i.e. blocks are anchored to UTC 00:00.
- **Stop is one-shot.** `Trader.stop()` tears down the WebSocket (`intentionalClose = true`) — the same instance can't restart. `commands.ts::ensureTrader` creates a fresh Trader after each `/stop`.
- **Soft vs hard config.** Soft fields (`stake`, `blockTp`, `sessionTp`, `sessionSl`, `currency`) are hot-swap safe via `Trader.patchConfig`. Hard fields (`mode`, `rangeMode`, `symbol`, `blockMinutes`, `lookbackDays`, `atrBars`, `rangeK`, auth) auto-stop on change — user must `/start` to resume.

## Config & env

Runtime defaults live in `src/constants/api.ts`. `.env` (auto-loaded by Bun) can set:
- Auth / account: `DERIV_TOKEN`, `DERIV_APP_ID`, `DERIV_ACCOUNT_ID`, `HILO_PREFER` (demo|real)
- Market: `HILO_SYMBOL`, `HILO_STAKE`, `HILO_CURRENCY`
- Block grid: `HILO_BLOCK_MINUTES`, `HILO_BLOCK_TP`, `HILO_SESSION_TP`, `HILO_SESSION_SL`
- Trade primitive: `HILO_TRADE_MODE` (higher-lower|no-touch)
- Prediction: `HILO_RANGE_MODE`, `HILO_LOOKBACK_DAYS`, `HILO_ATR_BARS`, `HILO_RANGE_K`

Precedence: **CLI flag > env var > built-in default**.

## TUI conventions

- **Single outer padding**. `App.tsx` holds the only `paddingX={1} paddingTop={1}`; every other panel renders flush. Don't re-add per-child `paddingX` — it shifts elements out of alignment.
- **Transcript rows truncate, never wrap.** `transcript/Row.tsx` uses `<Text wrap="truncate-end">` — if you add a new log kind, preserve this wrapper so timestamps can't split across lines.
- **Leg labels always carry an arrow.** `↑` = upper/predH leg, `↓` = lower/predL leg. The text before the arrow is the actual Deriv contract type (`LOWER↑`, `HIGHER↓`, `NOTOUCH↑`, `NOTOUCH↓`). Transcript regexes accept the arrow-less legacy form too.
- **Commands read/write through the store.** Never mutate Trader internals from a command handler; go through `patchCfg` or `trader.patchConfig`. That's the only way the TUI sees the change.
- **Colour palette in `src/ui/theme.ts`**. Gold = block / trade-open, upBright/downBright = wins/losses, violet = barrier & no-touch mode, ice = duration, accent (cyan) = chrome & higher-lower mode, accent2 (magentaBright) = sell. New UI text should pick from the theme — don't introduce raw hex elsewhere.
- **Prompt alignment**. The input row renders `❯ {value}`, so the typed `/` lands at column 2 of the Prompt container. The autocomplete menu uses a 2-char indicator (`› ` / `  `) then `/{name}` so the menu's `/` lines up under the typed `/`. Changing indicator width breaks alignment.
- **SelectMenu gating.** `App.tsx` renders `<SelectMenu>` instead of `<Prompt>` when `menuStack.length > 0` — both install `useInput`, never render them simultaneously. Push menus via `useStore.getState().pushMenu({title, items})`.

## Testing

- `bun run typecheck` — must stay clean; CI-style gate before any commit.
- `bun src/index.tsx --help` — sanity-check the CLI surface.
- `bun src/index.tsx --dry-run --block-minutes 1 --block-tp 3` — end-to-end smoke in a wide terminal. Synthetic candles, simulated buys/sells, no network. Note: `/start` now waits for the next UTC-aligned 1-minute boundary (up to 60s), then opens a pair. Block rolls over every minute thereafter.
- There is no unit-test harness yet — adding one would start in `engine/rangePredictor.test.ts` with fixture candle arrays asserting deterministic outputs.

## Ancestry

Heavy inspiration from `G:\Dineth\deriv\kairos-trade` (same author, different strategy). Parts reused verbatim: OAuth+OTP auth flow, session-rollover / reactive-reconnect lifecycle in the WS client, Zustand store pattern, Ink transcript row layout, nested SelectMenu pattern, Prompt/CommandMenu autocomplete. What was intentionally dropped: martingale, sniper, rotation, fuzz, adaptive-duration — HiLo-Fast's strategy locks both legs for the whole block and has no use for those overlays.

The range predictor started life as an MT5 chart indicator (vertical block lines + historical-same-TOD predicted high/low + ATR fallback). It's been fully ported to `engine/rangePredictor.ts`; the MT5 `.mq5` source is no longer in the repo.
