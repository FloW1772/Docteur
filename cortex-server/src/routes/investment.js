import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { searchDuckDuckGo } from '../lib/web-search.js';
import { extractContent } from '../lib/deep-capture.js';
import { assertSafeUrl } from '../lib/url-security.js';
import {
  authorizePaperAction, validateSymbol, validateSymbolList, validatePositiveNumber,
  validateDataRecency, wrapUntrustedContent, denied,
} from '../lib/investment-policy.js';
import * as db from '../lib/sqlite.js';
import {
  calculateCagr, calculateGrossMargin, calculateOperatingMargin, calculateNetMargin,
  calculateFreeCashFlow, calculateFcfMargin, calculateNetDebt, calculateLeverage,
  calculateRoe, calculateRoic, calculateDilution,
  calculatePE, calculateForwardPE, calculateEvToSales, calculateEvToEbitda, calculatePFcf, calculatePeg,
  calculateDCF, calculateReverseDCF, calculatePortfolioMetrics,
} from '../lib/investment-calc.js';
import { scoreInvestment } from '../lib/investment-scoring.js';
import { buildTimeline, buildTimelineEvent, attachMarketInterpretation } from '../lib/investment-timeline.js';

// Investment Agent V1 — analysis + research + PAPER TRADING ONLY.
// No route here accepts REAL_BUY/REAL_SELL/LIVE_ORDER, no broker
// credentials are ever read/exposed here, and every calculation is
// delegated to the deterministic investment-calc.js library — this file
// never lets an LLM compute a number, only interpret one already computed.

const MAX_RESEARCH_PAGES = 3;
const PAGE_TIMEOUT_MS = 10_000;

function securityIdForSymbol(symbol) {
  // Deterministic id derived from the symbol so repeated research on the
  // same ticker reuses the same security row instead of duplicating it.
  return `sec-${symbol.toLowerCase()}`;
}

export function createInvestmentRoute({
  services, logger,
  search = searchDuckDuckGo, fetchContent = extractContent, checkUrl = assertSafeUrl,
} = {}) {
  const route = new Hono();

  // ── researchCompany(symbol) — web research, sources recorded with provenance ──
  route.post('/investment/research', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    let symbol;
    try { symbol = validateSymbol(body.symbol); } catch (err) { return c.json({ error: err.code }, 400); }

    const securityId = securityIdForSymbol(symbol);
    db.upsertSecurity({ id: securityId, symbol, name: body.name || '' });

    let ddgResults;
    try {
      ddgResults = await search(`${symbol} stock financial results filing`);
    } catch (err) {
      logger?.warn?.({ symbol, error_message: err.message }, 'INVESTMENT_RESEARCH_SEARCH_FAILED');
      return c.json({ error: 'search_unavailable' }, 503);
    }

    const toFetch = ddgResults.slice(0, MAX_RESEARCH_PAGES);
    const sources = [];

    for (const result of toFetch) {
      try {
        checkUrl(result.url);
        const extracted = await Promise.race([
          fetchContent(result.url),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PAGE_TIMEOUT_MS)),
        ]);
        const text = (extracted?.text ?? '').trim();
        if (extracted?.fallback || text.length < 80) continue;

        const wrapped = wrapUntrustedContent({ url: result.url, title: extracted.title || result.title, content: text });
        const sourceId = randomUUID();
        db.insertResearchSource({
          id: sourceId,
          security_id: securityId,
          url: result.url,
          title: wrapped.metadata.title,
          source_type: 'web',
          data_recency: 'historical', // web research results are never labeled real_time — V1 has no live feed
          content_excerpt: text.slice(0, 2000),
        });
        sources.push({ id: sourceId, url: result.url, title: wrapped.metadata.title, retrievedAt: wrapped.metadata.retrievedAt, dataRecency: 'historical' });
      } catch (err) {
        logger?.warn?.({ url: result.url, error_message: err.message }, 'INVESTMENT_RESEARCH_PAGE_FAILED');
      }
    }

    return c.json({ ok: true, symbol, securityId, sources }, 200);
  });

  // ── Submit user-entered financial data for a period (V1 has no live market data feed) ──
  route.post('/investment/financial-period', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    let symbol;
    try { symbol = validateSymbol(body.symbol); } catch (err) { return c.json({ error: err.code }, 400); }
    if (typeof body.periodLabel !== 'string' || !body.periodLabel.trim()) return c.json({ error: 'period_label_required' }, 400);
    if (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) return c.json({ error: 'financial_data_invalid' }, 400);

    let dataRecency = 'historical';
    if (body.dataRecency !== undefined) {
      try { dataRecency = validateDataRecency(body.dataRecency); } catch (err) { return c.json({ error: err.code }, 400); }
    }

    const securityId = securityIdForSymbol(symbol);
    db.upsertSecurity({ id: securityId, symbol });
    const periodId = randomUUID();
    db.insertFinancialPeriod({
      id: periodId,
      security_id: securityId,
      period_label: body.periodLabel.trim(),
      period_type: body.periodType === 'quarterly' ? 'quarterly' : 'annual',
      fiscal_end_date: body.fiscalEndDate || null,
      currency: body.currency || 'USD',
      data: body.data,
      data_kind: dataRecency === 'analyst_estimate' ? 'estimate' : 'reported',
      source_id: body.sourceId || null,
    });

    return c.json({ ok: true, periodId, securityId }, 201);
  });

  // ── analyzeFundamentals(symbol) — deterministic calculations only ──
  route.get('/investment/fundamentals/:symbol', (c) => {
    let symbol;
    try { symbol = validateSymbol(c.req.param('symbol')); } catch (err) { return c.json({ error: err.code }, 400); }
    const securityId = securityIdForSymbol(symbol);
    const periods = db.getFinancialPeriodsForSecurity(securityId);
    if (periods.length === 0) return c.json({ error: 'no_financial_data', symbol }, 404);

    const analyzed = periods.map(period => {
      const d = period.data;
      return {
        periodLabel: period.period_label,
        periodType: period.period_type,
        currency: period.currency,
        dataKind: period.data_kind,
        metrics: {
          grossMargin: calculateGrossMargin({ revenue: d.revenue, costOfGoodsSold: d.costOfGoodsSold }),
          operatingMargin: calculateOperatingMargin({ revenue: d.revenue, operatingIncome: d.operatingIncome }),
          netMargin: calculateNetMargin({ revenue: d.revenue, netIncome: d.netIncome }),
          freeCashFlow: calculateFreeCashFlow({ operatingCashFlow: d.operatingCashFlow, capex: d.capex }),
          netDebt: calculateNetDebt({ totalDebt: d.totalDebt, cashAndEquivalents: d.cashAndEquivalents }),
          roe: calculateRoe({ netIncome: d.netIncome, shareholdersEquity: d.shareholdersEquity }),
        },
      };
    });

    let revenueCagr = null;
    if (periods.length >= 2) {
      const first = periods[0].data;
      const last = periods[periods.length - 1].data;
      revenueCagr = calculateCagr({ startValue: first.revenue, endValue: last.revenue, years: periods.length - 1 });
    }

    return c.json({ ok: true, symbol, periods: analyzed, revenueCagr, dataDisclaimer: 'Données saisies manuellement ou issues de recherche web — jamais un flux de marché en temps réel.' });
  });

  // ── compareCompanies(symbols) ──
  route.post('/investment/compare', (c) => {
    return c.req.json().catch(() => ({})).then(body => {
      let symbols;
      try { symbols = validateSymbolList(body.symbols, 8); } catch (err) { return c.json({ error: err.code }, 400); }

      const comparison = symbols.map(symbol => {
        const securityId = securityIdForSymbol(symbol);
        const periods = db.getFinancialPeriodsForSecurity(securityId);
        const latest = periods[periods.length - 1];
        return {
          symbol,
          hasData: !!latest,
          latestPeriod: latest?.period_label ?? null,
          metrics: latest ? {
            grossMargin: calculateGrossMargin({ revenue: latest.data.revenue, costOfGoodsSold: latest.data.costOfGoodsSold }),
            netMargin: calculateNetMargin({ revenue: latest.data.revenue, netIncome: latest.data.netIncome }),
            netDebt: calculateNetDebt({ totalDebt: latest.data.totalDebt, cashAndEquivalents: latest.data.cashAndEquivalents }),
          } : null,
        };
      });

      return c.json({ ok: true, comparison });
    });
  });

  // ── calculateValuation(input) — multiples + DCF, hypotheses always visible ──
  route.post('/investment/valuation', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const method = body.method;

    if (method === 'multiples') {
      const m = body.inputs || {};
      return c.json({
        ok: true, method, inputs: m,
        results: {
          pe: calculatePE(m), forwardPe: calculateForwardPE(m), evToSales: calculateEvToSales(m),
          evToEbitda: calculateEvToEbitda(m), pFcf: calculatePFcf(m), peg: calculatePeg(m),
        },
      });
    }

    if (method === 'dcf') {
      const result = calculateDCF(body.inputs || {});
      if (!result) return c.json({ error: 'dcf_inputs_invalid' }, 400);
      return c.json({ ok: true, method, ...result });
    }

    if (method === 'reverse_dcf') {
      const result = calculateReverseDCF(body.inputs || {});
      if (!result) return c.json({ error: 'reverse_dcf_inputs_invalid' }, 400);
      return c.json({ ok: true, method, ...result });
    }

    return c.json({ error: 'valuation_method_denied' }, 400);
  });

  // ── generateInvestmentReport(symbol) ──
  route.post('/investment/report', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    let symbol;
    try { symbol = validateSymbol(body.symbol); } catch (err) { return c.json({ error: err.code }, 400); }
    const securityId = securityIdForSymbol(symbol);
    const sources = db.getResearchSourcesForSecurity(securityId);
    const periods = db.getFinancialPeriodsForSecurity(securityId);

    const reportId = randomUUID();
    const content = {
      symbol,
      periodsAnalyzed: periods.map(p => p.period_label),
      sourceCount: sources.length,
      generatedAt: new Date().toISOString(),
    };
    db.insertInvestmentReport({
      id: reportId, security_id: securityId, report_type: body.reportType || 'fundamentals',
      title: body.title || `Rapport ${symbol}`, content, source_ids: sources.map(s => s.id),
    });

    return c.json({ ok: true, reportId, content, sources: sources.map(s => ({ id: s.id, url: s.url, title: s.title, dataRecency: s.data_recency })) }, 201);
  });

  // ── Watchlists ──
  route.post('/investment/watchlists', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    let symbols;
    try { symbols = validateSymbolList(body.symbols || [], 50); } catch (err) { return c.json({ error: err.code }, 400); }
    const id = randomUUID();
    db.insertInvestmentWatchlist({ id, name: body.name || 'Watchlist', symbols });
    return c.json({ ok: true, id }, 201);
  });

  route.get('/investment/watchlists', (c) => c.json({ ok: true, watchlists: db.getAllInvestmentWatchlists() }));

  // ── getPortfolio() / paper portfolio management ──
  route.post('/investment/portfolios', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = randomUUID();
    let startingCash = 100000;
    if (body.startingCash !== undefined) {
      try { startingCash = validatePositiveNumber(body.startingCash, 'starting_cash_invalid'); } catch (err) { return c.json({ error: err.code }, 400); }
    }
    db.createPaperPortfolio({ id, name: body.name || 'Portefeuille simulé', base_currency: body.baseCurrency || 'USD', starting_cash: startingCash });
    return c.json({ ok: true, id }, 201);
  });

  route.get('/investment/portfolios', (c) => c.json({ ok: true, portfolios: db.getAllPaperPortfolios() }));

  route.get('/investment/portfolios/:id', (c) => {
    const portfolio = db.getPaperPortfolioById(c.req.param('id'));
    if (!portfolio) return c.json({ error: 'portfolio_not_found' }, 404);
    const positions = db.getPaperPositions(portfolio.id);
    const transactions = db.getPaperTransactions(portfolio.id);
    return c.json({ ok: true, portfolio, positions, transactions });
  });

  // ── simulatePortfolioAction(input) — the ONLY way to move paper cash/positions ──
  route.post('/investment/portfolios/:id/transactions', async (c) => {
    const portfolioId = c.req.param('id');
    const portfolio = db.getPaperPortfolioById(portfolioId);
    if (!portfolio) return c.json({ error: 'portfolio_not_found' }, 404);

    const body = await c.req.json().catch(() => ({}));

    let action, symbol, quantity, simulatedPrice;
    try {
      action = authorizePaperAction(body.action);
      symbol = validateSymbol(body.symbol);
      quantity = validatePositiveNumber(body.quantity, 'quantity_invalid');
      simulatedPrice = validatePositiveNumber(body.simulatedPrice, 'simulated_price_invalid');
    } catch (err) {
      const status = err.code === 'real_broker_action_denied' ? 403 : 400;
      logger?.warn?.({ portfolioId, error_message: err.message, code: err.code }, 'INVESTMENT_TRANSACTION_DENIED');
      return c.json({ error: err.code }, status);
    }

    const result = db.applyPaperTransaction({
      id: randomUUID(), portfolio_id: portfolioId, action, symbol, quantity,
      simulated_price: simulatedPrice, note: typeof body.note === 'string' ? body.note.slice(0, 500) : '',
    });

    if (!result.ok) {
      const status = result.error === 'portfolio_not_found' ? 404 : 409;
      return c.json({ error: result.error }, status);
    }

    logger?.info?.({ portfolioId, action, symbol, quantity }, 'INVESTMENT_PAPER_TRANSACTION_APPLIED');
    return c.json({ ok: true, type: action, symbol, quantity, simulatedPrice, cash: result.cash }, 200);
  });

  // ── Explicit rejection of any real-broker route shape a client might try ──
  route.post('/investment/portfolios/:id/real-buy', (c) => c.json({ error: 'real_broker_action_denied' }, 403));
  route.post('/investment/portfolios/:id/real-sell', (c) => c.json({ error: 'real_broker_action_denied' }, 403));
  route.post('/investment/portfolios/:id/live-order', (c) => c.json({ error: 'real_broker_action_denied' }, 403));
  route.post('/investment/broker/connect', (c) => c.json({ error: 'broker_connection_not_supported_in_v1' }, 409));

  // Portfolio performance metrics (deterministic — investment-calc.js) —
  // caller supplies currentPrice per symbol (V1 has no live price feed).
  route.post('/investment/portfolios/:id/metrics', async (c) => {
    const portfolioId = c.req.param('id');
    const portfolio = db.getPaperPortfolioById(portfolioId);
    if (!portfolio) return c.json({ error: 'portfolio_not_found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const prices = body.currentPrices || {};

    const positions = db.getPaperPositions(portfolioId).map(p => ({
      symbol: p.symbol, quantity: p.quantity, avgCostBasis: p.avg_cost_basis,
      currentPrice: typeof prices[p.symbol] === 'number' ? prices[p.symbol] : p.avg_cost_basis,
    }));

    const metrics = calculatePortfolioMetrics({ cash: portfolio.cash, positions });
    if (!metrics) return c.json({ error: 'metrics_computation_failed' }, 400);
    return c.json({ ok: true, metrics, priceDisclaimer: 'currentPrice non fourni = dernier coût moyen utilisé par défaut, jamais un prix de marché en direct.' });
  });

  // ── Transparent multi-factor scoring — never a BUY/SELL recommendation ──
  // Deterministic (investment-scoring.js), computed purely from data already
  // stored via /financial-period. Missing data is never invented.
  route.get('/investment/scoring/:symbol', (c) => {
    let symbol;
    try { symbol = validateSymbol(c.req.param('symbol')); } catch (err) { return c.json({ error: err.code }, 400); }
    const securityId = securityIdForSymbol(symbol);
    const periods = db.getFinancialPeriodsForSecurity(securityId);
    if (periods.length === 0) return c.json({ error: 'no_financial_data', symbol }, 404);

    const latest = periods[periods.length - 1].data;
    const result = scoreInvestment({
      quality: { latestPeriodData: latest, investedCapital: latest.investedCapital },
      growth: { periods: periods.map(p => p.data) },
      valuation: { price: latest.price, earningsPerShare: latest.earningsPerShare, enterpriseValue: latest.enterpriseValue, ebitda: latest.ebitda, earningsGrowthRatePercent: latest.earningsGrowthRatePercent },
      balanceSheet: { latestPeriodData: latest, ebitda: latest.ebitda, sharesStart: periods[0]?.data?.sharesOutstanding, sharesEnd: latest.sharesOutstanding },
      risk: { customerConcentrationPercent: latest.customerConcentrationPercent, leverage: calculateLeverage({ netDebt: calculateNetDebt({ totalDebt: latest.totalDebt, cashAndEquivalents: latest.cashAndEquivalents }), ebitda: latest.ebitda }), pe: calculatePE({ price: latest.price, earningsPerShare: latest.earningsPerShare }), cyclicalIndustry: latest.cyclicalIndustry },
    });

    return c.json({ ok: true, symbol, ...result });
  });

  // ── News/events timeline — built exclusively from already-sourced research ──
  route.post('/investment/events', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    let symbol;
    try { symbol = validateSymbol(body.symbol); } catch (err) { return c.json({ error: err.code }, 400); }

    const securityId = securityIdForSymbol(symbol);
    const source = db.getResearchSourceById(body.sourceId);
    if (!source || source.security_id !== securityId) return c.json({ error: 'source_not_found_for_security' }, 400);
    if (typeof body.title !== 'string' || !body.title.trim()) return c.json({ error: 'timeline_event_title_required' }, 400);

    let interpretation = null;
    if (body.marketInterpretation !== undefined && body.marketInterpretation !== null) {
      if (typeof body.marketInterpretation !== 'object' || !body.marketInterpretation.basis) {
        return c.json({ error: 'market_interpretation_requires_basis' }, 400);
      }
      interpretation = body.marketInterpretation;
    }

    let event;
    try {
      event = buildTimelineEvent({
        eventDate: body.eventDate, type: body.type, title: body.title, summary: body.summary,
        source: { url: source.url, title: source.title, retrievedAt: source.retrieved_at },
      });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }

    const paired = attachMarketInterpretation(event, interpretation);

    const eventId = randomUUID();
    db.insertInvestmentEvent({
      id: eventId, security_id: securityId, source_id: source.id,
      event_date: event.date, date_reliable: event.dateReliable, event_type: event.type,
      title: event.title, summary: event.summary,
      market_interpretation_statement: paired.marketInterpretation?.statement ?? null,
      market_interpretation_basis: paired.marketInterpretation?.basis ?? null,
    });

    return c.json({ ok: true, eventId, event: paired.event, marketInterpretation: paired.marketInterpretation }, 201);
  });

  route.get('/investment/events/:symbol', (c) => {
    let symbol;
    try { symbol = validateSymbol(c.req.param('symbol')); } catch (err) { return c.json({ error: err.code }, 400); }
    const securityId = securityIdForSymbol(symbol);
    const rows = db.getInvestmentEventsForSecurity(securityId);

    // Each row already carries its own normalized date/type/title (set at
    // insert time by buildTimelineEvent via POST /investment/events) plus
    // its exact source provenance — read directly, re-sorted here rather
    // than re-run through buildTimeline() a second time.
    const withSources = rows.map(row => {
      const source = db.getResearchSourceById(row.source_id);
      return {
        id: row.id, date: row.event_date, dateReliable: row.date_reliable, type: row.event_type,
        title: row.title, summary: row.summary,
        source: source ? { url: source.url, title: source.title, retrievedAt: source.retrieved_at } : null,
        marketInterpretation: row.market_interpretation_basis
          ? { statement: row.market_interpretation_statement, basis: row.market_interpretation_basis, speculative: true }
          : null,
      };
    });

    return c.json({
      ok: true, symbol,
      dated: withSources.filter(e => e.dateReliable).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
      undated: withSources.filter(e => !e.dateReliable),
      disclaimer: buildTimeline([]).disclaimer, // constant text, reused rather than duplicated
    });
  });

  return route;
}
