/**
 * OmniHedge CRE Workflow
 *
 * Orchestrates a three-step hedge analysis pipeline on Chainlink DON:
 *   1. Fetch live Polymarket prediction-market events (HTTP GET)
 *   2. Call Groq LLM via OpenAI-compatible API (HTTP POST) to identify hedges
 *   3. Log and return a structured hedge recommendation
 *
 * Runs every 30 minutes; results are verifiable across all DON nodes via
 * CRE's consensus layer before any downstream on-chain action is taken.
 */

import { z } from "zod";
import {
  cre,
  consensusIdenticalAggregation,
  json,
  ok,
  Runner,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";

// ── Config schema ─────────────────────────────────────────────────────────────

const PortfolioPositionSchema = z.object({
  token_symbol: z.string(),
  amount: z.number(),
  usd_value: z.number(),
  percentage_of_portfolio: z.number(),
});

const configSchema = z.object({
  schedule: z.string(),
  polymarketApiUrl: z.string(),
  groqApiUrl: z.string(),
  groqModel: z.string(),
  portfolio: z.array(PortfolioPositionSchema),
});

type Config = z.infer<typeof configSchema>;

// ── Polymarket event types ────────────────────────────────────────────────────

interface PolymarketMarket {
  question: string;
  volume: string;
  outcomePrices: string;
  outcomes: string;
  active: boolean;
  endDate: string;
}

interface PolymarketEvent {
  id: string;
  title: string;
  volume: string;
  markets: PolymarketMarket[];
}

// ── Step 1: Fetch Polymarket events ──────────────────────────────────────────

const fetchEvents = (requester: HTTPSendRequester, url: string): PolymarketEvent[] => {
  const response = requester
    .sendRequest({ url, method: "GET" })
    .result();

  if (!ok(response)) {
    throw new Error(`Polymarket fetch failed: ${response.statusCode}`);
  }

  const raw = json(response) as PolymarketEvent[];
  if (!Array.isArray(raw)) throw new Error("Unexpected Polymarket response shape");

  // Filter to events with liquid binary markets (volume > $5,000)
  return raw
    .filter((ev) => Array.isArray(ev.markets) && ev.markets.length > 0)
    .filter((ev) => Number(ev.volume ?? 0) >= 5000)
    .slice(0, 8); // cap for token budget
};

// ── Step 2: Groq LLM hedge analysis ──────────────────────────────────────────

interface HedgeSummary {
  status: string;
  portfolio_risk_score: string;
  dominant_factors: string[];
  hedges: Array<{
    event_title: string;
    hedge_side: string;
    entry_price: number;
    weight_pct: number;
    rationale: string;
  }>;
  warnings: string[];
}

const runLlmAnalysis = (
  requester: HTTPSendRequester,
  groqApiUrl: string,
  groqModel: string,
  groqApiKey: string,
  portfolio: Config["portfolio"],
  events: PolymarketEvent[],
): HedgeSummary => {
  // Compact event representation for token efficiency
  const eventSummaries = events.map((ev) => {
    const mkt = ev.markets[0];
    let yesPrice = 0.5;
    try {
      const prices = JSON.parse(mkt.outcomePrices ?? "[0.5,0.5]") as number[];
      yesPrice = prices[0] ?? 0.5;
    } catch {
      // default
    }
    return {
      id: ev.id,
      title: ev.title,
      volume_usd: Number(ev.volume),
      yes_price: yesPrice,
      resolution_date: mkt.endDate?.slice(0, 10) ?? "2026-12-31",
    };
  });

  const userMessage = `You are a DeFi risk analyst. Given the portfolio and prediction market events below, identify up to 2 hedge opportunities.

Portfolio: ${JSON.stringify(portfolio)}
Events: ${JSON.stringify(eventSummaries)}

Respond with ONLY a JSON object matching this shape:
{
  "status": "SUCCESS" | "NO_HEDGE_AVAILABLE",
  "portfolio_risk_score": "HIGH" | "MEDIUM" | "LOW",
  "dominant_factors": ["MACRO_RATES" | "REGULATORY" | "NARRATIVE_COLLAPSE" | ...],
  "hedges": [{ "event_title": string, "hedge_side": "YES" | "NO", "entry_price": number, "weight_pct": number, "rationale": string }],
  "warnings": [string]
}`;

  const requestBody = JSON.stringify({
    model: groqModel,
    temperature: 0,
    max_tokens: 1024,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are a DeFi hedge analysis agent. Return only valid JSON." },
      { role: "user", content: userMessage },
    ],
  });

  const response = requester
    .sendRequest({
      url: groqApiUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqApiKey}`,
      },
      body: requestBody,
    })
    .result();

  if (!ok(response)) {
    throw new Error(`Groq API failed: ${response.statusCode}`);
  }

  const completion = json(response) as {
    choices: Array<{ message: { content: string } }>;
  };
  const content = completion?.choices?.[0]?.message?.content ?? "{}";
  return JSON.parse(content) as HedgeSummary;
};

// ── Main handler ──────────────────────────────────────────────────────────────

const onCronTrigger = (runtime: Runtime<Config>): string => {
  const { polymarketApiUrl, groqApiUrl, groqModel, portfolio } = runtime.config;
  const groqApiKey = runtime.secrets.GROQ_API_KEY;

  const httpClient = new cre.capabilities.HTTPClient();

  // Step 1 — fetch Polymarket events (with DON consensus)
  const events = httpClient
    .sendRequest(
      runtime,
      (requester) => fetchEvents(requester, polymarketApiUrl),
      consensusIdenticalAggregation<PolymarketEvent[]>(),
    )(runtime.config)
    .result();

  runtime.log(`[OmniHedge] Fetched ${events.length} Polymarket events`);

  // Step 2 — run LLM analysis (node-mode: each node calls Groq independently,
  // consensus ensures all nodes agree on the result)
  const analysis = httpClient
    .sendRequest(
      runtime,
      (requester) =>
        runLlmAnalysis(requester, groqApiUrl, groqModel, groqApiKey, portfolio, events),
      consensusIdenticalAggregation<HedgeSummary>(),
    )(runtime.config)
    .result();

  runtime.log(`[OmniHedge] Analysis status: ${analysis.status}`);
  runtime.log(`[OmniHedge] Risk score: ${analysis.portfolio_risk_score}`);
  runtime.log(`[OmniHedge] Hedges found: ${analysis.hedges?.length ?? 0}`);

  if (analysis.hedges?.length) {
    for (const h of analysis.hedges) {
      runtime.log(
        `[OmniHedge]   → ${h.hedge_side} ${h.event_title} @ ${h.entry_price} (${h.weight_pct}% allocation)`,
      );
    }
  }

  return JSON.stringify(analysis);
};

// ── Workflow bootstrap ────────────────────────────────────────────────────────

function initWorkflow(runtime: Runtime<Config>) {
  const cron = new cre.capabilities.CronCapability();
  const trigger = cron.trigger({ schedule: runtime.config.schedule });
  cre.handler({ trigger, handler: onCronTrigger });
}

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

main();
