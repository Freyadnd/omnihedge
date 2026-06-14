/**
 * OmniHedge — Chainlink CRE Workflow
 *
 * Three-step pipeline running on the Chainlink DON:
 *   1. Fetch live Polymarket prediction-market events (HTTP GET)
 *   2. Call Groq LLM via HTTP POST to generate a structured hedge analysis
 *   3. Log and return the result (extendable to on-chain write in production)
 *
 * CRE's consensus layer ensures all DON nodes agree on the analysis output
 * before any downstream action is taken — making the hedge signal verifiable.
 *
 * Two trigger modes:
 *   - CronCapability  (staging/production): fires on schedule, portfolio from config
 *   - HTTPCapability  (demo): triggered via --http-payload, portfolio from request body
 */

import {
  CronCapability,
  HTTPCapability,
  HTTPClient,
  consensusIdenticalAggregation,
  handler,
  json,
  ok,
  Runner,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";

// ── Config ────────────────────────────────────────────────────────────────────

export type Config = {
  schedule: string;
  polymarketApiUrl: string;
  groqApiUrl: string;
  groqModel: string;
  portfolio: Array<{
    token_symbol: string;
    usd_value: number;
    percentage_of_portfolio: number;
  }>;
};

// ── Types ─────────────────────────────────────────────────────────────────────

type PolymarketEvent = {
  id: string;
  title: string;
  volume: string;
  markets: Array<{
    outcomePrices: string;
    endDate: string;
  }>;
};

type EventSummary = {
  id: string;
  title: string;
  volume_usd: number;
  yes_price: number;
  resolution_date: string;
};

type HedgeSummary = {
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
};

type PortfolioItem = {
  token_symbol: string;
  usd_value: number;
  percentage_of_portfolio: number;
};

type AnalysisInput = {
  groqApiUrl: string;
  groqModel: string;
  groqApiKey: string;
  portfolio: PortfolioItem[];
  events: EventSummary[];
};

// HTTP trigger payload shape (mirrors Payload.input decoded from Uint8Array)
type HTTPTriggerPayload = { input: Uint8Array };

// ── Utilities ─────────────────────────────────────────────────────────────────

// TextDecoder not available in Javy WASM runtime
function uint8ArrayToString(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i++) {
    result += String.fromCharCode(bytes[i] as number);
  }
  return result;
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(str: string): string {
  let result = "";
  let i = 0;
  while (i < str.length) {
    const b0 = str.charCodeAt(i++) & 0xff;
    const b1 = i < str.length ? str.charCodeAt(i++) & 0xff : 0;
    const b2 = i < str.length ? str.charCodeAt(i++) & 0xff : 0;
    const hasB1 = i - 2 <= str.length;
    const hasB2 = i - 1 <= str.length;
    result += BASE64_CHARS[b0 >> 2];
    result += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    result += hasB1 ? BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    result += hasB2 ? BASE64_CHARS[b2 & 63] : "=";
  }
  return result;
}

// ── Step 1: Fetch Polymarket events ──────────────────────────────────────────

const fetchPolymarketEvents = (
  requester: HTTPSendRequester,
  apiUrl: string,
): EventSummary[] => {
  const response = requester
    .sendRequest({ url: apiUrl, method: "GET" })
    .result();

  if (!ok(response)) {
    throw new Error(`Polymarket fetch failed: ${response.statusCode}`);
  }

  const raw = json(response) as PolymarketEvent[];
  if (!Array.isArray(raw)) throw new Error("Unexpected Polymarket response");

  // Compact to EventSummary here so DON consensus handles minimal data
  return raw
    .filter((ev) => Array.isArray(ev.markets) && ev.markets.length > 0)
    .filter((ev) => Number(ev.volume ?? 0) >= 5000)
    .slice(0, 8)
    .map((ev) => {
      let yesPrice = 0.5;
      try {
        const prices = JSON.parse(ev.markets[0]?.outcomePrices ?? "[0.5,0.5]") as number[];
        yesPrice = prices[0] ?? 0.5;
      } catch {
        // default
      }
      return {
        id: ev.id,
        title: ev.title,
        volume_usd: Number(ev.volume),
        yes_price: yesPrice,
        resolution_date: ev.markets[0]?.endDate?.slice(0, 10) ?? "2026-12-31",
      };
    });
};

// ── Step 2: Groq LLM hedge analysis ──────────────────────────────────────────

const runGroqAnalysis = (
  requester: HTTPSendRequester,
  input: AnalysisInput,
): HedgeSummary => {
  const { groqApiUrl, groqModel, groqApiKey, portfolio, events } = input;

  const userMessage = `You are a DeFi hedge analyst. Analyze the portfolio and prediction market events. Return ONLY a JSON object.

Portfolio: ${JSON.stringify(portfolio)}
Events: ${JSON.stringify(events)}

Required JSON shape:
{
  "status": "SUCCESS" | "NO_HEDGE_AVAILABLE",
  "portfolio_risk_score": "HIGH" | "MEDIUM" | "LOW",
  "dominant_factors": ["MACRO_RATES" | "REGULATORY" | "NARRATIVE_COLLAPSE" | "STABLECOIN_DEPEG" | "PROTOCOL_EXPLOIT"],
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
      body: toBase64(requestBody),
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

export const onCronTrigger = (runtime: Runtime<Config>): string => {
  const { polymarketApiUrl, groqApiUrl, groqModel, portfolio } = runtime.config;

  // Fetch secret from CRE secrets store
  const groqApiKey = runtime.getSecret({ id: "GROQ_API_KEY" }).result().value;

  const httpClient = new HTTPClient();

  // Step 1 — fetch Polymarket events with DON consensus
  // fetchPolymarketEvents returns EventSummary[] (compacted) to stay within consensus limits
  const events = httpClient
    .sendRequest(
      runtime,
      fetchPolymarketEvents,
      consensusIdenticalAggregation<EventSummary[]>(),
    )(polymarketApiUrl)
    .result();

  runtime.log(`[OmniHedge] Fetched ${events.length} Polymarket events`);

  // Step 2 — Groq LLM analysis with DON consensus
  const analysisInput: AnalysisInput = {
    groqApiUrl,
    groqModel,
    groqApiKey,
    portfolio,
    events,
  };

  const analysis = httpClient
    .sendRequest(
      runtime,
      runGroqAnalysis,
      consensusIdenticalAggregation<HedgeSummary>(),
    )(analysisInput)
    .result();

  runtime.log(`[OmniHedge] Status: ${analysis.status}`);
  runtime.log(`[OmniHedge] Risk: ${analysis.portfolio_risk_score}`);
  runtime.log(`[OmniHedge] Hedges: ${analysis.hedges?.length ?? 0}`);

  for (const h of analysis.hedges ?? []) {
    runtime.log(
      `[OmniHedge]   ${h.hedge_side} "${h.event_title}" @ ${h.entry_price} → ${h.weight_pct}% allocation`,
    );
  }

  return JSON.stringify(analysis);
};

// ── HTTP trigger handler (demo mode) ─────────────────────────────────────────

export const onHTTPTrigger = (
  runtime: Runtime<Config>,
  triggerOutput: HTTPTriggerPayload,
): string => {
  const { polymarketApiUrl, groqApiUrl, groqModel } = runtime.config;
  const groqApiKey = runtime.getSecret({ id: "GROQ_API_KEY" }).result().value;

  // Decode portfolio from HTTP payload body
  const body = JSON.parse(uint8ArrayToString(triggerOutput.input)) as {
    portfolio: PortfolioItem[];
  };
  const portfolio = body.portfolio;

  runtime.log(`[OmniHedge] HTTP trigger — portfolio: ${portfolio.map((p) => p.token_symbol).join(", ")}`);

  const httpClient = new HTTPClient();

  const events = httpClient
    .sendRequest(
      runtime,
      fetchPolymarketEvents,
      consensusIdenticalAggregation<EventSummary[]>(),
    )(polymarketApiUrl)
    .result();

  runtime.log(`[OmniHedge] Fetched ${events.length} Polymarket events`);

  const analysis = httpClient
    .sendRequest(
      runtime,
      runGroqAnalysis,
      consensusIdenticalAggregation<HedgeSummary>(),
    )({ groqApiUrl, groqModel, groqApiKey, portfolio, events })
    .result();

  runtime.log(`[OmniHedge] Status: ${analysis.status}`);
  runtime.log(`[OmniHedge] Risk: ${analysis.portfolio_risk_score}`);
  runtime.log(`[OmniHedge] Hedges: ${analysis.hedges?.length ?? 0}`);

  for (const h of analysis.hedges ?? []) {
    runtime.log(
      `[OmniHedge]   ${h.hedge_side} "${h.event_title}" @ ${h.entry_price} → ${h.weight_pct}% allocation`,
    );
  }

  return JSON.stringify(analysis);
};

// ── Workflow bootstrap ────────────────────────────────────────────────────────

export const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  const http = new HTTPCapability();
  return [
    handler(cron.trigger({ schedule: config.schedule }), onCronTrigger),
    handler(http.trigger({ authorizedKeys: [] }), onHTTPTrigger),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
