import {
  DEFAULT_APP_ID,
  DEFAULT_ATR_BARS,
  DEFAULT_BLOCK_MINUTES,
  DEFAULT_BLOCK_TP,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_RANGE_K,
  DEFAULT_RANGE_MODE,
  DEFAULT_STAKE,
  DEFAULT_SYMBOL,
  DEFAULT_TRADE_MODE,
} from '../constants/api';
import type { RangeMode } from '../engine/rangePredictor';
import type { HiLoConfig, TradeMode } from '../trading/config';

export interface ParsedArgs {
  cfg: HiLoConfig;
  help: boolean;
  version: boolean;
}

const HELP_TEXT = `
HiLo-Fast — time-block HIGHER/LOWER CLI for Deriv

Usage:
  bun src/index.ts [flags]

Required:
  --token <t>               Deriv API / OAuth token (or env DERIV_TOKEN)

Market:
  --symbol <sym>            underlying symbol (default ${DEFAULT_SYMBOL})
  --stake <usd>             per-leg stake (default ${DEFAULT_STAKE})
  --currency <c>            currency override (default: account currency)

Block grid:
  --block-minutes <n>       block size in minutes (default ${DEFAULT_BLOCK_MINUTES})
  --block-tp <usd>          sell pair when combined live P/L >= this (default ${DEFAULT_BLOCK_TP})
  --session-tp <usd>        halt when session P/L >= this (optional)
  --session-sl <usd>        halt when session P/L <= -this (optional)

Trade primitive:
  --mode <higher-lower|no-touch>   contract type per leg (default ${DEFAULT_TRADE_MODE})

Prediction:
  --range-mode <m>          hybrid | historical | atr (default ${DEFAULT_RANGE_MODE})
  --lookback-days <n>       same-TOD lookback (default ${DEFAULT_LOOKBACK_DAYS})
  --atr-bars <n>            ATR window for fallback (default ${DEFAULT_ATR_BARS})
  --range-k <x>             extension multiplier (default ${DEFAULT_RANGE_K})

Account:
  --account-id <id>         pin to a specific Deriv account
  --prefer <demo|real>      prefer demo or real when multiple active (default demo)

Modes:
  --dry-run                 synthetic candles, simulated buys/sells — no network trades
  --skip-contract-check     skip contracts_for verification (debug only)
  --no-ui                   plain console output instead of the Ink TUI
  --app-id <id>             Deriv app id (default bundled)

Misc:
  --help                    this message
  --version                 print version
`;

function usage(): string {
  return HELP_TEXT.trim();
}

function err(msg: string): never {
  process.stderr.write(`hilo-fast: ${msg}\n\n${usage()}\n`);
  process.exit(2);
}

function numArg(v: string | undefined, name: string): number {
  if (v === undefined) err(`--${name} requires a value`);
  const n = Number(v);
  if (!Number.isFinite(n)) err(`--${name} must be a number (got '${v}')`);
  return n;
}

function str(v: string | undefined, name: string): string {
  if (v === undefined || v === '') err(`--${name} requires a value`);
  return v;
}

function rangeMode(v: string | undefined): RangeMode {
  if (v === undefined) err(`--range-mode requires a value`);
  const lc = v.toLowerCase();
  if (lc === 'h' || lc === 'hybrid') return 'hybrid';
  if (lc === 'hist' || lc === 'historical') return 'historical';
  if (lc === 'atr') return 'atr';
  err(`--range-mode must be one of: hybrid, historical, atr (got '${v}')`);
}

function tradeMode(v: string | undefined): TradeMode {
  if (v === undefined) err(`--mode requires a value`);
  const lc = v.toLowerCase();
  if (lc === 'higher-lower' || lc === 'hl' || lc === 'higherlower') return 'higher-lower';
  if (lc === 'no-touch' || lc === 'nt' || lc === 'notouch') return 'no-touch';
  err(`--mode must be one of: higher-lower, no-touch (got '${v}')`);
}

function envTradeMode(name: string, fallback: TradeMode): TradeMode {
  const raw = process.env[name]?.toLowerCase();
  if (!raw) return fallback;
  if (raw === 'higher-lower' || raw === 'hl' || raw === 'higherlower') return 'higher-lower';
  if (raw === 'no-touch' || raw === 'nt' || raw === 'notouch') return 'no-touch';
  return fallback;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envOptNum(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function envRangeMode(name: string, fallback: RangeMode): RangeMode {
  const raw = process.env[name]?.toLowerCase();
  if (!raw) return fallback;
  if (raw === 'h' || raw === 'hybrid') return 'hybrid';
  if (raw === 'hist' || raw === 'historical') return 'historical';
  if (raw === 'atr') return 'atr';
  return fallback;
}

function envPrefer(name: string): 'demo' | 'real' {
  const raw = process.env[name]?.toLowerCase();
  return raw === 'real' ? 'real' : 'demo';
}

export function parseArgs(argv: string[]): ParsedArgs {
  const cfg: HiLoConfig = {
    appId: process.env.DERIV_APP_ID || DEFAULT_APP_ID,
    token: process.env.DERIV_TOKEN || '',
    accountId: process.env.DERIV_ACCOUNT_ID || undefined,
    preferAccountType: envPrefer('HILO_PREFER'),
    symbol: process.env.HILO_SYMBOL || DEFAULT_SYMBOL,
    currency: process.env.HILO_CURRENCY || '',
    stake: envNum('HILO_STAKE', DEFAULT_STAKE),
    blockMinutes: envNum('HILO_BLOCK_MINUTES', DEFAULT_BLOCK_MINUTES),
    mode: envTradeMode('HILO_TRADE_MODE', DEFAULT_TRADE_MODE),
    blockTp: envNum('HILO_BLOCK_TP', DEFAULT_BLOCK_TP),
    sessionTp: envOptNum('HILO_SESSION_TP'),
    sessionSl: envOptNum('HILO_SESSION_SL'),
    rangeMode: envRangeMode('HILO_RANGE_MODE', DEFAULT_RANGE_MODE),
    lookbackDays: envNum('HILO_LOOKBACK_DAYS', DEFAULT_LOOKBACK_DAYS),
    atrBars: envNum('HILO_ATR_BARS', DEFAULT_ATR_BARS),
    rangeK: envNum('HILO_RANGE_K', DEFAULT_RANGE_K),
    dryRun: false,
    skipContractCheck: false,
    noUi: false,
  };

  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const nxt = argv[i + 1];
    switch (a) {
      case '--help':
      case '-h': help = true; break;
      case '--version':
      case '-v': version = true; break;
      case '--token': cfg.token = str(nxt, 'token'); i++; break;
      case '--app-id': cfg.appId = str(nxt, 'app-id'); i++; break;
      case '--account-id': cfg.accountId = str(nxt, 'account-id'); i++; break;
      case '--prefer': {
        const v = str(nxt, 'prefer').toLowerCase();
        if (v !== 'demo' && v !== 'real') err(`--prefer must be 'demo' or 'real'`);
        cfg.preferAccountType = v;
        i++;
        break;
      }
      case '--symbol': cfg.symbol = str(nxt, 'symbol'); i++; break;
      case '--currency': cfg.currency = str(nxt, 'currency'); i++; break;
      case '--stake': cfg.stake = numArg(nxt, 'stake'); i++; break;
      case '--block-minutes': cfg.blockMinutes = numArg(nxt, 'block-minutes'); i++; break;
      case '--mode': cfg.mode = tradeMode(nxt); i++; break;
      case '--block-tp': cfg.blockTp = numArg(nxt, 'block-tp'); i++; break;
      case '--session-tp': cfg.sessionTp = numArg(nxt, 'session-tp'); i++; break;
      case '--session-sl': cfg.sessionSl = numArg(nxt, 'session-sl'); i++; break;
      case '--range-mode': cfg.rangeMode = rangeMode(nxt); i++; break;
      case '--lookback-days': cfg.lookbackDays = numArg(nxt, 'lookback-days'); i++; break;
      case '--atr-bars': cfg.atrBars = numArg(nxt, 'atr-bars'); i++; break;
      case '--range-k': cfg.rangeK = numArg(nxt, 'range-k'); i++; break;
      case '--dry-run': cfg.dryRun = true; break;
      case '--skip-contract-check': cfg.skipContractCheck = true; break;
      case '--no-ui': cfg.noUi = true; break;
      default:
        if (a.startsWith('-')) err(`unknown flag: ${a}`);
        err(`unexpected positional argument: ${a}`);
    }
  }

  return { cfg, help, version };
}

export function helpText(): string {
  return usage();
}
