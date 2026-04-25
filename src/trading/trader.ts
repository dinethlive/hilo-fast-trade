import { BlockClock, type BlockWindow } from '../engine/blockClock';
import { predictRange, type RangePrediction } from '../engine/rangePredictor';
import { DerivWS } from '../services/derivWS';
import type { Candle, ContractUpdate, OhlcPayload, TickPayload } from '../services/derivWS/types';
import { DEFAULT_APP_ID } from '../constants/api';
import { useStore } from '../state/store';
import { blockSeconds, type HiLoConfig } from './config';
import { PairTrader } from './pairTrader';

const HISTORY_BAR_TARGET_PER_DAY = (blockSec: number) => Math.ceil(86_400 / blockSec);

export class Trader {
  private ws: DerivWS;
  private clock: BlockClock;
  private pair: PairTrader;
  private candles: Candle[] = [];
  private openContractIds = new Set<number>();
  private stopped = false;
  private offFns: Array<() => void> = [];

  constructor(private cfg: HiLoConfig) {
    this.ws = new DerivWS({
      appId: cfg.appId || DEFAULT_APP_ID,
      token: cfg.token,
      accountId: cfg.accountId,
      preferAccountType: cfg.preferAccountType,
    });
    this.clock = new BlockClock(blockSeconds(cfg));
    this.pair = new PairTrader({
      ws: this.ws,
      cfg: () => this.cfg,
      registerContractId: (id) => this.openContractIds.add(id),
      unregisterContractId: (id) => this.openContractIds.delete(id),
    });
  }

  async start(): Promise<void> {
    const st = useStore.getState();
    st.setStatus('connecting');
    st.append('system', `HiLo-Fast starting — symbol=${this.cfg.symbol} block=${this.cfg.blockMinutes}m stake=${this.cfg.stake} blockTP=${this.cfg.blockTp}${this.cfg.dryRun ? ' [DRY-RUN]' : ''}`);

    this.wireWsEvents();

    if (this.cfg.dryRun) {
      st.append('info', 'dry-run — skipping Deriv auth, using synthetic candles');
      await this.bootDryRun();
    } else {
      const account = await this.ws.connect();
      st.setAccount({
        loginid: account.account_id,
        type: account.account_type,
        balance: account.balance,
        currency: account.currency,
      });
      // Currency: use the account's currency if the caller didn't override.
      if (!this.cfg.currency) this.cfg.currency = account.currency || 'USD';
      st.append('system', `connected — ${account.account_type} ${account.account_id} ${account.currency} ${account.balance.toFixed(2)}`);

      if (!this.cfg.skipContractCheck) {
        await this.verifySymbolSupports();
      }
      await this.ws.subscribeTicks(this.cfg.symbol);
      await this.loadHistoricalCandles();
      await this.subscribeLiveCandles();
    }

    // Block clock — fires 'block-end' then 'block-start' on every boundary.
    this.offFns.push(this.clock.on('block-end', (w) => this.onBlockEnd(w)));
    this.offFns.push(this.clock.on('block-start', (w) => this.onBlockStart(w)));
    this.clock.start();

    // Strategy is block-anchored: the prediction is locked at the first bar
    // of a block and the contracts are sized to expire on the block end.
    // Mid-block entries mean the prediction is already stale (spot has
    // drifted since blockOpen) and the duration is a weird partial. So we
    // deliberately SKIP the in-progress block and wait for the next fresh
    // boundary. Applies to both HIGHER/LOWER and NOTOUCH modes.
    const now = this.clock.currentWindow();
    const waitSec = Math.max(0, Math.ceil(now.end - Date.now() / 1000));
    const nextHM = new Date(now.end * 1000).toISOString().slice(11, 16) + 'Z';
    st.append('info', `waiting for next block at ${nextHM} (~${waitSec}s)`);

    st.setStatus('running');
  }

  stop(): void {
    this.stopped = true;
    this.clock.stop();
    for (const off of this.offFns.splice(0)) {
      try { off(); } catch { /* noop */ }
    }
    this.ws.disconnect();
    useStore.getState().setStatus('idle');
  }

  /**
   * Hot-patch the running config. Only a subset of fields can change mid-run:
   * the "soft" fields that are read at block-evaluation time. Hard fields
   * (symbol, blockMinutes, range-* params, auth) require a /stop + /start.
   */
  patchConfig(patch: Partial<HiLoConfig>): void {
    const soft: Array<keyof HiLoConfig> = [
      'stake',
      'blockTp',
      'sessionTp',
      'sessionSl',
      'currency',
    ];
    const applied: Partial<HiLoConfig> = {};
    const rejected: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (soft.includes(k as keyof HiLoConfig)) {
        (applied as Record<string, unknown>)[k] = v;
      } else if (v !== (this.cfg as unknown as Record<string, unknown>)[k]) {
        rejected.push(k);
      }
    }
    if (Object.keys(applied).length) {
      Object.assign(this.cfg, applied);
      useStore.getState().setConfig({ ...this.cfg });
    }
    if (rejected.length) {
      throw new Error(
        `cannot change ${rejected.join(', ')} while running — /stop first`,
      );
    }
  }

  getConfig(): Readonly<HiLoConfig> {
    return this.cfg;
  }

  private wireWsEvents(): void {
    this.offFns.push(this.ws.on('tick', (t) => this.onTick(t)));
    this.offFns.push(this.ws.on('ohlc', (o) => this.onOhlc(o)));
    this.offFns.push(this.ws.on('contract', (c) => this.onContract(c)));
    this.offFns.push(this.ws.on('balance', (b) => useStore.getState().setAccount({ balance: b.balance, currency: b.currency })));
    this.offFns.push(this.ws.on('status', (s) => useStore.getState().append('status', `ws ${s}`)));
    this.offFns.push(this.ws.on('error', (msg) => useStore.getState().append('error', msg)));
    this.offFns.push(this.ws.on('info', (msg) => useStore.getState().append('info', msg)));
    this.offFns.push(this.ws.on('reconnect', () => this.onReconnect()));
  }

  private async verifySymbolSupports(): Promise<void> {
    const cf = await this.ws.getContractsFor(this.cfg.symbol);
    const needed = this.cfg.mode === 'no-touch' ? ['NOTOUCH'] : ['HIGHER', 'LOWER'];
    const missing = needed.filter((t) => !cf.contract_types.has(t));
    if (missing.length) {
      const have = [...cf.contract_types].sort().join(', ') || '(none)';
      throw new Error(
        `symbol ${this.cfg.symbol} does not support ${missing.join(' & ')} in mode=${this.cfg.mode}. ` +
          `contracts_for returned: ${have}. Pick a symbol that supports ${needed.join(' & ')}.`,
      );
    }
    // Infer display digits from pip_size (e.g. 0.01 -> 2 digits).
    const pip = cf.pip_size;
    if (pip > 0 && pip < 1) {
      const digits = Math.round(-Math.log10(pip));
      this.pair.setPipDigits(digits);
    }
    // Hand duration bounds to the pair trader so it can clamp/skip per leg.
    this.pair.setConstraints(cf.constraints);
    for (const t of needed) {
      const c = cf.constraints[t];
      if (c?.minDurationSec !== undefined || c?.maxDurationSec !== undefined) {
        useStore.getState().append(
          'info',
          `${t}: duration ${c.minDurationSec ?? '?'}s..${c.maxDurationSec ?? '?'}s` +
            (c.barrierCategory ? ` · ${c.barrierCategory}` : ''),
        );
      }
    }
  }

  private async loadHistoricalCandles(): Promise<void> {
    const blockSec = blockSeconds(this.cfg);
    // Grab enough history to cover lookbackDays worth of same-TOD bars, plus a
    // safety margin for the ATR fallback. Deriv caps candle count at 5000.
    const bars = Math.min(5000, HISTORY_BAR_TARGET_PER_DAY(blockSec) * (this.cfg.lookbackDays + 2));
    try {
      this.candles = await this.ws.getCandles(this.cfg.symbol, blockSec, bars, false);
      useStore.getState().append('info', `loaded ${this.candles.length} candles @ ${blockSec}s granularity`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useStore.getState().append('warn', `candle history fetch failed: ${msg} (continuing — ATR fallback unavailable)`);
    }
  }

  private async subscribeLiveCandles(): Promise<void> {
    try {
      await this.ws.getCandles(this.cfg.symbol, blockSeconds(this.cfg), 1, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useStore.getState().append('warn', `candle subscribe failed: ${msg}`);
    }
  }

  private async bootDryRun(): Promise<void> {
    // Synthesise a plausible candle series so the predictor has something to
    // chew on. This is ONLY for dry-run with no network access — prefer live
    // data whenever possible.
    const blockSec = blockSeconds(this.cfg);
    const now = Math.floor(Date.now() / 1000);
    const start = Math.floor(now / blockSec) * blockSec - blockSec * HISTORY_BAR_TARGET_PER_DAY(blockSec) * (this.cfg.lookbackDays + 2);
    const n = Math.min(5000, HISTORY_BAR_TARGET_PER_DAY(blockSec) * (this.cfg.lookbackDays + 2));
    let price = 1000;
    const out: Candle[] = [];
    for (let i = 0; i < n; i++) {
      const open = price;
      const drift = (Math.random() - 0.5) * 0.4;
      const range = 0.3 + Math.random() * 0.7;
      const high = open + range;
      const low = open - range;
      const close = open + drift + (Math.random() - 0.5) * range;
      out.push({ epoch: start + i * blockSec, open, high, low, close });
      price = close;
    }
    this.candles = out;
    useStore.getState().setSpot(price);
    useStore.getState().setAccount({ type: 'demo', balance: 10000, currency: 'USD' });
    // Currency default for proposal params even though we don't use them.
    if (!this.cfg.currency) this.cfg.currency = 'USD';
    useStore.getState().append('info', `dry-run synthetic candles: ${out.length} @ ${blockSec}s`);
  }

  private onTick(t: TickPayload): void {
    if (t.symbol !== this.cfg.symbol) return;
    useStore.getState().setSpot(t.quote);
  }

  private onOhlc(o: OhlcPayload): void {
    if (o.symbol !== this.cfg.symbol) return;
    // Append or update the last candle. Deriv streams partial candles while
    // they're live and a final update at close.
    const last = this.candles[this.candles.length - 1];
    const bar: Candle = { epoch: o.epoch, open: o.open, high: o.high, low: o.low, close: o.close };
    if (last && last.epoch === bar.epoch) {
      this.candles[this.candles.length - 1] = bar;
    } else {
      this.candles.push(bar);
      if (this.candles.length > 6000) this.candles.splice(0, this.candles.length - 5000);
    }
  }

  private onContract(u: ContractUpdate): void {
    this.pair.onContractUpdate(u);
    this.evaluateSessionGuards();
  }

  private onReconnect(): void {
    const st = useStore.getState();
    st.append('info', 'resubscribing after reconnect');
    void (async () => {
      try {
        await this.ws.subscribeTicks(this.cfg.symbol);
        await this.subscribeLiveCandles();
        for (const id of this.openContractIds) {
          try { await this.ws.subscribeOpenContract(id); } catch { /* ignore */ }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        st.append('error', `resubscribe failed: ${msg}`);
      }
    })();
  }

  private async onBlockStart(w: BlockWindow): Promise<void> {
    if (this.stopped) return;
    if (useStore.getState().halted) return;

    const spot = useStore.getState().lastSpot ?? (this.candles[this.candles.length - 1]?.close ?? 0);
    const granularity = blockSeconds(this.cfg);

    const pred: RangePrediction | null = predictRange(this.candles, w.start, w.end, spot, {
      mode: this.cfg.rangeMode,
      lookbackDays: this.cfg.lookbackDays,
      atrBars: this.cfg.atrBars,
      k: this.cfg.rangeK,
      granularitySec: granularity,
    });
    if (!pred) {
      useStore.getState().append('warn', `block ${new Date(w.start * 1000).toISOString().slice(11, 16)}Z — no prediction (need more history) — skipping`);
      return;
    }

    await this.pair.openPair({
      blockStart: w.start,
      blockEnd: w.end,
      blockOpen: pred.blockOpen,
      predictedHigh: pred.predictedHigh,
      predictedLow: pred.predictedLow,
      predictionSource: pred.source,
      daysUsed: pred.daysUsed,
      spot,
    });
  }

  private onBlockEnd(w: BlockWindow): void {
    const spot = useStore.getState().lastSpot ?? (this.candles[this.candles.length - 1]?.close ?? 0);
    this.pair.realiseAtBlockEnd(spot);
    this.evaluateSessionGuards();
  }

  private evaluateSessionGuards(): void {
    const st = useStore.getState();
    if (st.halted) return;
    const p = st.session.totalProfit;
    if (this.cfg.sessionTp !== undefined && p >= this.cfg.sessionTp) {
      st.halt(`session TP hit: ${p.toFixed(2)} >= ${this.cfg.sessionTp}`);
      st.append('system', `halted — session take-profit reached (${p.toFixed(2)})`);
    } else if (this.cfg.sessionSl !== undefined && p <= -this.cfg.sessionSl) {
      st.halt(`session SL hit: ${p.toFixed(2)} <= -${this.cfg.sessionSl}`);
      st.append('system', `halted — session stop-loss reached (${p.toFixed(2)})`);
    }
  }
}
