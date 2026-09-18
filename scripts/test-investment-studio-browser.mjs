import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { captureStudio } from './studio-browser-checks.mjs';

let browser, server, assertions = 0;
const check = value => { assert.ok(value); assertions++; };
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount} = await import("/scripts/investment-studio-harness.jsx");mount();</script>';
const watchdog = setTimeout(() => { console.error('Investment Studio browser deadline'); void browser?.close(); void server?.close(); process.exitCode = 1; }, 60000);

try {
  server = await createServer({
    configFile: false,
    cacheDir: '.tmp/vite-investment-studio',
    plugins: [react(), { name: 'investment-harness', configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url?.split('?')[0] !== '/__investment_test') return next(); res.setHeader('Content-Type', 'text/html'); res.end(harnessHtml); }); } }],
    optimizeDeps: { entries: ['scripts/investment-studio-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5200, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Investment Studio browser error:', e.message); });

  let portfolios = [];
  let activePortfolio = null;
  let positions = [];
  let transactions = [];
  let deniedAttempts = 0;
  let valuationBody = null;
  let financialBody = null;

  await page.route('**/api/investment/**', async route => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    let data, status = 200;

    if (pathname === '/api/investment/research' && req.method() === 'POST') {
      data = { ok: true, symbol: 'AAPL', sources: [{ id: 's1', url: 'https://example.com/filing', title: 'Mock Filing', retrievedAt: '2026-09-18T00:00:00.000Z', dataRecency: 'historical' }] };
    } else if (pathname === '/api/investment/fundamentals/AAPL') {
      data = { ok: true, symbol: 'AAPL', periods: [{ periodLabel: 'FY2025', periodType: 'annual', currency: 'USD', dataKind: 'reported', metrics: { grossMargin: 0.4, operatingMargin: 0.3, netMargin: 0.25, roe: 0.5 } }], revenueCagr: 0.1 };
    } else if (pathname === '/api/investment/scoring/AAPL') {
      const mkCategory = (category, score, factors) => ({ category, score, dataCompleteness: 1, positiveFactors: factors.filter(f => f.contribution > 0), negativeFactors: factors.filter(f => f.contribution < 0), missingData: [], factors });
      data = {
        ok: true, symbol: 'AAPL', generatedAt: '2026-09-18T00:00:00.000Z',
        categories: {
          quality: mkCategory('Quality', 100, [{ id: 'gm', label: 'Marge brute > 30%', contribution: 1, status: 'positive', value: 0.4, note: '' }]),
          growth: mkCategory('Growth', 50, [{ id: 'cagr', label: 'CAGR > 5%', contribution: 0, status: 'insufficient_data', value: null, note: '' }]),
          valuation: mkCategory('Valuation', 0, [{ id: 'pe', label: 'P/E < 25', contribution: -1, status: 'negative', value: 90, note: '' }]),
          balanceSheet: mkCategory('Balance Sheet', 100, [{ id: 'nd', label: 'Cash net', contribution: 1, status: 'positive', value: -50, note: '' }]),
          risk: { ...mkCategory('Risk', 25, [{ id: 'lev', label: 'Levier < 4x', contribution: -1, status: 'negative', value: 8, note: '' }]), scoreMeaning: 'Score élevé = risque perçu FAIBLE (facteurs de risque inversés par construction).' },
        },
        disclaimer: 'Scoring analytique structurant l\'analyse — ne constitue jamais une recommandation d\'achat ou de vente.',
      };
    } else if (pathname === '/api/investment/events/AAPL') {
      data = {
        ok: true, symbol: 'AAPL',
        dated: [{ id: 'e1', date: '2026-08-01', dateReliable: true, type: 'earnings', title: 'Q3 earnings beat expectations', summary: '', source: { url: 'https://example.com/filing', title: 'Mock Filing', retrievedAt: '2026-09-18T00:00:00.000Z' }, marketInterpretation: null }],
        undated: [{ id: 'e2', date: null, dateReliable: false, type: 'other', title: 'Undated headline', summary: '', source: { url: 'https://example.com/filing2', title: 'Mock Filing 2', retrievedAt: '2026-09-18T00:00:00.000Z' }, marketInterpretation: { statement: 'Possible link to price move', basis: 'Same-day timing', speculative: true } }],
        disclaimer: 'Événements construits exclusivement à partir de sources déjà collectées.',
      };
    } else if (pathname === '/api/investment/valuation' && req.method() === 'POST') {
      const body = req.postDataJSON();
      valuationBody = body;
      if (body.method === 'multiples') {
        data = { ok: true, method: 'multiples', inputs: body.inputs, results: { pe: 15, forwardPe: 13, evToSales: 4, evToEbitda: 10, pFcf: 18, peg: 1.2 } };
      } else if (body.method === 'dcf') {
        const { baseFcf, growthRate, discountRate, terminalGrowthRate, years } = body.inputs;
        const projectedCashFlows = Array.from({ length: years }, (_, i) => {
          const year = i + 1;
          const fcf = baseFcf * Math.pow(1 + growthRate, year);
          const discountFactor = 1 / Math.pow(1 + discountRate, year);
          return { year, fcf, discountFactor, presentValue: fcf * discountFactor };
        });
        const sumOfDiscountedCashFlows = projectedCashFlows.reduce((sum, row) => sum + row.presentValue, 0);
        const finalFcf = projectedCashFlows[projectedCashFlows.length - 1].fcf;
        const terminalValue = (finalFcf * (1 + terminalGrowthRate)) / (discountRate - terminalGrowthRate);
        const presentValueOfTerminalValue = terminalValue / Math.pow(1 + discountRate, years);
        data = {
          ok: true, method: 'dcf', assumptions: body.inputs, projectedCashFlows, terminalValue,
          presentValueOfTerminalValue, sumOfDiscountedCashFlows,
          enterpriseValueEstimate: sumOfDiscountedCashFlows + presentValueOfTerminalValue,
        };
      } else if (body.method === 'reverse_dcf') {
        data = { ok: true, method: 'reverse_dcf', impliedGrowthRate: 0.075, iterations: 42, assumptions: body.inputs };
      } else {
        data = { error: 'valuation_method_denied' };
        status = 400;
      }
    } else if (pathname === '/api/investment/financial-period') {
      financialBody = req.postDataJSON();
      data = { ok: true };
    } else if (pathname === '/api/investment/portfolios' && req.method() === 'GET') {
      data = { ok: true, portfolios };
    } else if (pathname === '/api/investment/portfolios' && req.method() === 'POST') {
      const body = req.postDataJSON();
      activePortfolio = { id: 'port-1', name: body.name, base_currency: 'USD', starting_cash: body.startingCash, cash: body.startingCash };
      portfolios = [activePortfolio];
      data = { ok: true, id: 'port-1' };
    } else if (pathname === '/api/investment/portfolios/port-1' && req.method() === 'GET') {
      data = { ok: true, portfolio: activePortfolio, positions, transactions };
    } else if (pathname === '/api/investment/portfolios/port-1/metrics' && req.method() === 'POST') {
      const metricsPositions = positions.map(p => ({
        symbol: p.symbol, quantity: p.quantity, costBasis: p.quantity * p.avg_cost_basis,
        marketValue: p.quantity * p.avg_cost_basis, unrealizedPnl: 0, unrealizedPnlPercent: 0,
      }));
      const totalCostBasis = metricsPositions.reduce((sum, p) => sum + p.costBasis, 0);
      data = {
        ok: true,
        metrics: {
          cash: activePortfolio?.cash ?? 0, totalCostBasis, totalMarketValue: totalCostBasis,
          totalAccountValue: (activePortfolio?.cash ?? 0) + totalCostBasis, totalUnrealizedPnl: 0, totalUnrealizedPnlPercent: 0,
          positions: metricsPositions, allocation: metricsPositions.map(p => ({ symbol: p.symbol, weightPercent: 0 })),
        },
        priceDisclaimer: 'currentPrice non fourni = dernier coût moyen utilisé par défaut, jamais un prix de marché en direct.',
      };
    } else if (pathname === '/api/investment/portfolios/port-1/transactions' && req.method() === 'POST') {
      const body = req.postDataJSON();
      if (!['PAPER_BUY', 'PAPER_SELL'].includes(body.action)) {
        deniedAttempts++;
        data = { error: 'real_broker_action_denied' };
        status = 403;
      } else {
        const cost = body.quantity * body.simulatedPrice;
        activePortfolio.cash -= cost;
        positions = [{ id: 'pos-1', symbol: body.symbol, quantity: body.quantity, avg_cost_basis: body.simulatedPrice }];
        transactions = [{ id: 'tx-1', action: body.action, symbol: body.symbol, quantity: body.quantity, simulated_price: body.simulatedPrice, created_at: '2026-09-18T00:00:00.000Z' }, ...transactions];
        data = { ok: true, type: body.action, symbol: body.symbol, quantity: body.quantity, cash: activePortfolio.cash };
      }
    } else {
      data = { ok: true };
    }

    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data), headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type', 'access-control-allow-methods': 'GET,POST,OPTIONS' } });
  });

  const open = async () => {
    await page.getByPlaceholder(/Rechercher/).fill('Investissement');
    await page.getByRole('button', { name: 'Ouvrir', exact: true }).click();
    await page.getByRole('dialog', { name: 'Studio Investissement' }).waitFor();
  };
  await page.goto(`${origin}/__investment_test`);
  await open().catch(async e => { console.error(await page.locator('body').innerText()); throw e; });
  assertions++;

  // Overview: research + provenance display
  await page.getByPlaceholder('AAPL').fill('AAPL');
  await page.getByRole('button', { name: 'Rechercher (web)', exact: true }).click();
  await page.getByText('Mock Filing', { exact: true }).waitFor();
  check(await page.getByText('historique · récupéré le', { exact: false }).isVisible().catch(() => false) || await page.getByText('historical', { exact: false }).isVisible());

  // Fundamentals section
  await page.getByRole('button', { name: 'Charger fondamentaux', exact: true }).click();
  await page.getByRole('tab', { name: 'FUNDAMENTALS', exact: true }).click();
  await page.getByRole('cell', { name: 'FY2025', exact: true }).waitFor();
  assertions++;
  await page.getByText('Saisir une période financière', { exact: true }).click();
  await page.getByLabel('Libellé de période', { exact: true }).fill('FY2026');
  await page.getByLabel('Dette totale', { exact: true }).fill('0');
  await page.getByRole('button', { name: /Enregistrer la période/ }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('Chargement ou calcul en cours…'));
  check(financialBody?.data.totalDebt === 0 && !('revenue' in financialBody.data));

  // Scoring section: 5 categories displayed, no BUY/SELL recommendation text anywhere
  await page.getByRole('tab', { name: 'OVERVIEW', exact: true }).click();
  await page.getByRole('button', { name: 'Calculer le scoring', exact: true }).click();
  await page.getByRole('tab', { name: 'SCORING', exact: true }).click();
  for (const category of ['Quality', 'Growth', 'Valuation', 'Balance Sheet', 'Risk']) {
    await page.getByText(category, { exact: true }).waitFor();
  }
  assertions++;
  const scoringBodyText = await page.locator('body').innerText();
  check(!/\bBUY\b|\bSELL\b|STRONG BUY|STRONG SELL/i.test(scoringBodyText));

  // Expand Risk factor detail and confirm the inversion note is shown
  await page.getByRole('button', { name: 'Voir le détail', exact: true }).last().click();
  await page.getByText('risque perçu FAIBLE', { exact: false }).waitFor();
  assertions++;

  // Risks tab reuses the same Risk category card, expanded by default
  await page.getByRole('tab', { name: 'RISKS', exact: true }).click();
  await page.getByText('Levier < 4x', { exact: false }).waitFor();
  assertions++;

  // Timeline section: dated + undated events, provenance and market interpretation shown distinctly
  await page.getByRole('tab', { name: 'OVERVIEW', exact: true }).click();
  await page.getByRole('button', { name: 'Charger la timeline', exact: true }).click();
  await page.getByRole('tab', { name: 'TIMELINE', exact: true }).click();
  await page.getByText('Q3 earnings beat expectations', { exact: false }).waitFor();
  await page.getByText('Undated headline', { exact: false }).waitFor();
  await page.getByText('date non fiable', { exact: false }).waitFor();
  await page.getByText('Interprétation de marché (spéculative)', { exact: false }).waitFor();
  assertions++;

  // Timeline event creation form: sources already fetched, submit a new event
  await page.locator('summary').filter({ hasText: 'Ajouter un événement' }).click();
  const eventForm = page.locator('details').filter({ hasText: 'Ajouter un événement' });
  await eventForm.locator('select').first().selectOption({ label: 'Mock Filing' });
  await page.getByLabel('Titre', { exact: true }).fill('New guidance issued');
  await page.getByRole('button', { name: "Ajouter l'événement", exact: true }).click();
  assertions++;

  // Valuation: DCF surfaces full assumptions (never a bare number)
  await page.getByRole('tab', { name: 'VALUATION', exact: true }).click();
  check(await page.getByRole('button', { name: 'Calculer le DCF', exact: true }).isDisabled());
  for (const [label, value] of [['FCF de base', '1000000'], ['Taux de croissance', '0.08'], ["Taux d'actualisation", '0.10'], ['Croissance terminale', '0.02'], ['Années', '5']]) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await page.getByRole('button', { name: 'Calculer le DCF', exact: true }).click();
  await page.getByText("Valeur d'entreprise estimée", { exact: false }).waitFor();
  await page.getByText('Somme des flux actualisés', { exact: false }).waitFor();
  assertions++;
  await page.getByLabel('Valeur d’entreprise cible (Reverse DCF)', { exact: true }).fill('12000000');
  await page.getByRole('button', { name: 'Calculer le Reverse DCF', exact: true }).click();
  await page.getByText('Taux de croissance implicite', { exact: false }).waitFor();
  check(valuationBody.inputs.targetEnterpriseValue === 12000000);
  await page.getByLabel('Prix', { exact: true }).fill('150');
  await page.getByLabel('Bénéfice par action', { exact: true }).fill('10');
  await page.getByRole('button', { name: 'Calculer les multiples', exact: true }).click();
  await page.getByText('Entrées du calcul', { exact: false }).waitFor();
  check(valuationBody.inputs.price === 150 && valuationBody.inputs.earningsPerShare === 10);
  await captureStudio(page, 'investment-valuation');

  // Paper Portfolio: create, buy, verify PAPER marking
  await page.getByRole('tab', { name: 'PAPER PORTFOLIO', exact: true }).click();
  await page.getByRole('button', { name: 'Nouveau portefeuille', exact: true }).click();
  await page.getByText('cash disponible', { exact: false }).or(page.getByText('Cash disponible', { exact: false })).waitFor();
  assertions++;

  const tradeForm = page.locator('div').filter({ has: page.getByRole('button', { name: 'Exécuter (simulé)', exact: true }) }).last();
  await tradeForm.getByPlaceholder('AAPL').fill('AAPL');
  const numberInputs = tradeForm.locator('input[type="number"]');
  await numberInputs.nth(0).fill('10');
  await numberInputs.nth(1).fill('150');
  await page.getByRole('button', { name: 'Exécuter (simulé)', exact: true }).click();
  await page.getByText('[PAPER] PAPER_BUY 10 AAPL', { exact: false }).waitFor();
  assertions++;

  // Portfolio metrics now called (previously-unused endpoint) — real P&L/value shown
  await page.getByText('Valeur totale du compte', { exact: false }).waitFor();
  assertions++;

  // Verify the action selector only ever offers PAPER_BUY/PAPER_SELL (never REAL_*/LIVE_*)
  const optionValues = await page.getByLabel("Type d'ordre simulé").locator('option').allTextContents();
  check(optionValues.every(v => v.startsWith('PAPER_')));
  check(!optionValues.some(v => v.includes('REAL') || v.includes('LIVE')));
  check(deniedAttempts === 0);
  await captureStudio(page, 'investment-paper');

  check(errors.length === 0);
  console.log(`INVESTMENT STUDIO FRONTEND PASS ${assertions}/${assertions}`);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
}
