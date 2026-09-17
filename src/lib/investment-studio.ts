const base = `${window.location.protocol}//${window.location.hostname}:3001/api/investment`;

export interface ResearchSource {
  id: string;
  url: string;
  title: string;
  retrievedAt: string;
  dataRecency: string;
}

export interface FundamentalsPeriod {
  periodLabel: string;
  periodType: string;
  currency: string;
  dataKind: string;
  metrics: Record<string, number | null>;
}

export interface PaperPortfolio {
  id: string;
  name: string;
  base_currency: string;
  starting_cash: number;
  cash: number;
}

export interface PaperPosition {
  id: string;
  symbol: string;
  quantity: number;
  avg_cost_basis: number;
}

export interface PaperTransaction {
  id: string;
  action: string;
  symbol: string;
  quantity: number;
  simulated_price: number;
  cash_after: number;
  created_at: string;
}

export async function investmentRequest<T>(path: string, body?: unknown, method = 'GET'): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
}

// The V1 safety contract, mirrored on the client so the UI can never even
// attempt to construct a forbidden action — the backend enforces this
// independently regardless (investment-policy.js), this is defense in depth
// for the UI layer only.
export const ALLOWED_PAPER_ACTIONS = ['PAPER_BUY', 'PAPER_SELL'] as const;
export type PaperAction = typeof ALLOWED_PAPER_ACTIONS[number];

// ── Scoring (transparent, never a BUY/SELL recommendation) ────────────────

export interface ScoreFactor {
  id: string;
  label: string;
  contribution: number;
  status: 'positive' | 'negative' | 'insufficient_data';
  value: number | boolean | null;
  note: string;
}

export interface ScoreCategory {
  category: string;
  score: number | null;
  dataCompleteness: number;
  positiveFactors: { id: string; label: string; value: unknown }[];
  negativeFactors: { id: string; label: string; value: unknown }[];
  missingData: string[];
  factors: ScoreFactor[];
  scoreMeaning?: string;
}

export interface InvestmentScoring {
  generatedAt: string;
  categories: {
    quality: ScoreCategory;
    growth: ScoreCategory;
    valuation: ScoreCategory;
    balanceSheet: ScoreCategory;
    risk: ScoreCategory;
  };
  disclaimer: string;
}

// ── Timeline / events ──────────────────────────────────────────────────────

export interface TimelineEvent {
  id: string;
  date: string | null;
  dateReliable: boolean;
  type: string;
  title: string;
  summary: string;
  source: { url: string; title: string; retrievedAt: string } | null;
  marketInterpretation: { statement: string; basis: string; speculative: true } | null;
}

export interface InvestmentTimeline {
  dated: TimelineEvent[];
  undated: TimelineEvent[];
  disclaimer: string;
}
