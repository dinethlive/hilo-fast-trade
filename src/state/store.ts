import { create } from 'zustand';
import type { HiLoConfig } from '../trading/config';

export type LogKind = 'system' | 'info' | 'warn' | 'error' | 'block' | 'trade-open' | 'trade-close' | 'sell' | 'status';

export interface LogLine {
  at: number;
  kind: LogKind;
  text: string;
}

export type LegSide = 'HIGHER' | 'LOWER';

export interface LegState {
  side: LegSide;
  contractId: number;
  stake: number;
  payout: number;
  buyPrice: number;
  barrier: number;
  liveProfit: number;
  bidPrice?: number;
  isValidToSell?: number;
  status: 'pending' | 'open' | 'won' | 'lost' | 'sold' | 'cancelled';
  resolved: boolean;
}

export interface PairState {
  blockStart: number;
  blockEnd: number;
  blockOpen: number;
  predictedHigh: number;
  predictedLow: number;
  predictionSource: 'historical' | 'atr';
  daysUsed: number;
  higher: LegState | null;
  lower: LegState | null;
  tpTriggered: boolean;
}

export interface SessionState {
  startedAt: number;
  trades: number;
  wins: number;
  losses: number;
  totalProfit: number;
  largestWin: number;
  largestLoss: number;
}

export interface AccountInfo {
  loginid?: string;
  type?: 'demo' | 'real';
  balance?: number;
  currency?: string;
}

export interface MenuItem {
  label: string;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
}

export interface MenuDefinition {
  title: string;
  items: MenuItem[];
}

export interface Store {
  config: HiLoConfig | null;
  status: 'idle' | 'connecting' | 'running' | 'halted' | 'error';
  halted: boolean;
  haltReason: string | null;
  account: AccountInfo;
  lastSpot: number | null;
  transcript: LogLine[];
  currentPair: PairState | null;
  history: PairState[];
  session: SessionState;
  menuStack: MenuDefinition[];

  setConfig(cfg: HiLoConfig): void;
  setStatus(s: Store['status']): void;
  halt(reason: string): void;
  setAccount(a: AccountInfo): void;
  setSpot(q: number): void;
  append(kind: LogKind, text: string): void;
  setPair(p: PairState): void;
  updateLeg(side: LegSide, patch: Partial<LegState>): void;
  markTpTriggered(): void;
  finalisePair(): PairState | null;
  addSessionResult(profit: number): void;
  clearTranscript(): void;
  pushMenu(m: MenuDefinition): void;
  popMenu(): void;
  clearMenus(): void;
  replaceTopMenu(m: MenuDefinition): void;
}

const MAX_TRANSCRIPT = 400;

function freshSession(): SessionState {
  return {
    startedAt: Date.now(),
    trades: 0,
    wins: 0,
    losses: 0,
    totalProfit: 0,
    largestWin: 0,
    largestLoss: 0,
  };
}

export const useStore = create<Store>((set, get) => ({
  config: null,
  status: 'idle',
  halted: false,
  haltReason: null,
  account: {},
  lastSpot: null,
  transcript: [],
  currentPair: null,
  history: [],
  session: freshSession(),
  menuStack: [],

  setConfig: (cfg) => set({ config: cfg }),
  setStatus: (s) => set({ status: s }),
  halt: (reason) => set({ halted: true, haltReason: reason, status: 'halted' }),
  setAccount: (a) => set({ account: { ...get().account, ...a } }),
  setSpot: (q) => set({ lastSpot: q }),

  append: (kind, text) =>
    set((st) => {
      const line: LogLine = { at: Date.now(), kind, text };
      const next = st.transcript.length >= MAX_TRANSCRIPT
        ? [...st.transcript.slice(-MAX_TRANSCRIPT + 1), line]
        : [...st.transcript, line];
      return { transcript: next };
    }),

  setPair: (p) => set({ currentPair: p }),

  updateLeg: (side, patch) =>
    set((st) => {
      if (!st.currentPair) return {};
      const key = side === 'HIGHER' ? 'higher' : 'lower';
      const existing = st.currentPair[key];
      if (!existing) return {};
      const merged = { ...existing, ...patch } as LegState;
      return { currentPair: { ...st.currentPair, [key]: merged } };
    }),

  markTpTriggered: () =>
    set((st) => (st.currentPair ? { currentPair: { ...st.currentPair, tpTriggered: true } } : {})),

  finalisePair: () => {
    const p = get().currentPair;
    if (!p) return null;
    set((st) => ({ currentPair: null, history: [...st.history, p].slice(-200) }));
    return p;
  },

  addSessionResult: (profit) =>
    set((st) => {
      const s = st.session;
      const won = profit > 0;
      return {
        session: {
          ...s,
          trades: s.trades + 1,
          wins: s.wins + (won ? 1 : 0),
          losses: s.losses + (won ? 0 : 1),
          totalProfit: s.totalProfit + profit,
          largestWin: profit > s.largestWin ? profit : s.largestWin,
          largestLoss: profit < s.largestLoss ? profit : s.largestLoss,
        },
      };
    }),

  clearTranscript: () => set({ transcript: [] }),

  pushMenu: (m) => set((st) => ({ menuStack: [...st.menuStack, m] })),
  popMenu: () => set((st) => ({ menuStack: st.menuStack.slice(0, -1) })),
  clearMenus: () => set({ menuStack: [] }),
  replaceTopMenu: (m) =>
    set((st) => {
      if (st.menuStack.length === 0) return { menuStack: [m] };
      return { menuStack: [...st.menuStack.slice(0, -1), m] };
    }),
}));

export type StoreApi = typeof useStore;
