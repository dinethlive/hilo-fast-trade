import type { DerivWS } from '../services/derivWS';
import type { ContractConstraints, ContractUpdate, HiLoContractType } from '../services/derivWS/types';
import { useStore, type LegSide, type LegState, type PairState } from '../state/store';
import type { HiLoConfig, TradeMode } from './config';

/**
 * Map a (mode, leg-role) pair to the concrete Deriv contract_type.
 *
 * Both modes are STAY-IN-RANGE bets — the difference is the path sensitivity:
 *
 *   higher-lower / upper → LOWER   @ predH  (wins if EXIT spot < predH)
 *   higher-lower / lower → HIGHER  @ predL  (wins if EXIT spot > predL)
 *   no-touch     / upper → NOTOUCH @ predH  (wins if spot NEVER touches predH)
 *   no-touch     / lower → NOTOUCH @ predL  (wins if spot NEVER touches predL)
 *
 * HIGHER/LOWER checks exit-spot only — intrabar breaches are OK as long as
 * price closes back in range. NO TOUCH is strictly stricter: any touch
 * loses. Deriv prices that accordingly — NOTOUCH pays more, HIGHER/LOWER
 * pays less but wins more often.
 *
 * Both HIGHER and LOWER accept absolute or spot-relative barriers per
 * Deriv docs; we always pass absolute prices from the range predictor.
 */
function contractTypeFor(mode: TradeMode, side: LegSide): HiLoContractType {
  if (mode === 'no-touch') return 'NOTOUCH';
  // Stay-in-range via HIGHER/LOWER:
  //   upper-barrier leg bets price stays BELOW predH → LOWER contract
  //   lower-barrier leg bets price stays ABOVE predL → HIGHER contract
  return side === 'HIGHER' ? 'LOWER' : 'HIGHER';
}

/**
 * Label for logs / leg titles. Arrow points at which barrier the leg
 * is guarding (↑ = upper/predH, ↓ = lower/predL). This is consistent
 * across both modes so users can always read the arrow as "which line".
 */
export function legDisplayName(mode: TradeMode, side: LegSide): string {
  const arrow = side === 'HIGHER' ? '↑' : '↓';
  if (mode === 'no-touch') return `NOTOUCH${arrow}`;
  // HIGHER/LOWER mode: upper leg = LOWER contract, lower leg = HIGHER contract.
  return side === 'HIGHER' ? `LOWER${arrow}` : `HIGHER${arrow}`;
}

export interface OpenPairParams {
  blockStart: number;
  blockEnd: number;
  blockOpen: number;
  predictedHigh: number;
  predictedLow: number;
  predictionSource: 'historical' | 'atr';
  daysUsed: number;
  spot: number;
}

export interface PairTraderDeps {
  ws: DerivWS;
  cfg: () => HiLoConfig;
  registerContractId(id: number): void;
  unregisterContractId(id: number): void;
}

function formatBarrier(price: number, digits: number): string {
  // Deriv expects a string barrier. Use fixed digits matching the symbol's
  // pip precision to avoid "invalid barrier" errors.
  return price.toFixed(Math.max(0, Math.min(digits, 8)));
}

/**
 * Owns the two-leg state for the current block: opens HIGHER + LOWER at
 * block-start, subscribes to their P/L streams, and triggers an early sell
 * when the summed live P/L reaches cfg.blockTp. Leg(s) that can't be sold
 * intrabar ride to expiry — their realised P/L merges into the session on
 * block close.
 */
export class PairTrader {
  private pipDigits = 2;
  private selling = false;
  private constraints: Record<string, ContractConstraints> = {};

  constructor(private deps: PairTraderDeps) {}

  setPipDigits(d: number): void {
    if (d > 0 && d < 12) this.pipDigits = d;
  }

  setConstraints(c: Record<string, ContractConstraints>): void {
    this.constraints = c;
  }

  /**
   * Fire the HIGHER and LOWER contracts in parallel. Creates the PairState
   * *before* the network calls so contract events that race back to us have
   * a target to land in.
   */
  async openPair(p: OpenPairParams): Promise<void> {
    const cfg = this.deps.cfg();
    const nowSec = Date.now() / 1000;
    const durationSec = Math.max(15, Math.floor(p.blockEnd - nowSec));
    if (durationSec < 15) {
      useStore.getState().append('warn', `block ${timeHM(p.blockStart)} — only ${durationSec}s left, skipping pair`);
      return;
    }

    // Initial skeleton — legs filled in as buys return.
    const pair: PairState = {
      blockStart: p.blockStart,
      blockEnd: p.blockEnd,
      blockOpen: p.blockOpen,
      predictedHigh: p.predictedHigh,
      predictedLow: p.predictedLow,
      predictionSource: p.predictionSource,
      daysUsed: p.daysUsed,
      higher: null,
      lower: null,
      tpTriggered: false,
    };
    useStore.getState().setPair(pair);
    this.selling = false;

    useStore.getState().append(
      'block',
      `new block ${timeHM(p.blockStart)}–${timeHM(p.blockEnd)}  open=${p.blockOpen.toFixed(this.pipDigits)}  predH=${p.predictedHigh.toFixed(this.pipDigits)}  predL=${p.predictedLow.toFixed(this.pipDigits)}  [${cfg.mode} · ${p.predictionSource}${p.daysUsed ? ` ${p.daysUsed}d` : ''}]`,
    );

    // Barrier sanity: the upper leg's barrier must be > spot and the lower
    // leg's barrier must be < spot. For HIGHER/LOWER (breakout) and NOTOUCH
    // (stay-in-range) alike, putting a barrier on the wrong side of spot
    // makes the proposal degenerate (payout ≈ stake for HIGHER/LOWER, or
    // instantly lost for NOTOUCH).
    const spot = p.spot;
    const tasks: Array<Promise<void>> = [];
    if (p.predictedHigh > spot) {
      tasks.push(this.openLeg('HIGHER', p.predictedHigh, durationSec));
    } else {
      useStore.getState().append('warn', `upper leg skipped — predH ${p.predictedHigh.toFixed(this.pipDigits)} <= spot ${spot.toFixed(this.pipDigits)}`);
    }
    if (p.predictedLow < spot) {
      tasks.push(this.openLeg('LOWER', p.predictedLow, durationSec));
    } else {
      useStore.getState().append('warn', `lower leg skipped — predL ${p.predictedLow.toFixed(this.pipDigits)} >= spot ${spot.toFixed(this.pipDigits)}`);
    }
    await Promise.allSettled(tasks);
  }

  private async openLeg(side: LegSide, barrier: number, durationSec: number): Promise<void> {
    const cfg = this.deps.cfg();
    const key = side === 'HIGHER' ? 'higher' : 'lower';
    const barrierStr = formatBarrier(barrier, this.pipDigits);
    const contractType: HiLoContractType = contractTypeFor(cfg.mode, side);
    const label = legDisplayName(cfg.mode, side);

    // Pick the duration unit by contract type:
    //   HIGHER / LOWER on synthetics accept second-resolution — pass through.
    //   NOTOUCH on Deriv synthetics is only offered at minute resolution AND
    //     the strategy is block-anchored, so partial-block NOTOUCH trades
    //     don't match the intent. We only open NOTOUCH legs if the full
    //     block duration is still ahead (fresh boundary). Mid-block joins
    //     skip this block and wait for the next one.
    const blockSec = cfg.blockMinutes * 60;
    let durationValue: number;
    let durationUnit: 's' | 'm';
    if (contractType === 'NOTOUCH') {
      durationUnit = 'm';
      // Accept up to `startupSlackSec` off the top so clock jitter on the
      // boundary (BlockClock fires ~50ms late) doesn't lose the full block.
      const startupSlackSec = 2;
      if (durationSec < blockSec - startupSlackSec) {
        useStore.getState().append(
          'warn',
          `${label} skipped — ${durationSec}s left vs full block ${blockSec}s; NOTOUCH only trades fresh blocks`,
        );
        return;
      }
      durationValue = cfg.blockMinutes;
    } else {
      durationUnit = 's';
      durationValue = durationSec;
    }

    // Cross-check against the contracts_for bounds (both are in seconds).
    const effectiveSec = durationUnit === 'm' ? durationValue * 60 : durationValue;
    const cst = this.constraints[contractType];
    const minD = cst?.minDurationSec;
    const maxD = cst?.maxDurationSec;
    if (minD !== undefined && effectiveSec < minD) {
      useStore.getState().append(
        'warn',
        `${label} skipped — ${effectiveSec}s < ${contractType} min ${minD}s`,
      );
      return;
    }
    if (maxD !== undefined && effectiveSec > maxD) {
      useStore.getState().append(
        'warn',
        `${label} ${effectiveSec}s > ${contractType} max ${maxD}s — capping`,
      );
      durationValue = durationUnit === 'm' ? Math.floor(maxD / 60) : maxD;
    }

    const durSpec = `${durationValue}${durationUnit}`;

    if (cfg.dryRun) {
      const fakeId = -Math.floor(Math.random() * 1_000_000_000);
      const leg: LegState = {
        side,
        contractId: fakeId,
        stake: cfg.stake,
        payout: cfg.stake * 1.95,
        buyPrice: cfg.stake,
        barrier,
        liveProfit: 0,
        status: 'open',
        resolved: false,
      };
      this.injectLeg(key, leg);
      useStore.getState().append('trade-open', `DRY ${label} stake=${cfg.stake.toFixed(2)} barrier=${barrierStr} dur=${durSpec} id=${fakeId}`);
      return;
    }

    try {
      const res = await this.deps.ws.buyContract({
        amount: cfg.stake,
        currency: cfg.currency,
        contract_type: contractType,
        duration: durationValue,
        duration_unit: durationUnit,
        symbol: cfg.symbol,
        barrier: barrierStr,
      });
      const leg: LegState = {
        side,
        contractId: res.contract_id,
        stake: res.buy_price,
        payout: res.payout,
        buyPrice: res.buy_price,
        barrier,
        liveProfit: 0,
        status: 'open',
        resolved: false,
      };
      this.deps.registerContractId(res.contract_id);
      this.injectLeg(key, leg);
      useStore.getState().append(
        'trade-open',
        `${label} stake=${res.buy_price.toFixed(2)} payout=${res.payout.toFixed(2)} barrier=${barrierStr} dur=${durSpec} id=${res.contract_id}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useStore.getState().append(
        'error',
        `${label} buy failed (${contractType} dur=${durSpec} barrier=${barrierStr}): ${msg}`,
      );
    }
  }

  private injectLeg(key: 'higher' | 'lower', leg: LegState): void {
    const st = useStore.getState();
    const pair = st.currentPair;
    if (!pair) return;
    st.setPair({ ...pair, [key]: leg });
  }

  /**
   * Call from the global contract-update stream. Routes to the matching leg
   * and re-evaluates the pair TP.
   */
  onContractUpdate(u: ContractUpdate): void {
    const st = useStore.getState();
    const pair = st.currentPair;
    if (!pair) return;
    const side: LegSide | null =
      pair.higher?.contractId === u.contract_id ? 'HIGHER'
      : pair.lower?.contractId === u.contract_id ? 'LOWER'
      : null;
    if (!side) return;

    const patch: Partial<LegState> = {
      liveProfit: u.profit ?? 0,
      bidPrice: u.bid_price,
      isValidToSell: u.is_valid_to_sell,
    };
    const status = u.status;
    if (status === 'open' || status === 'won' || status === 'lost' || status === 'sold' || status === 'cancelled') {
      patch.status = status;
      if (status !== 'open') patch.resolved = true;
    }
    st.updateLeg(side, patch);

    // Re-read the merged pair before deciding TP.
    const updated = useStore.getState().currentPair;
    if (updated) this.maybeTriggerTp(updated);

    // When a leg resolves (naturally or by sell), drop its contract id from
    // the global registration so reconnect logic doesn't try to resubscribe.
    if (patch.resolved && u.contract_id) {
      this.deps.unregisterContractId(u.contract_id);
    }
  }

  private maybeTriggerTp(pair: PairState): void {
    if (pair.tpTriggered || this.selling) return;
    const cfg = this.deps.cfg();
    const profit = (pair.higher?.liveProfit ?? 0) + (pair.lower?.liveProfit ?? 0);
    if (profit < cfg.blockTp) return;

    this.selling = true;
    useStore.getState().markTpTriggered();
    useStore.getState().append('sell', `pair P/L +${profit.toFixed(2)} >= tp ${cfg.blockTp.toFixed(2)} — selling sellable legs`);
    void this.sellSellableLegs(pair);
  }

  private async sellSellableLegs(pair: PairState): Promise<void> {
    const cfg = this.deps.cfg();
    const jobs: Array<Promise<void>> = [];
    for (const leg of [pair.higher, pair.lower]) {
      if (!leg || leg.resolved) continue;
      const label = legDisplayName(cfg.mode, leg.side);
      if (cfg.dryRun) {
        // Simulate an immediate sell at the current live profit.
        useStore.getState().updateLeg(leg.side, {
          status: 'sold',
          resolved: true,
        });
        useStore.getState().append('sell', `DRY ${label} id=${leg.contractId} sold @ +${leg.liveProfit.toFixed(2)}`);
        continue;
      }
      if (leg.isValidToSell !== 1) {
        useStore.getState().append('warn', `${label} id=${leg.contractId} not sellable right now — riding to expiry`);
        continue;
      }
      jobs.push(this.sellOne(leg, label));
    }
    await Promise.allSettled(jobs);
  }

  private async sellOne(leg: LegState, label: string): Promise<void> {
    try {
      const res = await this.deps.ws.sellContract(leg.contractId, 0);
      useStore.getState().append('sell', `${label} id=${leg.contractId} sold_for=${res.sold_for.toFixed(2)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useStore.getState().append('error', `${label} id=${leg.contractId} sell failed: ${msg}`);
    }
  }

  /**
   * Called from BlockClock's 'block-end' handler. For the dry-run path, we
   * need to resolve any still-open legs against the last known spot since
   * there's no server event to do it for us.
   */
  realiseAtBlockEnd(spot: number): PairState | null {
    const cfg = this.deps.cfg();
    const st = useStore.getState();
    const pair = st.currentPair;
    if (!pair) return null;

    if (cfg.dryRun) {
      for (const leg of [pair.higher, pair.lower]) {
        if (!leg || leg.resolved) continue;
        // Both modes are stay-in-range bets, so the dry-run outcome rule is
        // the SAME across modes:
        //   upper leg (barrier=predH): wins if exit spot stays below predH
        //   lower leg (barrier=predL): wins if exit spot stays above predL
        // NOTOUCH would technically also require no intrabar touch, but we
        // can only observe the final spot in dry-run — treat it as a proxy.
        const won = leg.side === 'HIGHER' ? spot < leg.barrier : spot > leg.barrier;
        const profit = won ? leg.payout - leg.stake : -leg.stake;
        const label = legDisplayName(cfg.mode, leg.side);
        st.updateLeg(leg.side, {
          status: won ? 'won' : 'lost',
          resolved: true,
          liveProfit: profit,
        });
        st.append('trade-close', `DRY ${won ? 'WIN' : 'LOSS'} ${label} ${profit >= 0 ? '+' : ''}${profit.toFixed(2)} exit=${spot.toFixed(this.pipDigits)} barrier=${leg.barrier.toFixed(this.pipDigits)}`);
      }
    }

    const finalPair = useStore.getState().currentPair;
    if (!finalPair) return null;
    const realised = legProfit(finalPair.higher) + legProfit(finalPair.lower);
    useStore.getState().addSessionResult(realised);
    const sessAfter = useStore.getState().session.totalProfit;
    useStore.getState().append(
      'trade-close',
      `block ${timeHM(finalPair.blockStart)} realised: ${realised >= 0 ? '+' : ''}${realised.toFixed(2)} ` +
        `(H ${legProfit(finalPair.higher).toFixed(2)} / L ${legProfit(finalPair.lower).toFixed(2)}) ` +
        `sess ${sessAfter >= 0 ? '+' : ''}${sessAfter.toFixed(2)}`,
    );
    return useStore.getState().finalisePair();
  }
}

function legProfit(leg: LegState | null): number {
  if (!leg) return 0;
  return leg.liveProfit ?? 0;
}

function timeHM(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return d.toISOString().slice(11, 16) + 'Z';
}
