import { z } from 'zod';
import type { HedgeAnalysisOutput } from './types';

// ── Primitive schemas ─────────────────────────────────────────────────────────

const Status = z.enum(['SUCCESS', 'NO_HEDGE_AVAILABLE', 'LOW_CONFIDENCE', 'INPUT_ERROR']);
const RiskLevel = z.enum(['HIGH', 'MEDIUM', 'LOW']);
const Direction = z.enum(['NEGATIVE', 'AMBIGUOUS']);
const Directness = z.enum(['HIGH', 'MEDIUM', 'LOW', 'NONE']);
const TimeAlignment = z.enum(['ALIGNED', 'PARTIAL', 'MISALIGNED']);
const LiquidityTier = z.enum(['LIQUID', 'THIN', 'ILLIQUID']);
const HedgeSide = z.enum(['YES', 'NO']);
const GateStatus = z.enum(['PASSED', 'SKIPPED']);

const RiskFactorId = z.enum([
  'MACRO_RATES',
  'MACRO_LIQUIDITY',
  'SECTOR_ROTATION',
  'PROTOCOL_EXPLOIT',
  'REGULATORY',
  'BRIDGE_RISK',
  'NARRATIVE_COLLAPSE',
  'CORRELATION_CONTAGION',
  'STABLECOIN_DEPEG',
  'GAS_ECONOMICS',
]);

// ── Composite schemas ─────────────────────────────────────────────────────────

const AnalysisMetadataSchema = z.object({
  portfolio_total_usd: z.number(),
  portfolio_risk_score: RiskLevel,
  dominant_risk_factors: z.array(RiskFactorId),
  analysis_confidence: RiskLevel,
  events_received: z.number(),
  events_passed_liquidity_gate: z.number(),
  events_passed_relevance_filter: z.number(),
  events_entered_direction_verification: z.number(),
});

const RiskFactorSchema = z.object({
  factor_id: RiskFactorId,
  severity: RiskLevel,
  direction: Direction,
  rationale: z.string(),
});

const RiskDecompositionSchema = z.object({
  token_symbol: z.string(),
  usd_value: z.number(),
  portfolio_weight_pct: z.number(),
  risk_factors: z.array(RiskFactorSchema),
});

const CanonicalFieldsSchema = z.object({
  canonical_asset: z.string().nullable(),
  canonical_direction: z.string().nullable(),
  canonical_threshold: z.string().nullable(),
  resolution_date: z.string().nullable(),
  volume_usd: z.number(),
  yes_price: z.number(),
  // Derived from volume_usd in post-processing if the model omits it
  liquidity_tier: LiquidityTier.optional(),
});

const RelevanceScoreSchema = z.object({
  matched_token: z.string().optional(),
  matched_factor_id: RiskFactorId,
  directness: Directness,
  time_alignment: TimeAlignment,
  eligible_for_hedge: z.boolean(),
});

const EventAnalysisSchema = z.object({
  event_id: z.string(),
  title: z.string(),
  canonical_fields: CanonicalFieldsSchema,
  gate_status: GateStatus,
  skip_reason: z.string().nullable(),
  relevance_scores: z.array(RelevanceScoreSchema),
});

const HedgeProposalSchema = z.object({
  event_id: z.string(),
  event_title: z.string(),
  hedge_side: HedgeSide,
  entry_price: z.number(),
  weight_pct: z.number().int().min(5).max(40),
  implied_usd_allocation: z.number(),
  risk_factor_covered: RiskFactorId,
  severity: RiskLevel,
  liquidity_tier: LiquidityTier,
  relevance_score: z.object({
    directness: Directness,
    time_alignment: TimeAlignment,
  }),
  direction_verification: z.string().min(50),
  rationale: z.string().min(50),
});

const PortfolioConstraintsCheckSchema = z.object({
  total_hedge_weight_pct: z.number(),
  max_single_event_weight_pct: z.number(),
  weight_sum_within_limit: z.boolean(),
  no_single_event_exceeds_40pct: z.boolean(),
  all_weights_above_minimum: z.boolean(),
});

const SkippedEventSchema = z.object({
  event_id: z.string(),
  title: z.string(),
  skip_reason: z.string(),
});

// ── Root output schema ────────────────────────────────────────────────────────

export const HedgeAnalysisOutputSchema = z.object({
  status: Status,
  analysis_metadata: AnalysisMetadataSchema,
  risk_decomposition: z.array(RiskDecompositionSchema),
  event_analysis: z.array(EventAnalysisSchema),
  hedges: z.array(HedgeProposalSchema),
  portfolio_constraints_check: PortfolioConstraintsCheckSchema,
  skipped_events: z.array(SkippedEventSchema),
  warnings: z.array(z.string()),
  fallback_reason: z.string().nullable(),
}) satisfies z.ZodType<HedgeAnalysisOutput>;
