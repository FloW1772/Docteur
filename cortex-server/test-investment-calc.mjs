import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCagr, calculateGrossMargin, calculateOperatingMargin, calculateNetMargin,
  calculateFreeCashFlow, calculateFcfMargin, calculateNetDebt, calculateLeverage,
  calculateRoe, calculateRoic, calculateDilution,
  calculatePE, calculateForwardPE, calculateEvToSales, calculateEvToEbitda, calculatePFcf, calculatePeg,
  calculateDCF, calculateReverseDCF,
  calculateReturn, calculateDrawdown, calculateSharpe, calculatePositionSize, calculatePortfolioMetrics,
} from './src/lib/investment-calc.js';

// ── Growth ──────────────────────────────────────────────────────────────

test('calculateCagr: standard growth', () => {
  const result = calculateCagr({ startValue: 100, endValue: 200, years: 5 });
  assert.ok(Math.abs(result - 0.1487) < 0.001);
});

test('calculateCagr: zero start value returns null (undefined base)', () => {
  assert.equal(calculateCagr({ startValue: 0, endValue: 200, years: 5 }), null);
});

test('calculateCagr: negative start value returns null', () => {
  assert.equal(calculateCagr({ startValue: -50, endValue: 200, years: 5 }), null);
});

test('calculateCagr: zero years returns null', () => {
  assert.equal(calculateCagr({ startValue: 100, endValue: 200, years: 0 }), null);
});

test('calculateCagr: missing input returns null', () => {
  assert.equal(calculateCagr({ startValue: 100, endValue: undefined, years: 5 }), null);
});

// ── Margins ─────────────────────────────────────────────────────────────

test('calculateGrossMargin: standard case', () => {
  assert.equal(calculateGrossMargin({ revenue: 1000, costOfGoodsSold: 600 }), 0.4);
});

test('calculateGrossMargin: zero revenue returns null', () => {
  assert.equal(calculateGrossMargin({ revenue: 0, costOfGoodsSold: 600 }), null);
});

test('calculateOperatingMargin: standard case', () => {
  assert.equal(calculateOperatingMargin({ revenue: 1000, operatingIncome: 150 }), 0.15);
});

test('calculateNetMargin: standard case', () => {
  assert.equal(calculateNetMargin({ revenue: 1000, netIncome: 80 }), 0.08);
});

test('calculateFreeCashFlow: standard case', () => {
  assert.equal(calculateFreeCashFlow({ operatingCashFlow: 500, capex: 120 }), 380);
});

test('calculateFcfMargin: zero revenue returns null', () => {
  assert.equal(calculateFcfMargin({ freeCashFlow: 380, revenue: 0 }), null);
});

// ── Balance sheet ───────────────────────────────────────────────────────

test('calculateNetDebt: net cash position (negative)', () => {
  assert.equal(calculateNetDebt({ totalDebt: 100, cashAndEquivalents: 300 }), -200);
});

test('calculateLeverage: zero EBITDA returns null', () => {
  assert.equal(calculateLeverage({ netDebt: 500, ebitda: 0 }), null);
});

test('calculateRoe: zero equity returns null', () => {
  assert.equal(calculateRoe({ netIncome: 50, shareholdersEquity: 0 }), null);
});

test('calculateRoic: standard case with tax', () => {
  const result = calculateRoic({ operatingIncome: 200, taxRate: 0.25, investedCapital: 1000 });
  assert.equal(result, 0.15); // NOPAT = 150, / 1000 = 0.15
});

test('calculateDilution: share count increase', () => {
  const result = calculateDilution({ sharesStart: 1000, sharesEnd: 1050 });
  assert.ok(Math.abs(result - 0.05) < 1e-9);
});

test('calculateDilution: zero starting shares returns null', () => {
  assert.equal(calculateDilution({ sharesStart: 0, sharesEnd: 1050 }), null);
});

// ── Valuation multiples ─────────────────────────────────────────────────

test('calculatePE: standard case', () => {
  assert.equal(calculatePE({ price: 150, earningsPerShare: 10 }), 15);
});

test('calculatePE: zero EPS returns null (denominator zero — explicit test per mission)', () => {
  assert.equal(calculatePE({ price: 150, earningsPerShare: 0 }), null);
});

test('calculateForwardPE: standard case', () => {
  assert.equal(calculateForwardPE({ price: 150, forwardEarningsPerShare: 12 }), 12.5);
});

test('calculateEvToSales: standard case', () => {
  assert.equal(calculateEvToSales({ enterpriseValue: 5000, revenue: 1000 }), 5);
});

test('calculateEvToEbitda: zero EBITDA returns null', () => {
  assert.equal(calculateEvToEbitda({ enterpriseValue: 5000, ebitda: 0 }), null);
});

test('calculatePFcf: standard case', () => {
  assert.equal(calculatePFcf({ marketCap: 10000, freeCashFlow: 500 }), 20);
});

test('calculatePeg: standard case', () => {
  const result = calculatePeg({ pe: 30, earningsGrowthRatePercent: 15 });
  assert.equal(result, 2);
});

test('calculatePeg: negative growth returns null (not a meaningful PEG)', () => {
  assert.equal(calculatePeg({ pe: 30, earningsGrowthRatePercent: -5 }), null);
});

// ── DCF ─────────────────────────────────────────────────────────────────

test('calculateDCF: produces full breakdown with visible assumptions', () => {
  const result = calculateDCF({ baseFcf: 100, growthRate: 0.08, discountRate: 0.10, terminalGrowthRate: 0.02, years: 5 });
  assert.ok(result !== null);
  assert.deepEqual(result.assumptions, { baseFcf: 100, growthRate: 0.08, discountRate: 0.10, terminalGrowthRate: 0.02, years: 5 });
  assert.equal(result.projectedCashFlows.length, 5);
  assert.ok(result.enterpriseValueEstimate > 0);
  assert.ok(result.presentValueOfTerminalValue > 0);
});

test('calculateDCF: invalid inputs (discountRate <= terminalGrowthRate) returns null', () => {
  assert.equal(calculateDCF({ baseFcf: 100, growthRate: 0.08, discountRate: 0.02, terminalGrowthRate: 0.02, years: 5 }), null);
});

test('calculateDCF: negative discount rate returns null', () => {
  assert.equal(calculateDCF({ baseFcf: 100, growthRate: 0.08, discountRate: -0.01, terminalGrowthRate: 0.02, years: 5 }), null);
});

test('calculateDCF: non-integer years returns null', () => {
  assert.equal(calculateDCF({ baseFcf: 100, growthRate: 0.08, discountRate: 0.10, terminalGrowthRate: 0.02, years: 5.5 }), null);
});

test('calculateDCF: missing input returns null', () => {
  assert.equal(calculateDCF({ baseFcf: 100, growthRate: 0.08, discountRate: 0.10, terminalGrowthRate: 0.02, years: undefined }), null);
});

test('calculateReverseDCF: recovers a growth rate whose DCF matches the target EV', () => {
  const forward = calculateDCF({ baseFcf: 100, growthRate: 0.12, discountRate: 0.10, terminalGrowthRate: 0.02, years: 5 });
  const reverse = calculateReverseDCF({
    targetEnterpriseValue: forward.enterpriseValueEstimate,
    baseFcf: 100, discountRate: 0.10, terminalGrowthRate: 0.02, years: 5,
  });
  assert.ok(reverse !== null);
  assert.ok(Math.abs(reverse.impliedGrowthRate - 0.12) < 0.001);
});

test('calculateReverseDCF: target outside search bounds returns null', () => {
  const result = calculateReverseDCF({
    targetEnterpriseValue: 1e12, // absurdly high, outside [-50%,+100%] growth range
    baseFcf: 100, discountRate: 0.10, terminalGrowthRate: 0.02, years: 5,
  });
  assert.equal(result, null);
});

test('calculateReverseDCF: non-positive baseFcf returns null', () => {
  assert.equal(calculateReverseDCF({ targetEnterpriseValue: 1000, baseFcf: 0, discountRate: 0.1, terminalGrowthRate: 0.02, years: 5 }), null);
});

// ── Portfolio / performance ─────────────────────────────────────────────

test('calculateReturn: standard case', () => {
  assert.equal(calculateReturn({ startValue: 100, endValue: 120 }), 0.2);
});

test('calculateReturn: zero start value returns null', () => {
  assert.equal(calculateReturn({ startValue: 0, endValue: 120 }), null);
});

test('calculateDrawdown: standard peak-to-trough sequence', () => {
  const result = calculateDrawdown({ values: [100, 120, 90, 110, 80, 130] });
  // Peak 120 -> trough 80 => (80-120)/120 = -0.3333...
  assert.ok(Math.abs(result - (-1 / 3)) < 1e-9);
});

test('calculateDrawdown: monotonically increasing series has zero drawdown', () => {
  assert.equal(calculateDrawdown({ values: [100, 110, 120, 130] }), 0);
});

test('calculateDrawdown: empty array returns null', () => {
  assert.equal(calculateDrawdown({ values: [] }), null);
});

test('calculateSharpe: standard case', () => {
  const result = calculateSharpe({ returns: [0.02, 0.01, -0.01, 0.03, 0.00], riskFreeRate: 0.001 });
  assert.ok(result !== null);
  assert.ok(typeof result === 'number');
});

test('calculateSharpe: zero standard deviation (constant returns) returns null', () => {
  assert.equal(calculateSharpe({ returns: [0.01, 0.01, 0.01], riskFreeRate: 0 }), null);
});

test('calculateSharpe: fewer than 2 returns returns null', () => {
  assert.equal(calculateSharpe({ returns: [0.01] }), null);
});

test('calculatePositionSize: standard fixed-fractional sizing', () => {
  const result = calculatePositionSize({ accountValue: 10000, riskPercentPerTrade: 0.01, entryPrice: 50, stopLossPrice: 45 });
  // riskAmount = 100, perShareRisk = 5, quantity = floor(100/5) = 20
  assert.deepEqual(result, { quantity: 20, riskAmount: 100, perShareRisk: 5, positionValue: 1000 });
});

test('calculatePositionSize: stop-loss at or above entry returns null (undefined risk)', () => {
  assert.equal(calculatePositionSize({ accountValue: 10000, riskPercentPerTrade: 0.01, entryPrice: 50, stopLossPrice: 50 }), null);
  assert.equal(calculatePositionSize({ accountValue: 10000, riskPercentPerTrade: 0.01, entryPrice: 50, stopLossPrice: 55 }), null);
});

test('calculatePositionSize: risk amount too small for even 1 share returns null', () => {
  assert.equal(calculatePositionSize({ accountValue: 100, riskPercentPerTrade: 0.001, entryPrice: 50, stopLossPrice: 45 }), null);
});

test('calculatePortfolioMetrics: aggregates cash + positions correctly', () => {
  const result = calculatePortfolioMetrics({
    cash: 5000,
    positions: [
      { symbol: 'AAA', quantity: 10, avgCostBasis: 100, currentPrice: 120 },
      { symbol: 'BBB', quantity: 5, avgCostBasis: 200, currentPrice: 180 },
    ],
  });
  assert.equal(result.totalCostBasis, 1000 + 1000);
  assert.equal(result.totalMarketValue, 1200 + 900);
  assert.equal(result.totalAccountValue, 5000 + 1200 + 900);
  assert.equal(result.totalUnrealizedPnl, (1200 - 1000) + (900 - 1000));
  assert.equal(result.positions.length, 2);
  assert.equal(result.allocation.length, 2);
});

test('calculatePortfolioMetrics: empty positions returns cash-only metrics', () => {
  const result = calculatePortfolioMetrics({ cash: 1000, positions: [] });
  assert.equal(result.totalAccountValue, 1000);
  assert.equal(result.totalUnrealizedPnlPercent, null); // 0 cost basis -> null, never divide by zero
});

test('calculatePortfolioMetrics: malformed position entry returns null (never silently skip bad data)', () => {
  const result = calculatePortfolioMetrics({
    cash: 1000,
    positions: [{ symbol: 'AAA', quantity: 'ten', avgCostBasis: 100, currentPrice: 120 }],
  });
  assert.equal(result, null);
});
