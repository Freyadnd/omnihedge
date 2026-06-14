import 'dotenv/config';
import express from 'express';
import path from 'path';
import { HedgeAgent } from './agent';
import { fetchPolymarketEvents, selectForAgent } from './polymarket';
import { fetchWalletPositions, DEFAULT_TOKENS } from './chain';
import { storeBlob, fetchBlob, blobUrl } from './walrus';
import { paymentMiddlewareFromHTTPServer } from '@x402/express';
import type { AgentInput, Position, HedgeAnalysisOutput } from './types';

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
app.use(express.static(path.resolve('public')));

// ── AgentKit + x402 payment gate on /api/analyze ──────────────────────────────
// Human-backed agents (World ID verified) get FREE_USES free analyses.
// Unverified callers pay AGENTKIT_PRICE USDC per call.
// Disabled if PAYMENT_ADDRESS is not set (local dev / demo mode).
if (process.env.PAYMENT_ADDRESS) {
  import('./agentkit').then(({ x402HttpServer }) => {
    app.use(paymentMiddlewareFromHTTPServer(x402HttpServer));
    console.log('[OmniHedge] AgentKit + x402 payment gate active on POST /api/analyze');
  }).catch(err => {
    console.warn('[OmniHedge] AgentKit setup failed (non-fatal):', err.message);
  });
}

// ── Demo free-trial gate (mirrors World AgentKit logic) ───────────────────────
// In production, World ID identity replaces this IP-based counter.
let _demoCallCount = 0;
const _FREE_USES = parseInt(process.env.AGENTKIT_FREE_USES ?? '3', 10);

if (process.env.PAYMENT_ADDRESS) {
  app.use('/api/analyze', (req, res, next) => {
    if (req.method !== 'POST') return next();
    _demoCallCount++;
    if (_demoCallCount > _FREE_USES) {
      res.status(402).json({
        x402Version: 1,
        error: 'Free trial exhausted. Payment required.',
        accepts: [{
          scheme: 'exact',
          price: process.env.AGENTKIT_PRICE ?? '$0.02',
          network: process.env.AGENTKIT_NETWORK ?? 'eip155:84532',
          payTo: process.env.PAYMENT_ADDRESS,
        }],
      });
      return;
    }
    next();
  });
}

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
    const allEvents = await fetchPolymarketEvents({ limit: 100, minVolume: 5000 });
    const events = selectForAgent(allEvents, 5);

    const input: AgentInput = {
      positions,
      events,
      news: news?.length ? news : DEMO_NEWS,
    };

    const model = process.env.OMNIHEDGE_MODEL ?? 'llama-3.3-70b-versatile';
    const agent = new HedgeAgent(undefined, model);
    const output = await agent.analyze(input);

    // Persist analysis to Walrus decentralised storage
    let walrusBlobId: string | null = null;
    let walrusUrl: string | null = null;
    try {
      walrusBlobId = await storeBlob({ input, output, storedAt: new Date().toISOString() });
      walrusUrl = blobUrl(walrusBlobId);
    } catch (walrusErr) {
      console.warn('[OmniHedge] Walrus store failed (non-fatal):', walrusErr);
    }

    res.json({ ok: true, input, output, walrusBlobId, walrusUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

// ── GET /api/analysis/:blobId ─────────────────────────────────────────────────

app.get('/api/analysis/:blobId', async (req, res) => {
  try {
    const data = await fetchBlob<{ input: AgentInput; output: HedgeAnalysisOutput; storedAt: string }>(
      req.params.blobId
    );
    res.json({ ok: true, ...data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(404).json({ ok: false, error: message });
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

// ── Export for Vercel serverless ──────────────────────────────────────────────

export default app;

// ── Start (local dev / self-hosted) ───────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n[OmniHedge] Server running at http://localhost:${PORT}`);
    console.log(`[OmniHedge] Model: ${process.env.OMNIHEDGE_MODEL ?? 'llama-3.3-70b-versatile'}\n`);
  });
}
