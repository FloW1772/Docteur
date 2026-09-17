/**
 * Investment Agent — transparent, deterministic scoring.
 *
 * PURE functions only (no LLM call, no randomness). Every sub-score
 * exposes its inputs, its exact rule, and the positive/negative factors
 * that produced it — never an opaque number. This module NEVER outputs
 * BUY/SELL/STRONG BUY/STRONG SELL; scoring only structures the analysis
 * (mission requirement 7).
 *
 * Scoring scale: each factor contributes -1 (negative), 0 (neutral/no
 * data), or +1 (positive) to its category. A category score is the sum of
 * its factor contributions, normalized to a 0-100 scale via
 * (sum + factorCount) / (2 * factorCount) * 100 — so "all factors
 * negative" = 0, "all neutral/missing" = 50, "all positive" = 100. This
 * keeps the arithmetic auditable: nothing here is a weighted black box.
 *
 * Missing data is never invented: a factor with insufficient inputs
 * contributes 0 (neutral) AND is listed in `missingData`, so a 50/100
 * score built entirely from missing data is clearly distinguishable from
 * a genuinely neutral one by reading `missingData`.
 */

import {
  calculateGrossMargin, calculateOperatingMargin, calculateNetMargin,
  calculateRoe, calculateRoic, calculateFreeCashFlow, calculateFcfMargin,
  calculateCagr, calculateNetDebt, calculateLeverage, calculateDilution,
  calculatePE, calculateEvToEbitda, calculatePeg,
} from './investment-calc.js';

function factor({ id, label, value, positiveWhen, dataAvailable, note = '' }) {
  if (!dataAvailable) {
    return { id, label, contribution: 0, status: 'insufficient_data', value: null, note };
  }
  const isPositive = positiveWhen(value);
  return { id, label, contribution: isPositive ? 1 : -1, status: isPositive ? 'positive' : 'negative', value, note };
}

function summarizeCategory(categoryName, factors) {
  const available = factors.filter(f => f.status !== 'insufficient_data');
  const missing = factors.filter(f => f.status === 'insufficient_data').map(f => f.id);
  // Score is computed ONLY over available factors — a missing factor must
  // never silently pull the score toward 50 by being counted as neutral in
  // the denominator (that would make "3 of 10 factors known, all bad"
  // look artificially better than it is). `dataCompleteness` below is what
  // tells a caller how much of the category was actually evaluable.
  const sum = available.reduce((acc, f) => acc + f.contribution, 0);
  const score = available.length === 0 ? 50 : Math.round(((sum + available.length) / (2 * available.length)) * 100);

  return {
    category: categoryName,
    score, // 0-100, or null if the category has zero factors at all
    dataCompleteness: factors.length === 0 ? 0 : available.length / factors.length,
    positiveFactors: factors.filter(f => f.status === 'positive').map(f => ({ id: f.id, label: f.label, value: f.value })),
    negativeFactors: factors.filter(f => f.status === 'negative').map(f => ({ id: f.id, label: f.label, value: f.value })),
    missingData: missing,
    factors, // full detail — formula/rule is documented per-factor via `label`/`note`
  };
}

/**
 * Quality: profitability and capital efficiency. Higher margins and
 * returns on capital are treated as positive quality signals.
 */
export function scoreQuality({ latestPeriodData = {}, taxRate = 0.25, investedCapital } = {}) {
  const d = latestPeriodData;
  const grossMargin = calculateGrossMargin({ revenue: d.revenue, costOfGoodsSold: d.costOfGoodsSold });
  const operatingMargin = calculateOperatingMargin({ revenue: d.revenue, operatingIncome: d.operatingIncome });
  const roe = calculateRoe({ netIncome: d.netIncome, shareholdersEquity: d.shareholdersEquity });
  const roic = investedCapital != null
    ? calculateRoic({ operatingIncome: d.operatingIncome, taxRate, investedCapital })
    : null;

  const factors = [
    factor({ id: 'gross_margin', label: 'Marge brute > 30 % (règle: (revenue - COGS) / revenue)', value: grossMargin, dataAvailable: grossMargin !== null, positiveWhen: v => v > 0.30 }),
    factor({ id: 'operating_margin', label: 'Marge opérationnelle > 10 % (règle: operatingIncome / revenue)', value: operatingMargin, dataAvailable: operatingMargin !== null, positiveWhen: v => v > 0.10 }),
    factor({ id: 'roe', label: 'ROE > 12 % (règle: netIncome / shareholdersEquity)', value: roe, dataAvailable: roe !== null, positiveWhen: v => v > 0.12 }),
    factor({ id: 'roic', label: 'ROIC > coût du capital supposé 8 % (règle: NOPAT / investedCapital)', value: roic, dataAvailable: roic !== null, positiveWhen: v => v > 0.08, note: investedCapital == null ? 'investedCapital non fourni' : '' }),
  ];
  return summarizeCategory('Quality', factors);
}

/**
 * Growth: revenue trajectory across the periods supplied. Requires at
 * least 2 periods to compute a CAGR; otherwise the factor is
 * insufficient_data rather than a fabricated flat 0% growth.
 */
export function scoreGrowth({ periods = [] } = {}) {
  let revenueCagr = null;
  if (periods.length >= 2) {
    const first = periods[0];
    const last = periods[periods.length - 1];
    revenueCagr = calculateCagr({ startValue: first.revenue, endValue: last.revenue, years: periods.length - 1 });
  }

  const latest = periods[periods.length - 1] ?? {};
  const previous = periods[periods.length - 2] ?? {};
  let fcfGrowthPositive = null;
  const latestFcf = calculateFreeCashFlow({ operatingCashFlow: latest.operatingCashFlow, capex: latest.capex });
  const previousFcf = calculateFreeCashFlow({ operatingCashFlow: previous.operatingCashFlow, capex: previous.capex });
  if (latestFcf !== null && previousFcf !== null) fcfGrowthPositive = latestFcf > previousFcf;

  const factors = [
    factor({ id: 'revenue_cagr', label: 'CAGR revenus > 5 % sur la période disponible (règle: (end/start)^(1/years)-1)', value: revenueCagr, dataAvailable: revenueCagr !== null, positiveWhen: v => v > 0.05, note: periods.length < 2 ? 'moins de 2 périodes fournies' : '' }),
    factor({ id: 'fcf_trend', label: 'Free cash flow en hausse vs période précédente', value: fcfGrowthPositive, dataAvailable: fcfGrowthPositive !== null, positiveWhen: v => v === true }),
  ];
  return summarizeCategory('Growth', factors);
}

/**
 * Valuation: cheaper multiples (relative to fixed, documented thresholds
 * — never a peer-relative comparison invented on the fly) are treated as
 * positive. These thresholds are intentionally simple and stated
 * explicitly so a user can disagree with them without guessing the rule.
 */
export function scoreValuation({ price, earningsPerShare, enterpriseValue, ebitda, earningsGrowthRatePercent } = {}) {
  const pe = calculatePE({ price, earningsPerShare });
  const evToEbitda = calculateEvToEbitda({ enterpriseValue, ebitda });
  const peg = pe !== null && earningsGrowthRatePercent != null ? calculatePeg({ pe, earningsGrowthRatePercent }) : null;

  const factors = [
    factor({ id: 'pe', label: 'P/E < 25 (règle: price / earningsPerShare)', value: pe, dataAvailable: pe !== null, positiveWhen: v => v > 0 && v < 25 }),
    factor({ id: 'ev_ebitda', label: 'EV/EBITDA < 15 (règle: enterpriseValue / ebitda)', value: evToEbitda, dataAvailable: evToEbitda !== null, positiveWhen: v => v > 0 && v < 15 }),
    factor({ id: 'peg', label: 'PEG < 1.5 (règle: PE / croissance% des bénéfices)', value: peg, dataAvailable: peg !== null, positiveWhen: v => v < 1.5 }),
  ];
  return summarizeCategory('Valuation', factors);
}

/**
 * Balance Sheet: leverage and dilution. Lower leverage and lower dilution
 * are positive signals.
 */
export function scoreBalanceSheet({ latestPeriodData = {}, ebitda, sharesStart, sharesEnd } = {}) {
  const d = latestPeriodData;
  const netDebt = calculateNetDebt({ totalDebt: d.totalDebt, cashAndEquivalents: d.cashAndEquivalents });
  const leverage = netDebt !== null && ebitda != null ? calculateLeverage({ netDebt, ebitda }) : null;
  const dilution = sharesStart != null && sharesEnd != null ? calculateDilution({ sharesStart, sharesEnd }) : null;

  const factors = [
    factor({ id: 'net_debt', label: 'Position de cash nette ou dette nette faible (netDebt <= 0)', value: netDebt, dataAvailable: netDebt !== null, positiveWhen: v => v <= 0 }),
    factor({ id: 'leverage', label: 'Levier net/EBITDA < 3x (règle: netDebt / ebitda)', value: leverage, dataAvailable: leverage !== null, positiveWhen: v => v < 3 }),
    factor({ id: 'dilution', label: 'Dilution actionnariale < 2 % (règle: (sharesEnd - sharesStart) / sharesStart)', value: dilution, dataAvailable: dilution !== null, positiveWhen: v => v < 0.02 }),
  ];
  return summarizeCategory('Balance Sheet', factors);
}

/**
 * Risk: HIGHER risk factor values are NEGATIVE for the score (inverted
 * relative to the other categories — mission explicitly requires testing
 * that this inversion is correct). A high concentration/leverage/
 * valuation-multiple is a risk, so it contributes -1, not +1.
 */
export function scoreRisk({ customerConcentrationPercent, leverage, pe, cyclicalIndustry } = {}) {
  const factors = [
    factor({ id: 'customer_concentration', label: 'Concentration client < 20 % du CA (règle: % CA du plus gros client)', value: customerConcentrationPercent, dataAvailable: customerConcentrationPercent != null, positiveWhen: v => v < 20 }),
    factor({ id: 'leverage_risk', label: 'Levier net/EBITDA < 4x (au-delà = risque de solvabilité)', value: leverage, dataAvailable: leverage != null, positiveWhen: v => v < 4 }),
    factor({ id: 'valuation_risk', label: 'P/E < 40 (au-delà = risque de correction en cas de déception)', value: pe, dataAvailable: pe != null, positiveWhen: v => v > 0 && v < 40 }),
    factor({ id: 'cyclicality', label: 'Secteur non cyclique', value: cyclicalIndustry, dataAvailable: cyclicalIndustry != null, positiveWhen: v => v === false }),
  ];
  // Note: for this category a HIGH score (100) means LOW risk — documented
  // explicitly in the returned object's `scoreMeaning` field so a caller
  // never has to guess the direction.
  const result = summarizeCategory('Risk', factors);
  return { ...result, scoreMeaning: 'Score élevé = risque perçu FAIBLE (facteurs de risque inversés par construction).' };
}

/**
 * Aggregates all 5 categories into one transparent report. Deliberately
 * does NOT compute a single overall number or a BUY/SELL label — mission
 * requirement 7 explicitly forbids collapsing this into an opaque
 * recommendation. Callers display the 5 category scores side by side.
 */
export function scoreInvestment(input = {}) {
  const quality = scoreQuality(input.quality ?? {});
  const growth = scoreGrowth(input.growth ?? {});
  const valuation = scoreValuation(input.valuation ?? {});
  const balanceSheet = scoreBalanceSheet(input.balanceSheet ?? {});
  const risk = scoreRisk(input.risk ?? {});

  return {
    generatedAt: new Date().toISOString(),
    categories: { quality, growth, valuation, balanceSheet, risk },
    disclaimer: 'Scoring analytique structurant l\'analyse — ne constitue jamais une recommandation d\'achat ou de vente. Les données manquantes sont listées explicitement, jamais inventées.',
  };
}
