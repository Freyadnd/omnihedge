import 'dotenv/config';
import { HedgeAgent } from './agent';
import { fetchPolymarketEvents, selectForAgent } from './polymarket';
import { fetchWalletPositions, DEFAULT_TOKENS } from './chain';
import type { AgentInput, HedgeAnalysisOutput } from './types';

// ── Demo input (from design session) ─────────────────────────────────────────

const DEMO_INPUT: AgentInput = {
  positions: [
    {
      token_symbol: 'ETH',
      amount: 15.5,
      usd_value: 54250.0,
      percentage_of_portfolio: 65.0,
    },
    {
      token_symbol: 'TAI',
      amount: 5000,
      usd_value: 29250.0,
      percentage_of_portfolio: 35.0,
    },
  ],
  events: [
    {
      event_id: 'poly-fed-june',
      title: 'Will Fed cut interest rates in June 2026?',
      volume_usd: 1250000,
      yes_price: 0.65,
      no_price: 0.35,
      resolution_date: '2026-06-30',
    },
    {
      event_id: 'poly-eth-gas',
      title: 'Will Ethereum average gas fee exceed 100 gwei this week?',
      volume_usd: 3500,
      yes_price: 0.12,
      no_price: 0.88,
      resolution_date: '2026-06-18',
    },
  ],
  news: [
    'Fed chairman hints at persistent inflation in the latest speech, signaling delayed rate cuts.',
    'Ethereum layer-2 gas optimization upgrade goes live, drastically reducing mainnet congestion.',
  ],
};

// ── CLI printer ───────────────────────────────────────────────────────────────

function printSummary(output: HedgeAnalysisOutput): void {
  const LINE = '═'.repeat(62);
  const DIV = '─'.repeat(58);

  console.log('\n' + LINE);
  console.log('  OMNIHEDGE — Risk Analysis Summary');
  console.log(LINE);
  console.log(`  Status            : ${output.status}`);
  console.log(
    `  Portfolio Value   : $${output.analysis_metadata.portfolio_total_usd.toLocaleString()}`
  );
  console.log(`  Risk Score        : ${output.analysis_metadata.portfolio_risk_score}`);
  console.log(`  Confidence        : ${output.analysis_metadata.analysis_confidence}`);
  console.log(
    `  Dominant Factors  : ${output.analysis_metadata.dominant_risk_factors.join(', ')}`
  );
  console.log(`  Events In / Passed: ${output.analysis_metadata.events_received} / ${output.analysis_metadata.events_passed_liquidity_gate} (liquidity gate)`);

  // Risk decomposition
  console.log('\n  RISK DECOMPOSITION');
  console.log('  ' + DIV);
  for (const pos of output.risk_decomposition) {
    console.log(
      `  ${pos.token_symbol.padEnd(6)} $${pos.usd_value.toLocaleString().padEnd(12)} ${pos.portfolio_weight_pct}% of portfolio`
    );
    for (const rf of pos.risk_factors) {
      const bar = rf.severity === 'HIGH' ? '!!!' : rf.severity === 'MEDIUM' ? '!! ' : '!  ';
      console.log(`    [${bar}] ${rf.factor_id}`);
    }
  }

  // Hedge proposals
  console.log('\n  HEDGE PROPOSALS');
  console.log('  ' + DIV);
  if (output.hedges.length === 0) {
    const reason = output.fallback_reason ?? 'No eligible hedges found.';
    console.log(`  (none) — ${reason}`);
  } else {
    for (const h of output.hedges) {
      console.log(`  ${h.event_title}`);
      console.log(
        `    Side      : Buy ${h.hedge_side} @ $${h.entry_price} (implied odds ${(1 / h.entry_price).toFixed(2)}x)`
      );
      console.log(
        `    Allocation: ${h.weight_pct}% → $${h.implied_usd_allocation.toLocaleString()}`
      );
      console.log(`    Covers    : ${h.risk_factor_covered} [${h.severity}]`);
      console.log(`    Liquidity : ${h.liquidity_tier}`);
      console.log(`    Alignment : ${h.relevance_score.time_alignment}`);
    }
  }

  // Skipped events
  if (output.skipped_events.length > 0) {
    console.log('\n  SKIPPED EVENTS');
    console.log('  ' + DIV);
    for (const s of output.skipped_events) {
      console.log(`  x ${s.event_id.padEnd(22)} ${s.skip_reason}`);
    }
  }

  // Portfolio constraints
  console.log('\n  PORTFOLIO CONSTRAINTS');
  console.log('  ' + DIV);
  const c = output.portfolio_constraints_check;
  console.log(`  Total hedge weight : ${c.total_hedge_weight_pct}%`);
  console.log(`  Max single event   : ${c.max_single_event_weight_pct}%`);
  console.log(`  Sum <= 100%        : ${c.weight_sum_within_limit ? 'PASS' : 'FAIL'}`);
  console.log(`  No event > 40%     : ${c.no_single_event_exceeds_40pct ? 'PASS' : 'FAIL'}`);
  console.log(`  All weights >= 5%  : ${c.all_weights_above_minimum ? 'PASS' : 'FAIL'}`);

  // Warnings
  if (output.warnings.length > 0) {
    console.log('\n  WARNINGS');
    console.log('  ' + DIV);
    for (const w of output.warnings) {
      const preview = w.length > 100 ? w.slice(0, 97) + '...' : w;
      console.log(`  ! ${preview}`);
    }
  }

  console.log('\n' + LINE + '\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.GROQ_API_KEY) {
    console.error('[OmniHedge] Error: GROQ_API_KEY is not set.');
    console.error('[OmniHedge] Copy .env.example to .env and add your key.');
    process.exit(1);
  }

  const model = process.env.OMNIHEDGE_MODEL ?? 'llama-3.3-70b-versatile';
  const walletAddress = process.env.WALLET_ADDRESS ?? process.argv[2];
  const agent = new HedgeAgent(undefined, model);

  console.log(`\n[OmniHedge] Model    : ${model}`);

  const t0 = Date.now();

  try {
    // Positions: live chain data if wallet provided, else demo fallback
    let positions = DEMO_INPUT.positions;
    if (walletAddress) {
      console.log(`[OmniHedge] Wallet   : ${walletAddress}`);
      console.log('[OmniHedge] Fetching on-chain positions...');
      const livePositions = await fetchWalletPositions(walletAddress, {
        tokens: DEFAULT_TOKENS,
      });
      if (livePositions.length > 0) {
        positions = livePositions;
        console.log(`[OmniHedge] Positions: ${livePositions.map((p) => p.token_symbol).join(', ')}`);
      } else {
        console.log('[OmniHedge] No on-chain positions found — using demo data');
      }
    } else {
      console.log(`[OmniHedge] Portfolio: ${positions.map((p) => p.token_symbol).join(', ')} (demo)`);
      console.log('[OmniHedge] Tip: set WALLET_ADDRESS env var to use live positions');
    }

    console.log('[OmniHedge] Fetching Polymarket events...');
    const allEvents = await fetchPolymarketEvents({ limit: 400, minVolume: 5000 });
    const liveEvents = selectForAgent(allEvents, 15);
    console.log(`[OmniHedge] Events   : ${allEvents.length} fetched → ${liveEvents.length} selected for agent`);

    const input: AgentInput = { ...DEMO_INPUT, positions, events: liveEvents };

    console.log('[OmniHedge] Running analysis...\n');
    const output = await agent.analyze(input);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`[OmniHedge] Done in ${elapsed}s`);
    printSummary(output);

    console.log('[OmniHedge] Full JSON:\n');
    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    console.error('[OmniHedge] Analysis failed:', err);
    process.exit(1);
  }
}

main();
