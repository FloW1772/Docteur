import { studioRequestError } from './studio-errors';

const base = `${window.location.protocol}//${window.location.hostname}:3001/api/sales`;

export interface SalesLead {
  id: string;
  name: string;
  company: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface SalesResearchSource {
  id: string;
  url: string;
  title: string;
  retrievedAt?: string;
  retrieved_at?: string;
  untrusted: boolean;
}

export interface ScoreCriterion {
  id: string;
  keyword: string;
  weight: number;
  label: string;
}

export interface ScoreFactorResult {
  id: string;
  keyword: string;
  weight: number;
  label: string;
  matched: boolean;
  occurrences: number;
  status: 'matched' | 'not_matched' | 'insufficient_data';
}

export interface LeadScore {
  score: number | null;
  dataCompleteness: number;
  matched: { id: string; label: string; occurrences: number }[];
  unmatched: { id: string; label: string }[];
  missingData: string[];
  criteria: ScoreFactorResult[];
}

export interface SalesDraft {
  id: string;
  lead_id: string;
  kind: 'outreach_message' | 'crm_note';
  subject: string;
  body: string;
  status: string; // always the literal 'DRAFT — NOT SENT'
  sent: boolean;  // always false — V1 has no send capability
  created_at: string;
}

// The V1 safety contract, mirrored on the client so the UI can never even
// attempt to construct a forbidden action — the backend enforces this
// independently regardless (sales-policy.js), this is defense in depth for
// the UI layer only.
export const ALLOWED_SALES_ACTIONS = ['RESEARCH', 'ANALYZE', 'SCORE', 'DRAFT'] as const;
export const DRAFT_STATUS_LABEL = 'DRAFT — NOT SENT';

export async function salesRequest<T>(path: string, body?: unknown, method = 'GET'): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(studioRequestError(data.error));
  return data as T;
}
