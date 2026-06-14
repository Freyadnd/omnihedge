import type { PredictionEvent } from './types';

const GAMMA_API = 'https://gamma-api.polymarket.com';

interface GammaNestedMarket {
  id: string;
  conditionId: string;
  question: string;
  endDate: string | null;
  endDateIso?: string | null;
  volume: string | number;
  volumeNum?: number;
  liquidityNum?: number;
  outcomePrices: string;
  outcomes: string;
  active: boolean;
  closed: boolean;
}

interface GammaEvent {
  id: string;
  title: string;
  endDate: string | null;
  volume: string | number;
  active: boolean;
  closed: boolean;
  markets: GammaNestedMarket[];
  tags?: Array<{ id: number; label: string; slug: string }>;
}

export interface FetchOptions {
  /** Max events to return after filtering. Default: 400 */
  limit?: number;
  /** Minimum USD volume to include. Default: 5000 */
  minVolume?: number;
  /** How many parent events to request per page. Default: 100 */
  pageSize?: number;
  /**
   * Only return markets with yes_price inside this open range.
   * Markets outside the range are near-resolved (no hedge value) and bloat the LLM context.
   * Default: [0.05, 0.95]
   */
  priceRange?: [number, number];
}

// Keywords that make a market potentially relevant to a crypto/macro portfolio.
// Used by selectForAgent() to prioritise relevant events.
const RELEVANT_KEYWORDS = [
  'fed', 'rate', 'cut', 'hike', 'inflation', 'fomc',
  'bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'defi',
  'stablecoin', 'usdc', 'usdt', 'sec', 'regulation',
  'recession', 'gdp', 'cpi', 'yield', 'treasury',
  'hype', 'hyperliquid', 'solana', 'sol',
];

/**
 * Select the best subset of events to send to the LLM agent.
 * Priority: keyword-relevant events first, then top-volume to fill quota.
 * Caps at maxEvents to stay within model token limits.
 */
export function selectForAgent(
  events: PredictionEvent[],
  maxEvents = 30
): PredictionEvent[] {
  const relevant = events.filter((e) =>
    RELEVANT_KEYWORDS.some((k) => e.title.toLowerCase().includes(k))
  );
  const rest = events.filter(
    (e) => !RELEVANT_KEYWORDS.some((k) => e.title.toLowerCase().includes(k))
  );
  return [...relevant, ...rest].slice(0, maxEvents);
}

/**
 * Fetch active binary prediction markets from Polymarket, sourced via the
 * high-volume events endpoint. Sorted by volume desc after filtering.
 */
export async function fetchPolymarketEvents(
  options: FetchOptions = {}
): Promise<PredictionEvent[]> {
  const { limit = 400, minVolume = 5000, pageSize = 100, priceRange = [0.05, 0.95] } = options;
  const [priceMin, priceMax] = priceRange;

  const url = new URL(`${GAMMA_API}/events`);
  url.searchParams.set('active', 'true');
  url.searchParams.set('closed', 'false');
  url.searchParams.set('limit', String(pageSize));
  url.searchParams.set('order', 'volume');
  url.searchParams.set('ascending', 'false');

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Polymarket API error: ${res.status} ${res.statusText}`);
  }

  const raw: unknown = await res.json();
  const events = normalizeEventsResponse(raw);

  const results: PredictionEvent[] = [];

  for (const event of events) {
    for (const market of event.markets ?? []) {
      if (!isBinaryMarket(market)) continue;

      const vol = parseVolume(market.volumeNum ?? market.volume);
      if (vol < minVolume) continue;
      if (market.closed || !market.active) continue;

      const resolutionDate = resolveDate(market.endDateIso ?? market.endDate);
      if (!resolutionDate) continue;

      const event = toEvent(market, vol, resolutionDate);

      // Pre-filter near-resolved markets — outside priceRange they have no hedge value
      // and only waste LLM context tokens.
      if (event.yes_price <= priceMin || event.yes_price >= priceMax) continue;

      results.push(event);
    }
  }

  // Sort by volume desc and cap
  return results
    .sort((a, b) => b.volume_usd - a.volume_usd)
    .slice(0, limit);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeEventsResponse(raw: unknown): GammaEvent[] {
  if (Array.isArray(raw)) return raw as GammaEvent[];
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj['events'])) return obj['events'] as GammaEvent[];
    if (Array.isArray(obj['data'])) return obj['data'] as GammaEvent[];
  }
  throw new Error('Polymarket: unexpected response shape');
}

function isBinaryMarket(m: GammaNestedMarket): boolean {
  try {
    const outcomes: string[] = JSON.parse(m.outcomes);
    return (
      outcomes.length === 2 &&
      outcomes.some((o) => o.toLowerCase() === 'yes') &&
      outcomes.some((o) => o.toLowerCase() === 'no')
    );
  } catch {
    return false;
  }
}

function parseVolume(v: string | number | undefined): number {
  if (v === undefined || v === null) return 0;
  return typeof v === 'number' ? v : parseFloat(v) || 0;
}

function resolveDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // endDateIso: "2026-06-16", endDate: "2026-06-16T03:59:00Z"
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function toEvent(
  m: GammaNestedMarket,
  volume: number,
  resolutionDate: string
): PredictionEvent {
  let yesPrice = 0.5;

  try {
    const prices: number[] = JSON.parse(m.outcomePrices).map(Number);
    const outcomes: string[] = JSON.parse(m.outcomes);
    const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === 'yes');
    if (yesIdx !== -1 && prices[yesIdx] !== undefined) {
      yesPrice = prices[yesIdx];
    }
  } catch {
    // keep default 0.5
  }

  return {
    event_id: m.conditionId,
    title: m.question,
    volume_usd: volume,
    yes_price: yesPrice,
    no_price: parseFloat((1 - yesPrice).toFixed(4)),
    resolution_date: resolutionDate,
  };
}
