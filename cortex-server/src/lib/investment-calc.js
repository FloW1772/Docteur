/**
 * Investment Agent — deterministic calculation library.
 *
 * Every function here is PURE (no I/O, no randomness, no LLM call) and
 * exhaustively unit-tested. This is the load-bearing rule for the whole
 * feature: the LLM interprets and explains these numbers, it never
 * computes or invents them. If a number appears in a report, it must have
 * come from one of these functions (or from user-entered raw data),
 * never from free-text model generation.
 *
 * Every function documents its formula in a comment directly above it, per
 * the mission requirement ("toujours documenter la formule utilisée").
 * Every function returns `null` (never NaN/Infinity/throws) when inputs
 * are insufficient or would produce a mathematically undefined result
 * (e.g. division by zero) — callers must treat `null` as "cannot be
 * computed from available data," never coerce it into a fake number.
 */

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// ---------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------

/**
 * CAGR = (endValue / startValue)^(1/years) - 1
 * Requires startValue > 0 (CAGR is undefined/meaningless from a
 * zero or negative base) and years > 0.
 */
export function calculateCagr({ startValue, endValue, years }) {
  if (!isFiniteNumber(startValue) || !isFiniteNumber(endValue) || !isFiniteNumber(years)) return null;
  if (startValue <= 0 || years <= 0) return null;
  return Math.pow(endValue / startValue, 1 / years) - 1;
}

// ---------------------------------------------------------------------
// Margins (all expressed as a fraction, e.g. 0.35 = 35%)
// ---------------------------------------------------------------------

/** Gross margin = (revenue - costOfGoodsSold) / revenue */
export function calculateGrossMargin({ revenue, costOfGoodsSold }) {
  if (!isFiniteNumber(revenue) || !isFiniteNumber(costOfGoodsSold) || revenue === 0) return null;
  return (revenue - costOfGoodsSold) / revenue;
}

/** Operating margin = operatingIncome / revenue */
export function calculateOperatingMargin({ revenue, operatingIncome }) {
  if (!isFiniteNumber(revenue) || !isFiniteNumber(operatingIncome) || revenue === 0) return null;
  return operatingIncome / revenue;
}

/** Net margin = netIncome / revenue */
export function calculateNetMargin({ revenue, netIncome }) {
  if (!isFiniteNumber(revenue) || !isFiniteNumber(netIncome) || revenue === 0) return null;
  return netIncome / revenue;
}

/** Free cash flow = operatingCashFlow - capex (capex entered as a positive outflow) */
export function calculateFreeCashFlow({ operatingCashFlow, capex }) {
  if (!isFiniteNumber(operatingCashFlow) || !isFiniteNumber(capex)) return null;
  return operatingCashFlow - capex;
}

/** FCF margin = freeCashFlow / revenue */
export function calculateFcfMargin({ freeCashFlow, revenue }) {
  if (!isFiniteNumber(freeCashFlow) || !isFiniteNumber(revenue) || revenue === 0) return null;
  return freeCashFlow / revenue;
}

// ---------------------------------------------------------------------
// Balance sheet / leverage
// ---------------------------------------------------------------------

/** Net debt = totalDebt - cashAndEquivalents (can be negative = net cash position) */
export function calculateNetDebt({ totalDebt, cashAndEquivalents }) {
  if (!isFiniteNumber(totalDebt) || !isFiniteNumber(cashAndEquivalents)) return null;
  return totalDebt - cashAndEquivalents;
}

/** Leverage (net debt / EBITDA) — a common covenant/risk ratio */
export function calculateLeverage({ netDebt, ebitda }) {
  if (!isFiniteNumber(netDebt) || !isFiniteNumber(ebitda) || ebitda === 0) return null;
  return netDebt / ebitda;
}

/** ROE = netIncome / shareholdersEquity */
export function calculateRoe({ netIncome, shareholdersEquity }) {
  if (!isFiniteNumber(netIncome) || !isFiniteNumber(shareholdersEquity) || shareholdersEquity === 0) return null;
  return netIncome / shareholdersEquity;
}

/** ROIC = NOPAT / investedCapital, where NOPAT = operatingIncome * (1 - taxRate) */
export function calculateRoic({ operatingIncome, taxRate, investedCapital }) {
  if (!isFiniteNumber(operatingIncome) || !isFiniteNumber(taxRate) || !isFiniteNumber(investedCapital)) return null;
  if (investedCapital === 0) return null;
  const nopat = operatingIncome * (1 - taxRate);
  return nopat / investedCapital;
}

/** Share dilution rate = (sharesEnd - sharesStart) / sharesStart */
export function calculateDilution({ sharesStart, sharesEnd }) {
  if (!isFiniteNumber(sharesStart) || !isFiniteNumber(sharesEnd) || sharesStart <= 0) return null;
  return (sharesEnd - sharesStart) / sharesStart;
}

// ---------------------------------------------------------------------
// Valuation multiples — each documents its exact formula
// ---------------------------------------------------------------------

/** P/E = price / earningsPerShare */
export function calculatePE({ price, earningsPerShare }) {
  if (!isFiniteNumber(price) || !isFiniteNumber(earningsPerShare) || earningsPerShare === 0) return null;
  return price / earningsPerShare;
}

/** Forward P/E = price / forwardEarningsPerShare (an ESTIMATE — caller must label as such) */
export function calculateForwardPE({ price, forwardEarningsPerShare }) {
  if (!isFiniteNumber(price) || !isFiniteNumber(forwardEarningsPerShare) || forwardEarningsPerShare === 0) return null;
  return price / forwardEarningsPerShare;
}

/** EV/Sales = enterpriseValue / revenue */
export function calculateEvToSales({ enterpriseValue, revenue }) {
  if (!isFiniteNumber(enterpriseValue) || !isFiniteNumber(revenue) || revenue === 0) return null;
  return enterpriseValue / revenue;
}

/** EV/EBITDA = enterpriseValue / ebitda */
export function calculateEvToEbitda({ enterpriseValue, ebitda }) {
  if (!isFiniteNumber(enterpriseValue) || !isFiniteNumber(ebitda) || ebitda === 0) return null;
  return enterpriseValue / ebitda;
}

/** P/FCF = marketCap / freeCashFlow */
export function calculatePFcf({ marketCap, freeCashFlow }) {
  if (!isFiniteNumber(marketCap) || !isFiniteNumber(freeCashFlow) || freeCashFlow === 0) return null;
  return marketCap / freeCashFlow;
}

/**
 * PEG = P/E / (earningsGrowthRate expressed as a percentage number, e.g.
 * 15 for 15%). Only meaningful when growth is positive — returns null
 * otherwise rather than a misleading negative/inverted PEG.
 */
export function calculatePeg({ pe, earningsGrowthRatePercent }) {
  if (!isFiniteNumber(pe) || !isFiniteNumber(earningsGrowthRatePercent) || earningsGrowthRatePercent <= 0) return null;
  return pe / earningsGrowthRatePercent;
}

// ---------------------------------------------------------------------
// Discounted Cash Flow (simplified) — always requires explicit
// assumptions; never a hidden default. See mission requirement 5:
// "Ne jamais donner une valorisation sans hypothèses visibles."
// ---------------------------------------------------------------------

/**
 * Simplified DCF: projects `baseFcf` forward `years` at `growthRate` per
 * year, discounts each year's FCF at `discountRate`, adds a terminal
 * value (Gordon growth: finalYearFcf * (1+terminalGrowthRate) / (discountRate
 * - terminalGrowthRate)) discounted back to present, sums to an enterprise
 * value estimate. Returns the full breakdown (never just a final number)
 * so hypotheses stay visible to the caller/UI.
 */
export function calculateDCF({ baseFcf, growthRate, discountRate, terminalGrowthRate, years }) {
  if (![baseFcf, growthRate, discountRate, terminalGrowthRate, years].every(isFiniteNumber)) return null;
  if (years <= 0 || !Number.isInteger(years)) return null;
  if (discountRate <= terminalGrowthRate) return null; // Gordon growth requires discountRate > terminalGrowthRate
  if (discountRate <= 0) return null;

  const projectedCashFlows = [];
  let fcf = baseFcf;
  let presentValueSum = 0;
  for (let year = 1; year <= years; year++) {
    fcf = fcf * (1 + growthRate);
    const discountFactor = 1 / Math.pow(1 + discountRate, year);
    const presentValue = fcf * discountFactor;
    projectedCashFlows.push({ year, fcf, discountFactor, presentValue });
    presentValueSum += presentValue;
  }

  const finalYearFcf = fcf;
  const terminalValue = (finalYearFcf * (1 + terminalGrowthRate)) / (discountRate - terminalGrowthRate);
  const terminalValueDiscountFactor = 1 / Math.pow(1 + discountRate, years);
  const presentValueOfTerminalValue = terminalValue * terminalValueDiscountFactor;

  return {
    assumptions: { baseFcf, growthRate, discountRate, terminalGrowthRate, years },
    projectedCashFlows,
    terminalValue,
    presentValueOfTerminalValue,
    sumOfDiscountedCashFlows: presentValueSum,
    enterpriseValueEstimate: presentValueSum + presentValueOfTerminalValue,
  };
}

/**
 * Reverse DCF: given a target enterprise value (typically the current
 * market EV) and all other DCF assumptions except growthRate, solves for
 * the implied growth rate the market is pricing in — via bisection search
 * (deterministic, bounded iterations, no external solver dependency).
 * Returns null if no growth rate in the search range reproduces the
 * target value (search bounds: -50% to +100% annual growth).
 */
export function calculateReverseDCF({ targetEnterpriseValue, baseFcf, discountRate, terminalGrowthRate, years }) {
  if (![targetEnterpriseValue, baseFcf, discountRate, terminalGrowthRate, years].every(isFiniteNumber)) return null;
  if (baseFcf <= 0) return null;

  let low = -0.5;
  let high = 1.0;
  const maxIterations = 100;
  const tolerance = targetEnterpriseValue * 1e-6 || 1e-6;

  const evAt = (growthRate) => {
    const result = calculateDCF({ baseFcf, growthRate, discountRate, terminalGrowthRate, years });
    return result ? result.enterpriseValueEstimate : null;
  };

  const evLow = evAt(low);
  const evHigh = evAt(high);
  if (evLow === null || evHigh === null) return null;
  // DCF's enterpriseValueEstimate is monotonically increasing in growthRate
  // for a fixed positive baseFcf — bisection is valid only if the target
  // lies within [evLow, evHigh].
  if (targetEnterpriseValue < evLow || targetEnterpriseValue > evHigh) return null;

  let mid = (low + high) / 2;
  for (let i = 0; i < maxIterations; i++) {
    mid = (low + high) / 2;
    const evMid = evAt(mid);
    if (evMid === null) return null;
    if (Math.abs(evMid - targetEnterpriseValue) < tolerance) break;
    if (evMid < targetEnterpriseValue) low = mid; else high = mid;
  }

  return { impliedGrowthRate: mid, iterations: maxIterations, assumptions: { targetEnterpriseValue, baseFcf, discountRate, terminalGrowthRate, years } };
}

// ---------------------------------------------------------------------
// Portfolio / performance metrics
// ---------------------------------------------------------------------

/** Simple return = (endValue - startValue) / startValue */
export function calculateReturn({ startValue, endValue }) {
  if (!isFiniteNumber(startValue) || !isFiniteNumber(endValue) || startValue === 0) return null;
  return (endValue - startValue) / startValue;
}

/**
 * Maximum drawdown over a series of portfolio values: the largest
 * peak-to-trough decline observed, expressed as a negative fraction
 * (e.g. -0.23 = a 23% drawdown from the running peak).
 */
export function calculateDrawdown({ values }) {
  if (!Array.isArray(values) || values.length === 0 || !values.every(isFiniteNumber)) return null;
  let peak = values[0];
  let maxDrawdown = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    if (peak > 0) {
      const drawdown = (value - peak) / peak;
      if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    }
  }
  return maxDrawdown;
}

/**
 * Sharpe ratio = (meanReturn - riskFreeRate) / stdDevOfReturns, computed
 * over a series of periodic returns (e.g. daily or monthly fractional
 * returns, not prices). riskFreeRate must be expressed in the SAME period
 * units as the returns (caller's responsibility — documented here rather
 * than silently annualizing, per "no hidden defaults" rule).
 */
export function calculateSharpe({ returns, riskFreeRate = 0 }) {
  if (!Array.isArray(returns) || returns.length < 2 || !returns.every(isFiniteNumber)) return null;
  if (!isFiniteNumber(riskFreeRate)) return null;
  const excessReturns = returns.map(r => r - riskFreeRate);
  const mean = excessReturns.reduce((sum, r) => sum + r, 0) / excessReturns.length;
  const variance = excessReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (excessReturns.length - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return null;
  return mean / stdDev;
}

/**
 * Position sizing via fixed-fractional risk: how many whole shares to buy
 * given a maximum dollar risk per trade and a stop-loss distance.
 * quantity = floor(riskAmount / perShareRisk), where
 * perShareRisk = entryPrice - stopLossPrice (must be > 0: a stop above
 * entry, or equal to entry, has no defined risk-based size).
 */
export function calculatePositionSize({ accountValue, riskPercentPerTrade, entryPrice, stopLossPrice }) {
  if (![accountValue, riskPercentPerTrade, entryPrice, stopLossPrice].every(isFiniteNumber)) return null;
  if (accountValue <= 0 || riskPercentPerTrade <= 0 || entryPrice <= 0) return null;
  const perShareRisk = entryPrice - stopLossPrice;
  if (perShareRisk <= 0) return null;
  const riskAmount = accountValue * riskPercentPerTrade;
  const quantity = Math.floor(riskAmount / perShareRisk);
  if (quantity <= 0) return null;
  return { quantity, riskAmount, perShareRisk, positionValue: quantity * entryPrice };
}

/**
 * Aggregate portfolio metrics from a list of positions, each
 * { symbol, quantity, avgCostBasis, currentPrice }. Never fetches prices
 * itself — currentPrice must already be supplied by the caller (paper
 * trading data, not a live feed).
 */
export function calculatePortfolioMetrics({ cash, positions }) {
  if (!isFiniteNumber(cash) || !Array.isArray(positions)) return null;
  let totalCostBasis = 0;
  let totalMarketValue = 0;
  const perPosition = [];

  for (const position of positions) {
    const { symbol, quantity, avgCostBasis, currentPrice } = position;
    if (!isFiniteNumber(quantity) || !isFiniteNumber(avgCostBasis) || !isFiniteNumber(currentPrice)) return null;
    const costBasis = quantity * avgCostBasis;
    const marketValue = quantity * currentPrice;
    const unrealizedPnl = marketValue - costBasis;
    const unrealizedPnlPercent = costBasis !== 0 ? unrealizedPnl / costBasis : null;
    totalCostBasis += costBasis;
    totalMarketValue += marketValue;
    perPosition.push({ symbol, quantity, costBasis, marketValue, unrealizedPnl, unrealizedPnlPercent });
  }

  const totalAccountValue = cash + totalMarketValue;
  const totalUnrealizedPnl = totalMarketValue - totalCostBasis;

  return {
    cash,
    totalCostBasis,
    totalMarketValue,
    totalAccountValue,
    totalUnrealizedPnl,
    totalUnrealizedPnlPercent: totalCostBasis !== 0 ? totalUnrealizedPnl / totalCostBasis : null,
    positions: perPosition,
    allocation: perPosition.map(p => ({
      symbol: p.symbol,
      weightPercent: totalAccountValue !== 0 ? p.marketValue / totalAccountValue : null,
    })),
  };
}
