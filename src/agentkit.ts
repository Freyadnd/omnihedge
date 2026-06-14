import {
  createAgentBookVerifier,
  createAgentkitHooks,
  InMemoryAgentKitStorage,
  agentkitResourceServerExtension,
  declareAgentkitExtension,
} from '@worldcoin/agentkit';
import { ExactEvmScheme } from '@x402/evm';
import { x402ResourceServer, x402HTTPResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';

// ── Config ─────────────────────────────────────────────────────────────────────

const PAYMENT_ADDRESS = (process.env.PAYMENT_ADDRESS ?? '') as `0x${string}`;
const FREE_USES = parseInt(process.env.AGENTKIT_FREE_USES ?? '3', 10);
const PRICE_USD = process.env.AGENTKIT_PRICE ?? '$0.02';

// Base Sepolia testnet (change to 'eip155:8453' for mainnet Base)
const NETWORK = (process.env.AGENTKIT_NETWORK ?? 'eip155:84532') as `eip155:${string}`;

// ── AgentKit setup ─────────────────────────────────────────────────────────────

const agentBook = createAgentBookVerifier();
const storage = new InMemoryAgentKitStorage();

export const agentkitHooks = createAgentkitHooks({
  agentBook,
  storage,
  mode: { type: 'free-trial', uses: FREE_USES },
  onEvent: (event) => {
    if (event.type === 'agent_verified') {
      console.log(`[AgentKit] ✓ Human-backed agent verified: ${event.address} (human: ${event.humanId})`);
    } else if (event.type === 'discount_exhausted') {
      console.log(`[AgentKit] Trial exhausted for human: ${event.humanId}`);
    } else {
      console.log(`[AgentKit] ${event.type}`);
    }
  },
});

// ── x402 resource server ───────────────────────────────────────────────────────

const facilitatorClient = new HTTPFacilitatorClient({
  url: 'https://x402.org/facilitator',
});

// ExactEvmScheme CJS types require args but runtime accepts zero — cast to avoid TS error
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new (ExactEvmScheme as unknown as new () => unknown)())
  .registerExtension(agentkitResourceServerExtension);

export const routes = {
  'POST /api/analyze': {
    accepts: [
      {
        scheme: 'exact' as const,
        price: PRICE_USD,
        network: NETWORK,
        payTo: PAYMENT_ADDRESS,
      },
    ],
    extensions: declareAgentkitExtension({
      statement: 'Verify your agent is backed by a real human to unlock free OmniHedge analyses',
      mode: { type: 'free-trial', uses: FREE_USES },
    }),
    description: `OmniHedge AI portfolio hedge analysis — ${FREE_USES} free uses for World ID-verified humans`,
  },
};

export const x402HttpServer = new x402HTTPResourceServer(resourceServer, routes)
  .onProtectedRequest(agentkitHooks.requestHook);
