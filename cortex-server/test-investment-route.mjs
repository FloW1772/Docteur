import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import * as db from './src/lib/sqlite.js';
import { createInvestmentRoute } from './src/routes/investment.js';

db.initSqlite(':memory:');

// Deterministic mocks for the web research pipeline — no real network call
// in this suite. A separate manual smoke test already proved the real
// DuckDuckGo/extractContent pipeline works (see mission report).
const mockSearch = async () => [{ title: 'Mock Filing', url: 'https://example.com/filing', domain: 'example.com' }];
const mockFetchContent = async () => ({ title: 'Mock Filing Extracted', text: 'A'.repeat(200), fallback: false });
const mockCheckUrl = () => {}; // no-op: SSRF policy itself is tested separately in url-security's own suite

const app = new Hono().route('/api', createInvestmentRoute({
  search: mockSearch, fetchContent: mockFetchContent, checkUrl: mockCheckUrl,
}));

const request = async (path, body, method = 'GET') => {
  const response = await app.request(`http://localhost/api${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
};

// ── Ticker validation ────────────────────────────────────────────────────

test('valid ticker: research succeeds and records sources with provenance', async () => {
  const r = await request('/investment/research', { symbol: 'aapl' }, 'POST');
  assert.equal(r.status, 200);
  assert.equal(r.body.symbol, 'AAPL'); // normalized uppercase
  assert.equal(r.body.sources.length, 1);
  assert.equal(r.body.sources[0].url, 'https://example.com/filing');
  assert.ok(r.body.sources[0].retrievedAt);
  assert.equal(r.body.sources[0].dataRecency, 'historical');
});

test('unknown ticker: fundamentals returns 404, not fabricated data', async () => {
  const r = await request('/investment/fundamentals/ZZZZUNKNOWN');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'no_financial_data');
});

test('invalid ticker syntax denied', async () => {
  const r = await request('/investment/research', { symbol: '../../etc/passwd' }, 'POST');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'symbol_invalid');
});

test('empty ticker denied', async () => {
  const r = await request('/investment/research', { symbol: '' }, 'POST');
  assert.equal(r.status, 400);
});

// ── Financial data + fundamentals ────────────────────────────────────────

test('partial financial data: only some metrics computed, missing ones return null', async () => {
  await request('/investment/financial-period', {
    symbol: 'PARTIAL', periodLabel: 'FY2025', data: { revenue: 1000 }, // no costOfGoodsSold, no netIncome, etc.
  }, 'POST');

  const r = await request('/investment/fundamentals/PARTIAL');
  assert.equal(r.status, 200);
  assert.equal(r.body.periods[0].metrics.grossMargin, null);
  assert.equal(r.body.periods[0].metrics.netMargin, null);
});

test('different currency: currency is recorded and returned, never silently converted', async () => {
  await request('/investment/financial-period', {
    symbol: 'EURCO', periodLabel: 'FY2025', currency: 'EUR', data: { revenue: 500, netIncome: 50 },
  }, 'POST');
  const r = await request('/investment/fundamentals/EURCO');
  assert.equal(r.body.periods[0].currency, 'EUR');
});

test('analyst_estimate data recency is recorded distinctly from reported data', async () => {
  await request('/investment/financial-period', {
    symbol: 'ESTCO', periodLabel: 'FY2026E', dataRecency: 'analyst_estimate', data: { revenue: 999 },
  }, 'POST');
  const r = await request('/investment/fundamentals/ESTCO');
  assert.equal(r.body.periods[0].dataKind, 'estimate');
});

test('invalid data_recency value denied', async () => {
  const r = await request('/investment/financial-period', {
    symbol: 'BADREC', periodLabel: 'FY2025', dataRecency: 'time_travel', data: { revenue: 1 },
  }, 'POST');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'data_recency_invalid');
});

test('ratio with zero denominator returns null, never Infinity/NaN', async () => {
  const r = await request('/investment/valuation', {
    method: 'multiples', inputs: { price: 100, earningsPerShare: 0 },
  }, 'POST');
  assert.equal(r.status, 200);
  assert.equal(r.body.results.pe, null);
});

// ── Valuation ─────────────────────────────────────────────────────────────

test('DCF with invalid inputs (missing fields) denied with clear error, not a crash', async () => {
  const r = await request('/investment/valuation', { method: 'dcf', inputs: { baseFcf: 100 } }, 'POST');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'dcf_inputs_invalid');
});

test('DCF valid inputs: assumptions visible in response', async () => {
  const r = await request('/investment/valuation', {
    method: 'dcf', inputs: { baseFcf: 100, growthRate: 0.08, discountRate: 0.1, terminalGrowthRate: 0.02, years: 5 },
  }, 'POST');
  assert.equal(r.status, 200);
  assert.ok(r.body.assumptions);
  assert.ok(r.body.enterpriseValueEstimate > 0);
});

test('unknown valuation method denied', async () => {
  const r = await request('/investment/valuation', { method: 'astrology', inputs: {} }, 'POST');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'valuation_method_denied');
});

// ── Paper portfolio: buy/sell/insufficient cash/nonexistent position ────

test('paper buy succeeds and updates cash/position', async () => {
  const create = await request('/investment/portfolios', { name: 'P1', startingCash: 10000 }, 'POST');
  const id = create.body.id;
  const buy = await request(`/investment/portfolios/${id}/transactions`, {
    action: 'PAPER_BUY', symbol: 'AAPL', quantity: 10, simulatedPrice: 150,
  }, 'POST');
  assert.equal(buy.status, 200);
  assert.equal(buy.body.type, 'PAPER_BUY');
  assert.equal(buy.body.cash, 8500);
});

test('paper sell succeeds after a prior buy', async () => {
  const create = await request('/investment/portfolios', { startingCash: 10000 }, 'POST');
  const id = create.body.id;
  await request(`/investment/portfolios/${id}/transactions`, { action: 'PAPER_BUY', symbol: 'AAPL', quantity: 10, simulatedPrice: 100 }, 'POST');
  const sell = await request(`/investment/portfolios/${id}/transactions`, { action: 'PAPER_SELL', symbol: 'AAPL', quantity: 5, simulatedPrice: 120 }, 'POST');
  assert.equal(sell.status, 200);
  assert.equal(sell.body.cash, 9000 + 600); // 10000-1000=9000, +5*120=600
});

test('insufficient cash for paper buy denied', async () => {
  const create = await request('/investment/portfolios', { startingCash: 100 }, 'POST');
  const id = create.body.id;
  const r = await request(`/investment/portfolios/${id}/transactions`, { action: 'PAPER_BUY', symbol: 'AAPL', quantity: 100, simulatedPrice: 150 }, 'POST');
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'insufficient_cash');
});

test('sell of a nonexistent position denied', async () => {
  const create = await request('/investment/portfolios', { startingCash: 10000 }, 'POST');
  const id = create.body.id;
  const r = await request(`/investment/portfolios/${id}/transactions`, { action: 'PAPER_SELL', symbol: 'NEVEROWNED', quantity: 1, simulatedPrice: 10 }, 'POST');
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'position_insufficient');
});

test('sell more than owned quantity denied', async () => {
  const create = await request('/investment/portfolios', { startingCash: 10000 }, 'POST');
  const id = create.body.id;
  await request(`/investment/portfolios/${id}/transactions`, { action: 'PAPER_BUY', symbol: 'AAPL', quantity: 5, simulatedPrice: 100 }, 'POST');
  const r = await request(`/investment/portfolios/${id}/transactions`, { action: 'PAPER_SELL', symbol: 'AAPL', quantity: 10, simulatedPrice: 100 }, 'POST');
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'position_insufficient');
});

// ── The mission's core safety requirement: REAL_BUY/REAL_SELL/LIVE_ORDER always denied ──

test('REAL_BUY attempt refused (403, never executed)', async () => {
  const create = await request('/investment/portfolios', { startingCash: 10000 }, 'POST');
  const id = create.body.id;
  const r = await request(`/investment/portfolios/${id}/transactions`, { action: 'REAL_BUY', symbol: 'AAPL', quantity: 1, simulatedPrice: 100 }, 'POST');
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'real_broker_action_denied');
  const check = await request(`/investment/portfolios/${id}`);
  assert.equal(check.body.portfolio.cash, 10000); // unchanged
});

test('REAL_SELL attempt refused (403, never executed)', async () => {
  const create = await request('/investment/portfolios', { startingCash: 10000 }, 'POST');
  const id = create.body.id;
  const r = await request(`/investment/portfolios/${id}/transactions`, { action: 'REAL_SELL', symbol: 'AAPL', quantity: 1, simulatedPrice: 100 }, 'POST');
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'real_broker_action_denied');
});

test('LIVE_ORDER attempt refused (403)', async () => {
  const create = await request('/investment/portfolios', { startingCash: 10000 }, 'POST');
  const id = create.body.id;
  const r = await request(`/investment/portfolios/${id}/transactions`, { action: 'LIVE_ORDER', symbol: 'AAPL', quantity: 1, simulatedPrice: 100 }, 'POST');
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'real_broker_action_denied');
});

test('bare BUY/SELL/ORDER strings also refused, not silently coerced to PAPER_*', async () => {
  const create = await request('/investment/portfolios', { startingCash: 10000 }, 'POST');
  const id = create.body.id;
  for (const action of ['BUY', 'SELL', 'ORDER']) {
    const r = await request(`/investment/portfolios/${id}/transactions`, { action, symbol: 'AAPL', quantity: 1, simulatedPrice: 100 }, 'POST');
    assert.equal(r.status, 403, `${action} should be denied`);
  }
});

test('dedicated real-buy/real-sell/live-order/broker-connect routes always refuse', async () => {
  const create = await request('/investment/portfolios', { startingCash: 10000 }, 'POST');
  const id = create.body.id;
  const realBuy = await request(`/investment/portfolios/${id}/real-buy`, {}, 'POST');
  assert.equal(realBuy.status, 403);
  const realSell = await request(`/investment/portfolios/${id}/real-sell`, {}, 'POST');
  assert.equal(realSell.status, 403);
  const liveOrder = await request(`/investment/portfolios/${id}/live-order`, {}, 'POST');
  assert.equal(liveOrder.status, 403);
  const brokerConnect = await request('/investment/broker/connect', {}, 'POST');
  assert.equal(brokerConnect.status, 409);
  assert.equal(brokerConnect.body.error, 'broker_connection_not_supported_in_v1');
});

test('portfolio metrics: currentPrice defaults to cost basis when not supplied (never a fabricated live price)', async () => {
  const create = await request('/investment/portfolios', { startingCash: 10000 }, 'POST');
  const id = create.body.id;
  await request(`/investment/portfolios/${id}/transactions`, { action: 'PAPER_BUY', symbol: 'AAPL', quantity: 10, simulatedPrice: 100 }, 'POST');
  const r = await request(`/investment/portfolios/${id}/metrics`, {}, 'POST');
  assert.equal(r.status, 200);
  assert.equal(r.body.metrics.totalUnrealizedPnl, 0); // no price supplied -> defaults to cost basis -> 0 PnL
});

test('compare companies: mixed data availability handled without crashing', async () => {
  await request('/investment/financial-period', { symbol: 'HASDATA', periodLabel: 'FY2025', data: { revenue: 100, netIncome: 10 } }, 'POST');
  const r = await request('/investment/compare', { symbols: ['HASDATA', 'NODATA'] }, 'POST');
  assert.equal(r.status, 200);
  assert.equal(r.body.comparison[0].hasData, true);
  assert.equal(r.body.comparison[1].hasData, false);
  assert.equal(r.body.comparison[1].metrics, null);
});

// ── Scoring endpoint ────────────────────────────────────────────────────

test('scoring: unknown ticker returns 404, never a fabricated score', async () => {
  const r = await request('/investment/scoring/NOSCORE');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'no_financial_data');
});

test('scoring: complete data returns transparent categories with factors, never a bare BUY/SELL', async () => {
  await request('/investment/financial-period', {
    symbol: 'SCOREME', periodLabel: 'FY2025',
    data: { revenue: 1000, costOfGoodsSold: 400, operatingIncome: 300, netIncome: 250, shareholdersEquity: 800, price: 150, earningsPerShare: 10, totalDebt: 100, cashAndEquivalents: 500 },
  }, 'POST');
  const r = await request('/investment/scoring/SCOREME');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.categories).sort(), ['balanceSheet', 'growth', 'quality', 'risk', 'valuation']);
  assert.ok(r.body.categories.quality.factors.length > 0);
  assert.ok(r.body.disclaimer.length > 0);
  const serialized = JSON.stringify(r.body).toUpperCase();
  assert.equal(serialized.includes('"BUY"') || serialized.includes('"SELL"'), false);
});

test('scoring: risk category score is inverted correctly through the real API (high leverage -> low risk-score)', async () => {
  await request('/investment/financial-period', {
    symbol: 'RISKYCO', periodLabel: 'FY2025',
    data: { totalDebt: 10000, cashAndEquivalents: 10, price: 500, earningsPerShare: 5 }, // huge leverage, PE=100
  }, 'POST');
  const r = await request('/investment/scoring/RISKYCO');
  assert.equal(r.status, 200);
  assert.ok(r.body.categories.risk.score < 50); // high real-world risk -> low risk-score, per inversion contract
});

// ── Timeline / events endpoint ────────────────────────────────────────────

test('events: creating an event requires a valid research source for the same security', async () => {
  const r = await request('/investment/events', { symbol: 'AAPL', sourceId: 'does-not-exist', title: 'X' }, 'POST');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'source_not_found_for_security');
});

test('events: full flow — research produces a source, event references it, timeline reflects provenance', async () => {
  const research = await request('/investment/research', { symbol: 'EVTCO' }, 'POST');
  const sourceId = research.body.sources[0].id;

  const created = await request('/investment/events', {
    symbol: 'EVTCO', sourceId, eventDate: '2026-08-01', title: 'Q3 earnings beat expectations',
  }, 'POST');
  assert.equal(created.status, 201);
  assert.equal(created.body.event.type, 'earnings'); // classified automatically
  assert.equal(created.body.event.untrusted, true);
  assert.equal(created.body.event.source.url, 'https://example.com/filing');

  const timeline = await request('/investment/events/EVTCO');
  assert.equal(timeline.status, 200);
  assert.equal(timeline.body.dated.length, 1);
  assert.equal(timeline.body.dated[0].source.url, 'https://example.com/filing');
});

test('events: market interpretation without a basis is rejected by the route, never an unsourced causal claim', async () => {
  const research = await request('/investment/research', { symbol: 'NOBASIS' }, 'POST');
  const sourceId = research.body.sources[0].id;
  const r = await request('/investment/events', {
    symbol: 'NOBASIS', sourceId, eventDate: '2026-08-01', title: 'Earnings released',
    marketInterpretation: { statement: 'Stock jumped because of this' },
  }, 'POST');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'market_interpretation_requires_basis');
});

test('events: market interpretation with a basis is accepted and kept distinct from the event', async () => {
  const research = await request('/investment/research', { symbol: 'WITHBASIS' }, 'POST');
  const sourceId = research.body.sources[0].id;
  const r = await request('/investment/events', {
    symbol: 'WITHBASIS', sourceId, eventDate: '2026-08-01', title: 'Earnings released',
    marketInterpretation: { statement: 'Possible link to price move', basis: 'Same-day timing' },
  }, 'POST');
  assert.equal(r.status, 201);
  assert.equal(r.body.marketInterpretation.speculative, true);
  assert.notEqual(r.body.event, r.body.marketInterpretation);
});

test('events: event without a reliable date is excluded from the dated chronological list', async () => {
  const research = await request('/investment/research', { symbol: 'UNDATEDCO' }, 'POST');
  const sourceId = research.body.sources[0].id;
  await request('/investment/events', { symbol: 'UNDATEDCO', sourceId, title: 'Undated headline' }, 'POST');
  const timeline = await request('/investment/events/UNDATEDCO');
  assert.equal(timeline.body.dated.length, 0);
  assert.equal(timeline.body.undated.length, 1);
});

test('events: unknown symbol with no events returns empty timeline, never fabricated events', async () => {
  const r = await request('/investment/events/NEVERQUERIED');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.dated, []);
  assert.deepEqual(r.body.undated, []);
});
