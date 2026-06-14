import 'dotenv/config';
import express from 'express';
import path from 'path';
import { HedgeAgent } from './agent';
import { fetchPolymarketEvents, selectForAgent } from './polymarket';
import { fetchWalletPositions, DEFAULT_TOKENS } from './chain';
import type { AgentInput, Position } from './types';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// Demo positions used when no wallet address is provided
const DEMO_POSITIONS: Position[] = [
  { token_symbol: 'ETH', amount: 15.5, usd_value: 54250.0, percentage_of_portfolio: 65.0 },
  { token_symbol: 'TAI', amount: 5000, usd_value: 29250.0, percentage_of_portfolio: 35.0 },
];

const DEMO_NEWS = [
  'Fed chairman hints at persistent inflation in the latest speech, signaling delayed rate cuts.',
  'Ethereum layer-2 gas optimization upgrade goes live, drastically reducing mainnet congestion.',
];

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── POST /api/analyze ─────────────────────────────────────────────────────────

app.post('/api/analyze', async (req, res) => {
  const { walletAddress, news } = req.body as {
    walletAddress?: string;
    news?: string[];
  };

  try {
    // Positions
    let positions = DEMO_POSITIONS;
    if (walletAddress?.trim()) {
      const live = await fetchWalletPositions(walletAddress.trim(), {
        tokens: DEFAULT_TOKENS,
      });
      if (live.length > 0) positions = live;
    }

    // Events: fetch wide pool, then select best subset for agent token budget
    const allEvents = await fetchPolymarketEvents({ limit: 400, minVolume: 5000 });
    const events = selectForAgent(allEvents, 15);

    const input: AgentInput = {
      positions,
      events,
      news: news?.length ? news : DEMO_NEWS,
    };

    const model = process.env.OMNIHEDGE_MODEL ?? 'llama-3.3-70b-versatile';
    const agent = new HedgeAgent(undefined, model);
    const output = await agent.analyze(input);

    res.json({ ok: true, input, output });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

// ── GET /api/events ───────────────────────────────────────────────────────────

app.get('/api/events', async (_req, res) => {
  try {
    const all = await fetchPolymarketEvents({ limit: 400, minVolume: 5000 });
    const selected = selectForAgent(all, 15);
    res.json({ ok: true, total: all.length, selected: selected.length, events: selected });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n[OmniHedge] Server running at http://localhost:${PORT}`);
  console.log(`[OmniHedge] Model: ${process.env.OMNIHEDGE_MODEL ?? 'llama-3.3-70b-versatile'}\n`);
});
