// ── Primitive enums ───────────────────────────────────────────────────────────

export type Status =
  | 'SUCCESS'
  | 'NO_HEDGE_AVAILABLE'
  | 'LOW_CONFIDENCE'
  | 'INPUT_ERROR';

export type RiskLevel = 'HIGH' | 'MEDIUM' | 'LOW';
export type Direction = 'NEGATIVE' | 'AMBIGUOUS';
export type Directness = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
export type TimeAlignment = 'ALIGNED' | 'PARTIAL' | 'MISALIGNED';
export type LiquidityTier = 'LIQUID' | 'THIN' | 'ILLIQUID';
export type HedgeSide = 'YES' | 'NO';
export type GateStatus = 'PASSED' | 'SKIPPED';

export type RiskFactorId =
  | 'MACRO_RATES'
  | 'MACRO_LIQUIDITY'
  | 'SECTOR_ROTATION'
  | 'PROTOCOL_EXPLOIT'
  | 'REGULATORY'
  | 'BRIDGE_RISK'
  | 'NARRATIVE_COLLAPSE'
  | 'CORRELATION_CONTAGION'
  | 'STABLECOIN_DEPEG'
  | 'GAS_ECONOMICS';

// ── Input types ───────────────────────────────────────────────────────────────

export interface Position {
  token_symbol: string;
  amount: number;
  usd_value: number;
  percentage_of_portfolio: number;
}

export interface PredictionEvent {
  event_id: string;
  title: string;
  volume_usd: number;
  yes_price: number;
  no_price: number;
  resolution_date: string; // YYYY-MM-DD
}

export interface AgentInput {
  positions: Position[];
  events: PredictionEvent[];
  news: string[];
}

// ── Output types ──────────────────────────────────────────────────────────────

export interface AnalysisMetadata {
  portfolio_total_usd: number;
  portfolio_risk_score: RiskLevel;
  dominant_risk_factors: RiskFactorId[];
  analysis_confidence: RiskLevel;
  events_received: number;
  events_passed_liquidity_gate: number;
  events_passed_relevance_filter: number;
  events_entered_direction_verification: number;
}

export interface RiskFactor {
  factor_id: RiskFactorId;
  severity: RiskLevel;
  direction: Direction;
  rationale: string;
}

export interface RiskDecomposition {
  token_symbol: string;
  usd_value: number;
  portfolio_weight_pct: number;
  risk_factors: RiskFactor[];
}

export interface CanonicalFields {
  canonical_asset: string | null;
  canonical_direction: string | null;
  canonical_threshold: string | null;
  resolution_date: string | null;
  volume_usd: number;
  yes_price: number;
  liquidity_tier?: LiquidityTier;
}

export interface RelevanceScore {
  matched_token?: string;
  matched_factor_id: RiskFactorId;
  directness: Directness;
  time_alignment: TimeAlignment;
  eligible_for_hedge: boolean;
}

export interface EventAnalysis {
  event_id: string;
  title: string;
  canonical_fields: CanonicalFields;
  gate_status: GateStatus;
  skip_reason: string | null;
  relevance_scores: RelevanceScore[];
}

export interface HedgeRelevanceScore {
  directness: Directness;
  time_alignment: TimeAlignment;
}

export interface HedgeProposal {
  event_id: string;
  event_title: string;
  hedge_side: HedgeSide;
  entry_price: number;
  weight_pct: number;
  implied_usd_allocation: number;
  risk_factor_covered: RiskFactorId;
  severity: RiskLevel;
  liquidity_tier: LiquidityTier;
  relevance_score: HedgeRelevanceScore;
  direction_verification: string;
  rationale: string;
}

export interface PortfolioConstraintsCheck {
  total_hedge_weight_pct: number;
  max_single_event_weight_pct: number;
  weight_sum_within_limit: boolean;
  no_single_event_exceeds_40pct: boolean;
  all_weights_above_minimum: boolean;
}

export interface SkippedEvent {
  event_id: string;
  title: string;
  skip_reason: string;
}

export interface HedgeAnalysisOutput {
  status: Status;
  analysis_metadata: AnalysisMetadata;
  risk_decomposition: RiskDecomposition[];
  event_analysis: EventAnalysis[];
  hedges: HedgeProposal[];
  portfolio_constraints_check: PortfolioConstraintsCheck;
  skipped_events: SkippedEvent[];
  warnings: string[];
  fallback_reason: string | null;
}
