import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreQuality, scoreGrowth, scoreValuation, scoreBalanceSheet, scoreRisk, scoreInvestment } from './src/lib/investment-scoring.js';

// ── Quality ─────────────────────────────────────────────────────────────

test('scoreQuality: complete data with all-positive factors scores 100 (score computed over available factors only)', () => {
  const result = scoreQuality({
    latestPeriodData: { revenue: 1000, costOfGoodsSold: 500, operatingIncome: 200, netIncome: 150, shareholdersEquity: 500 },
  });
  assert.equal(result.category, 'Quality');
  assert.equal(result.score, 100); // 3 available factors all positive; roic missing (no investedCapital) is excluded from the denominator, not counted as neutral
  assert.equal(result.missingData.includes('roic'), true);
  assert.equal(result.dataCompleteness, 0.75); // 3 of 4 factors evaluable
  assert.equal(result.positiveFactors.length, 3);
  assert.equal(result.negativeFactors.length, 0);
});

test('scoreQuality: complete data including investedCapital, all factors positive -> 100', () => {
  const result = scoreQuality({
    latestPeriodData: { revenue: 1000, costOfGoodsSold: 500, operatingIncome: 200, netIncome: 150, shareholdersEquity: 500 },
    investedCapital: 1000,
  });
  assert.equal(result.score, 100);
  assert.equal(result.missingData.length, 0);
  assert.equal(result.dataCompleteness, 1);
});

test('scoreQuality: fully missing data returns neutral score with all factors flagged insufficient_data', () => {
  const result = scoreQuality({ latestPeriodData: {} });
  assert.equal(result.score, 50); // neutral, not fabricated
  assert.equal(result.missingData.length, 4); // gross_margin, operating_margin, roe, roic
  assert.equal(result.positiveFactors.length, 0);
  assert.equal(result.negativeFactors.length, 0);
});

test('scoreQuality: zero-revenue denominator handled as insufficient_data, not a crash', () => {
  const result = scoreQuality({ latestPeriodData: { revenue: 0, costOfGoodsSold: 500, operatingIncome: 200, netIncome: 150, shareholdersEquity: 500 } });
  assert.equal(result.factors.find(f => f.id === 'gross_margin').status, 'insufficient_data');
  assert.equal(result.factors.find(f => f.id === 'operating_margin').status, 'insufficient_data');
});

test('scoreQuality: extreme negative values scored as negative factors, never crash', () => {
  const result = scoreQuality({ latestPeriodData: { revenue: 1000, costOfGoodsSold: 5000, operatingIncome: -900, netIncome: -900, shareholdersEquity: 100 } });
  assert.equal(result.negativeFactors.length, 3); // gross_margin, operating_margin, roe all negative
  assert.equal(result.score, 0); // all 3 available factors negative -> lowest possible score
});

test('scoreQuality: contradictory metrics (great margin, terrible ROE) reflected per-factor, not averaged away', () => {
  const result = scoreQuality({ latestPeriodData: { revenue: 1000, costOfGoodsSold: 100, operatingIncome: 800, netIncome: -50, shareholdersEquity: 500 } });
  assert.equal(result.factors.find(f => f.id === 'gross_margin').status, 'positive');
  assert.equal(result.factors.find(f => f.id === 'roe').status, 'negative');
});

// ── Growth ──────────────────────────────────────────────────────────────

test('scoreGrowth: fewer than 2 periods returns insufficient_data for CAGR, not a fabricated 0%', () => {
  const result = scoreGrowth({ periods: [{ revenue: 1000 }] });
  assert.equal(result.factors.find(f => f.id === 'revenue_cagr').status, 'insufficient_data');
});

test('scoreGrowth: strong revenue growth across periods scores positive', () => {
  const result = scoreGrowth({ periods: [{ revenue: 1000, operatingCashFlow: 100, capex: 20 }, { revenue: 2000, operatingCashFlow: 300, capex: 30 }] });
  assert.equal(result.factors.find(f => f.id === 'revenue_cagr').status, 'positive');
  assert.equal(result.factors.find(f => f.id === 'fcf_trend').status, 'positive');
});

test('scoreGrowth: declining revenue scores negative', () => {
  const result = scoreGrowth({ periods: [{ revenue: 2000 }, { revenue: 1000 }] });
  assert.equal(result.factors.find(f => f.id === 'revenue_cagr').status, 'negative');
});

test('scoreGrowth: empty periods array returns fully insufficient_data', () => {
  const result = scoreGrowth({ periods: [] });
  assert.equal(result.factors.every(f => f.status === 'insufficient_data'), true);
});

// ── Valuation ───────────────────────────────────────────────────────────

test('scoreValuation: zero EPS denominator returns insufficient_data for P/E and PEG, not Infinity', () => {
  const result = scoreValuation({ price: 100, earningsPerShare: 0, enterpriseValue: 5000, ebitda: 500 });
  assert.equal(result.factors.find(f => f.id === 'pe').status, 'insufficient_data');
  assert.equal(result.factors.find(f => f.id === 'peg').status, 'insufficient_data');
});

test('scoreValuation: cheap multiples score positive', () => {
  const result = scoreValuation({ price: 100, earningsPerShare: 10, enterpriseValue: 3000, ebitda: 500, earningsGrowthRatePercent: 20 });
  assert.equal(result.factors.find(f => f.id === 'pe').status, 'positive'); // PE=10 < 25
  assert.equal(result.factors.find(f => f.id === 'ev_ebitda').status, 'positive'); // 6 < 15
  assert.equal(result.factors.find(f => f.id === 'peg').status, 'positive'); // 10/20=0.5 < 1.5
});

test('scoreValuation: expensive multiples score negative', () => {
  const result = scoreValuation({ price: 1000, earningsPerShare: 10, enterpriseValue: 20000, ebitda: 500 });
  assert.equal(result.factors.find(f => f.id === 'pe').status, 'negative'); // PE=100
  assert.equal(result.factors.find(f => f.id === 'ev_ebitda').status, 'negative'); // 40
});

test('scoreValuation: negative earnings (negative P/E) is not silently treated as cheap', () => {
  const result = scoreValuation({ price: 100, earningsPerShare: -5, enterpriseValue: 5000, ebitda: 500 });
  assert.equal(result.factors.find(f => f.id === 'pe').status, 'negative'); // -20 is not in (0,25)
});

// ── Balance Sheet ───────────────────────────────────────────────────────

test('scoreBalanceSheet: net cash position and low dilution score positive', () => {
  const result = scoreBalanceSheet({
    latestPeriodData: { totalDebt: 100, cashAndEquivalents: 500 }, ebitda: 200, sharesStart: 1000, sharesEnd: 1005,
  });
  assert.equal(result.factors.find(f => f.id === 'net_debt').status, 'positive');
  assert.equal(result.factors.find(f => f.id === 'leverage').status, 'positive');
  assert.equal(result.factors.find(f => f.id === 'dilution').status, 'positive');
});

test('scoreBalanceSheet: high leverage and heavy dilution score negative', () => {
  const result = scoreBalanceSheet({
    latestPeriodData: { totalDebt: 5000, cashAndEquivalents: 100 }, ebitda: 200, sharesStart: 1000, sharesEnd: 1300,
  });
  assert.equal(result.factors.find(f => f.id === 'net_debt').status, 'negative');
  assert.equal(result.factors.find(f => f.id === 'leverage').status, 'negative');
  assert.equal(result.factors.find(f => f.id === 'dilution').status, 'negative');
});

test('scoreBalanceSheet: zero ebitda denominator handled without crash', () => {
  const result = scoreBalanceSheet({ latestPeriodData: { totalDebt: 100, cashAndEquivalents: 50 }, ebitda: 0 });
  assert.equal(result.factors.find(f => f.id === 'leverage').status, 'insufficient_data');
});

test('scoreBalanceSheet: missing shares data returns insufficient_data for dilution', () => {
  const result = scoreBalanceSheet({ latestPeriodData: { totalDebt: 100, cashAndEquivalents: 50 } });
  assert.equal(result.factors.find(f => f.id === 'dilution').status, 'insufficient_data');
});

// ── Risk — inversion correctness is explicitly required by the mission ──

test('scoreRisk: HIGH risk inputs produce a LOW risk-score (inverted correctly)', () => {
  const result = scoreRisk({ customerConcentrationPercent: 60, leverage: 8, pe: 90, cyclicalIndustry: true });
  assert.equal(result.factors.every(f => f.status === 'negative'), true);
  assert.equal(result.score, 0); // all factors negative -> lowest score -> means highest actual risk
  assert.ok(result.scoreMeaning.includes('FAIBLE') === false || result.scoreMeaning.includes('risque'));
});

test('scoreRisk: LOW risk inputs produce a HIGH risk-score (inverted correctly)', () => {
  const result = scoreRisk({ customerConcentrationPercent: 5, leverage: 0.5, pe: 15, cyclicalIndustry: false });
  assert.equal(result.factors.every(f => f.status === 'positive'), true);
  assert.equal(result.score, 100); // all factors positive -> low actual risk
});

test('scoreRisk: scoreMeaning field always documents the inversion so callers cannot misread direction', () => {
  const result = scoreRisk({});
  assert.match(result.scoreMeaning, /risque perçu FAIBLE/);
});

test('scoreRisk: fully missing inputs returns neutral 50, not fabricated risk assessment', () => {
  const result = scoreRisk({});
  assert.equal(result.score, 50);
  assert.equal(result.missingData.length, 4);
});

// ── Aggregate ───────────────────────────────────────────────────────────

test('scoreInvestment: never produces a BUY/SELL recommendation field', () => {
  const result = scoreInvestment({});
  const serialized = JSON.stringify(result).toUpperCase();
  assert.equal(serialized.includes('"BUY"'), false);
  assert.equal(serialized.includes('"SELL"'), false);
  assert.equal(serialized.includes('STRONG BUY'), false);
  assert.equal(serialized.includes('STRONG SELL'), false);
});

test('scoreInvestment: aggregates all 5 categories', () => {
  const result = scoreInvestment({
    quality: { latestPeriodData: { revenue: 1000, netIncome: 100 } },
    growth: { periods: [{ revenue: 500 }, { revenue: 600 }] },
    valuation: { price: 100, earningsPerShare: 5 },
    balanceSheet: { latestPeriodData: { totalDebt: 10, cashAndEquivalents: 100 } },
    risk: { pe: 20 },
  });
  assert.deepEqual(Object.keys(result.categories).sort(), ['balanceSheet', 'growth', 'quality', 'risk', 'valuation']);
  assert.ok(result.disclaimer.length > 0);
  assert.ok(result.generatedAt);
});

test('scoreInvestment: fully empty input never throws, returns neutral scores throughout', () => {
  const result = scoreInvestment();
  for (const category of Object.values(result.categories)) {
    assert.equal(category.score, 50);
  }
});
