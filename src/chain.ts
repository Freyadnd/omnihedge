import type { Position } from './types';

// ── Constants ─────────────────────────────────────────────────────────────────

const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';
const HL_API = 'https://api.hyperliquid.xyz/info';
const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens';

// ERC-20 function selectors (4-byte keccak prefix)
const SEL = {
  balanceOf: '70a08231', // balanceOf(address)
  symbol:    '95d89b41', // symbol()
  decimals:  '313ce567', // decimals()
} as const;

// ── Token registry ────────────────────────────────────────────────────────────
// Add your HyperEVM ERC-20 token contract addresses here.
// symbol and decimals are auto-detected from the contract if omitted.
// hlSymbol maps to the Hyperliquid price feed key (from allMids).

export interface TokenConfig {
  address: string;    // ERC-20 contract address on HyperEVM
  symbol?: string;    // Overrides on-chain symbol()
  decimals?: number;  // Overrides on-chain decimals()
  hlSymbol?: string;  // Hyperliquid price feed key (defaults to symbol)
}

// Default registry — fill in your HyperEVM contract addresses.
// Run: npx tsx src/chain.ts <wallet> to test with any address list.
export const DEFAULT_TOKENS: TokenConfig[] = [
  // Example entries (replace with real HyperEVM addresses):
  // { address: '0x...', symbol: 'WETH', decimals: 18, hlSymbol: 'ETH' },
  // { address: '0x...', symbol: 'TAI',  decimals: 18, hlSymbol: 'TAI' },
];

// ── Public API ────────────────────────────────────────────────────────────────

export interface FetchPositionsOptions {
  /** Token list to scan. Defaults to DEFAULT_TOKENS. */
  tokens?: TokenConfig[];
  /** Include native HYPE balance. Default: true */
  includeNative?: boolean;
  /** Skip positions below this USD value. Default: 1.0 */
  minUsdValue?: number;
}

/**
 * Reads ERC-20 balances for a wallet on HyperEVM and prices them via
 * Hyperliquid's spot feed (+ DexScreener fallback).
 */
export async function fetchWalletPositions(
  walletAddress: string,
  options: FetchPositionsOptions = {}
): Promise<Position[]> {
  const {
    tokens = DEFAULT_TOKENS,
    includeNative = true,
    minUsdValue = 1.0,
  } = options;

  const addr = normalizeAddress(walletAddress);

  // Fetch all prices in one round-trip
  const prices = await fetchAllMids();

  const positions: Position[] = [];

  // Native HYPE balance
  if (includeNative) {
    const rawBal = await ethGetBalance(addr);
    const bal = fromWei(rawBal, 18);
    if (bal > 0) {
      const usdPrice = prices['HYPE'] ?? 0;
      const usd = bal * usdPrice;
      if (usd >= minUsdValue) {
        positions.push({ token_symbol: 'HYPE', amount: bal, usd_value: usd, percentage_of_portfolio: 0 });
      }
    }
  }

  // ERC-20 tokens
  for (const cfg of tokens) {
    try {
      const tokenAddr = normalizeAddress(cfg.address);

      // Auto-detect symbol and decimals if not provided
      const [symbol, decimals] = await Promise.all([
        cfg.symbol ? Promise.resolve(cfg.symbol) : fetchSymbol(tokenAddr),
        cfg.decimals !== undefined ? Promise.resolve(cfg.decimals) : fetchDecimals(tokenAddr),
      ]);

      const rawBal = await ethCallBalanceOf(addr, tokenAddr);
      const bal = fromWei(rawBal, decimals);
      if (bal === 0) continue;

      // Price lookup: HL feed → DexScreener fallback
      const hlKey = cfg.hlSymbol ?? symbol;
      let usdPrice = prices[hlKey] ?? prices[symbol] ?? 0;
      if (usdPrice === 0) {
        usdPrice = await fetchDexScreenerPrice(tokenAddr);
      }

      const usd = bal * usdPrice;
      if (usd < minUsdValue) continue;

      positions.push({ token_symbol: symbol, amount: bal, usd_value: usd, percentage_of_portfolio: 0 });
    } catch (err) {
      console.warn(`[chain] Skipping ${cfg.address}: ${(err as Error).message}`);
    }
  }

  // Calculate portfolio percentages
  const total = positions.reduce((s, p) => s + p.usd_value, 0);
  for (const p of positions) {
    p.percentage_of_portfolio = total > 0 ? parseFloat(((p.usd_value / total) * 100).toFixed(2)) : 0;
  }

  return positions.sort((a, b) => b.usd_value - a.usd_value);
}

// ── Price fetching ────────────────────────────────────────────────────────────

/** Fetch all Hyperliquid spot mid prices. Returns symbol → USD price. */
export async function fetchAllMids(): Promise<Record<string, number>> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'allMids' }),
  });
  if (!res.ok) throw new Error(`HL price API: ${res.status}`);
  const raw = (await res.json()) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, parseFloat(v)])
  );
}

async function fetchDexScreenerPrice(tokenAddress: string): Promise<number> {
  try {
    const res = await fetch(`${DEXSCREENER_API}/${tokenAddress}`);
    if (!res.ok) return 0;
    const data = (await res.json()) as { pairs?: Array<{ priceUsd?: string }> };
    const pairs = data.pairs ?? [];
    if (pairs.length === 0) return 0;
    return parseFloat(pairs[0].priceUsd ?? '0') || 0;
  } catch {
    return 0;
  }
}

// ── EVM RPC helpers ───────────────────────────────────────────────────────────

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(HYPEREVM_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result as T;
}

async function ethGetBalance(address: string): Promise<bigint> {
  const hex = await rpcCall<string>('eth_getBalance', [address, 'latest']);
  return BigInt(hex);
}

async function ethCallRaw(to: string, data: string): Promise<string> {
  return rpcCall<string>('eth_call', [{ to, data }, 'latest']);
}

async function ethCallBalanceOf(wallet: string, token: string): Promise<bigint> {
  const data = `0x${SEL.balanceOf}${wallet.slice(2).padStart(64, '0')}`;
  const hex = await ethCallRaw(token, data);
  return hex === '0x' ? 0n : BigInt(hex);
}

async function fetchSymbol(token: string): Promise<string> {
  const hex = await ethCallRaw(token, `0x${SEL.symbol}`);
  return decodeAbiString(hex);
}

async function fetchDecimals(token: string): Promise<number> {
  const hex = await ethCallRaw(token, `0x${SEL.decimals}`);
  return hex === '0x' ? 18 : Number(BigInt(hex));
}

// ── ABI decoding ──────────────────────────────────────────────────────────────

function decodeAbiString(hex: string): string {
  if (!hex || hex === '0x') return 'UNKNOWN';
  try {
    // Try simple fixed string (e.g. bytes32)
    const raw = hex.slice(2);
    if (raw.length === 64) {
      const bytes = Buffer.from(raw, 'hex');
      return bytes.toString('utf8').replace(/\0/g, '').trim() || 'UNKNOWN';
    }
    // Dynamic ABI string: offset (32) + length (32) + data
    const len = parseInt(raw.slice(64, 128), 16);
    const strHex = raw.slice(128, 128 + len * 2);
    return Buffer.from(strHex, 'hex').toString('utf8').trim() || 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

function fromWei(raw: bigint, decimals: number): number {
  if (raw === 0n) return 0;
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  return Number(whole) + Number(frac) / Number(divisor);
}

function normalizeAddress(addr: string): string {
  if (!addr.startsWith('0x')) return `0x${addr}`;
  return addr.toLowerCase();
}

// ── CLI entry (for testing) ───────────────────────────────────────────────────

if (process.argv[2]) {
  const wallet = process.argv[2];
  console.log(`\n[chain] Fetching positions for ${wallet}...\n`);
  fetchWalletPositions(wallet)
    .then((positions) => {
      if (positions.length === 0) {
        console.log('No positions found (check DEFAULT_TOKENS registry).');
      } else {
        for (const p of positions) {
          console.log(
            `  ${p.token_symbol.padEnd(8)} ${p.amount.toFixed(4).padStart(14)}  $${p.usd_value.toLocaleString().padStart(14)}  ${p.percentage_of_portfolio}%`
          );
        }
      }
    })
    .catch(console.error);
}
