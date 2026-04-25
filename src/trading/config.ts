import type { RangeMode } from '../engine/rangePredictor';

/**
 * Which Deriv contract primitive each block's pair is opened as:
 *   - 'higher-lower': breakout bet. Upper leg = HIGHER @ predH, lower leg =
 *     LOWER @ predL. A leg wins if exit spot is strictly past its barrier.
 *   - 'no-touch':     stay-in-range bet. Both legs are NOTOUCH — upper @
 *     predH, lower @ predL. A leg wins only if spot NEVER touches its
 *     barrier during the block. Both win ⇒ price stayed in [predL, predH].
 */
export type TradeMode = 'higher-lower' | 'no-touch';

export interface HiLoConfig {
  // Auth / transport
  appId: string;
  token: string;
  accountId?: string;
  preferAccountType?: 'demo' | 'real';

  // Market
  symbol: string;
  currency: string;

  // Sizing
  stake: number; // per-leg stake

  // Block grid
  blockMinutes: number;

  // Trade primitive
  mode: TradeMode;

  // Take-profit / stop
  blockTp: number;       // close pair when summed live P/L >= this (per-block)
  sessionTp?: number;    // halt trading when session P/L >= this
  sessionSl?: number;    // halt trading when session P/L <= -this

  // Prediction model
  rangeMode: RangeMode;
  lookbackDays: number;
  atrBars: number;
  rangeK: number;

  // Modes
  dryRun: boolean;
  /** Skip the contracts_for check. For debugging only — Deriv will reject the proposal. */
  skipContractCheck: boolean;
  /** If true, render plain console output instead of the Ink TUI. */
  noUi: boolean;
}

export function blockSeconds(cfg: HiLoConfig): number {
  return cfg.blockMinutes * 60;
}
