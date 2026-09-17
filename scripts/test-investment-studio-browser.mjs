import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let browser, server, assertions = 0;
const check = value => { assert.ok(value); assertions++; };
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount} = await import("/scripts/investment-studio-harness.jsx");mount();</script>';
const watchdog = setTimeout(() => { console.error('Investment Studio browser deadline'); void browser?.close(); void server?.close(); process.exitCode = 1; }, 60000);

try {
  server = await createServer({
    configFile: false,
    plugins: [react(), { name: 'investment-harness', configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url?.split('?')[0] !== '/__investment_test') return next(); res.setHeader('Content-Type', 'text/html'); res.end(harnessHtml); }); } }],
    optimizeDeps: { entries: ['scripts/investment-studio-harness.jsx'] },
    server: { host: '127.0.0.1', port: 5200, strictPort: true, hmr: false },
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
    } else if (pathname === '/api/investment/portfolios' && req.method() === 'GET') {
      data = { ok: true, portfolios };
    } else if (pathname === '/api/investment/portfolios' && req.method() === 'POST') {
      const body = req.postDataJSON();
      activePortfolio = { id: 'port-1', name: body.name, base_currency: 'USD', starting_cash: body.startingCash, cash: body.startingCash };
      portfolios = [activePortfolio];
      data = { ok: true, id: 'port-1' };
    } else if (pathname === '/api/investment/portfolios/port-1' && req.method() === 'GET') {
      data = { ok: true, portfolio: activePortfolio, positions, transactions };
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
  await page.getByRole('button', { name: 'FUNDAMENTALS', exact: true }).click();
  await page.getByText('FY2025', { exact: false }).waitFor();
  assertions++;

  // Scoring section: 5 categories displayed, no BUY/SELL recommendation text anywhere
  await page.getByRole('button', { name: 'OVERVIEW', exact: true }).click();
  await page.getByRole('button', { name: 'Calculer le scoring', exact: true }).click();
  await page.getByRole('button', { name: 'SCORING', exact: true }).click();
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
  await page.getByRole('button', { name: 'RISKS', exact: true }).click();
  await page.getByText('Levier < 4x', { exact: false }).waitFor();
  assertions++;

  // Timeline section: dated + undated events, provenance and market interpretation shown distinctly
  await page.getByRole('button', { name: 'OVERVIEW', exact: true }).click();
  await page.getByRole('button', { name: 'Charger la timeline', exact: true }).click();
  await page.getByRole('button', { name: 'TIMELINE', exact: true }).click();
  await page.getByText('Q3 earnings beat expectations', { exact: false }).waitFor();
  await page.getByText('Undated headline', { exact: false }).waitFor();
  await page.getByText('date non fiable', { exact: false }).waitFor();
  await page.getByText('Interprétation de marché (spéculative)', { exact: false }).waitFor();
  assertions++;

  // Paper Portfolio: create, buy, verify PAPER marking
  await page.getByRole('button', { name: 'PAPER PORTFOLIO', exact: true }).click();
  await page.getByRole('button', { name: 'Nouveau portefeuille', exact: true }).click();
  await page.getByText('cash disponible', { exact: false }).or(page.getByText('Cash disponible', { exact: false })).waitFor();
  assertions++;

  await page.getByPlaceholder('AAPL').last().fill('AAPL');
  const qtyInput = page.locator('input[type="number"]').first();
  const priceInput = page.locator('input[type="number"]').last();
  await qtyInput.fill('10');
  await priceInput.fill('150');
  await page.getByRole('button', { name: 'Exécuter (simulé)', exact: true }).click();
  await page.getByText('[PAPER] PAPER_BUY 10 AAPL', { exact: false }).waitFor();
  assertions++;

  // Verify the action selector only ever offers PAPER_BUY/PAPER_SELL (never REAL_*/LIVE_*)
  const optionValues = await page.getByLabel("Type d'ordre simulé").locator('option').allTextContents();
  check(optionValues.every(v => v.startsWith('PAPER_')));
  check(!optionValues.some(v => v.includes('REAL') || v.includes('LIVE')));

  check(errors.length === 0);
  console.log(`INVESTMENT STUDIO FRONTEND PASS ${assertions}/${assertions}`);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
}
