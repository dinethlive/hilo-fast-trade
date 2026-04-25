export const DERIV_REST_BASE = 'https://api.derivws.com/trading/v1/options';
export const DEFAULT_APP_ID = '331jnczBJfg53USa1NUZm';

export const PING_INTERVAL_MS = 30_000;

// Session rollover: Deriv caps an authenticated WS session around ~1h. Mint a
// fresh OTP and swap sockets before the server drops us so trading never pauses.
export const SESSION_ROLLOVER_MS = 50 * 60 * 1_000;

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const RECONNECT_MAX_ATTEMPTS = 10;

// Defaults tuned for 3-minute time-block trading on 1HZ synthetic indices.
export const DEFAULT_SYMBOL = '1HZ100V';
export const DEFAULT_STAKE = 1.0;
export const DEFAULT_BLOCK_MINUTES = 3;
export const DEFAULT_BLOCK_TP = 1.5;
export const DEFAULT_LOOKBACK_DAYS = 20;
export const DEFAULT_ATR_BARS = 14;
export const DEFAULT_RANGE_K = 1.0;
export const DEFAULT_RANGE_MODE: 'hybrid' | 'historical' | 'atr' = 'hybrid';
export const DEFAULT_TRADE_MODE: 'higher-lower' | 'no-touch' = 'higher-lower';
