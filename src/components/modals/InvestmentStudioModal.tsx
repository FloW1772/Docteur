import { useCallback, useEffect, useState } from 'react';
import { LineChart } from 'lucide-react';
import {
  investmentRequest, ALLOWED_PAPER_ACTIONS, EVENT_TYPES,
  type ResearchSource, type FundamentalsPeriod, type PaperPortfolio, type PaperPosition, type PaperTransaction, type PaperAction,
  type InvestmentScoring, type ScoreCategory, type InvestmentTimeline, type TimelineEvent, type EventType,
  type MultiplesResult, type DcfResult, type ReverseDcfResult, type PortfolioMetrics,
} from '../../lib/investment-studio';
import StudioShell from '../studio/StudioShell';
import StudioTabs from '../studio/StudioTabs';
import StudioErrorState from '../studio/StudioErrorState';
import StudioEmptyState from '../studio/StudioEmptyState';
import StudioTimeline from '../studio/StudioTimeline';
import StudioSourceBadge from '../studio/StudioSourceBadge';

const SECTIONS = ['OVERVIEW', 'FUNDAMENTALS', 'VALUATION', 'SCORING', 'RISKS', 'TIMELINE', 'PAPER PORTFOLIO'] as const;
type Section = typeof SECTIONS[number];
const SCORE_COLOR = (score: number | null) => score === null ? 'var(--text-dim)' : score >= 70 ? 'var(--emerald)' : score >= 40 ? 'var(--amber)' : '#ff4d58';

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
}

function num(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined ? '—' : value.toFixed(digits);
}

function ScoreCard({ category, expanded = false }: { category: ScoreCategory; expanded?: boolean }) {
  const [open, setOpen] = useState(expanded);
  return (
    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>{category.category}</strong>
        <span style={{ color: SCORE_COLOR(category.score), fontWeight: 700 }}>{category.score === null ? '—' : category.score}</span>
      </div>
      {category.scoreMeaning && <p style={{ fontSize: 10, color: 'var(--text-dim)', margin: '4px 0' }}>{category.scoreMeaning}</p>}
      <p style={{ fontSize: 11, color: 'var(--text-dim)' }}>Complétude des données : {pct(category.dataCompleteness)}</p>
      <button type="button" className="studio-button" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => setOpen(o => !o)}>
        {open ? 'Masquer le détail' : 'Voir le détail'}
      </button>
      {open && (
        <ul style={{ marginTop: 8, fontSize: 11, paddingLeft: 16 }}>
          {category.factors.map(f => (
            <li key={f.id} style={{ color: f.status === 'positive' ? 'var(--emerald)' : f.status === 'negative' ? '#ff4d58' : 'var(--text-dim)', marginBottom: 4 }}>
              {f.label} — {f.status === 'insufficient_data' ? 'donnée manquante' : String(f.value)}
              {f.note && ` (${f.note})`}
            </li>
          ))}
        </ul>
      )}
      {category.missingData.length > 0 && (
        <p style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>Données manquantes : {category.missingData.join(', ')}</p>
      )}
    </div>
  );
}

export default function InvestmentStudioModal({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<Section>('OVERVIEW');
  const [symbol, setSymbol] = useState('');
  const [sources, setSources] = useState<ResearchSource[]>([]);
  const [fundamentals, setFundamentals] = useState<FundamentalsPeriod[] | null>(null);
  const [revenueCagr, setRevenueCagr] = useState<number | null>(null);
  const [scoring, setScoring] = useState<InvestmentScoring | null>(null);
  const [timeline, setTimeline] = useState<InvestmentTimeline | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // ── Fundamentals input form (Phase UX-5: exposes an existing backend
  // endpoint — POST /financial-period — that previously had no UI, leaving
  // Fundamentals/Scoring/Timeline as permanent dead ends for a new symbol). ──
  const [periodLabel, setPeriodLabel] = useState('');
  const [periodType, setPeriodType] = useState<'annual' | 'quarterly'>('annual');
  const [revenue, setRevenue] = useState('');
  const [costOfGoodsSold, setCostOfGoodsSold] = useState('');
  const [operatingIncome, setOperatingIncome] = useState('');
  const [netIncome, setNetIncome] = useState('');
  const [operatingCashFlow, setOperatingCashFlow] = useState('');
  const [capex, setCapex] = useState('');
  const [totalDebt, setTotalDebt] = useState('');
  const [cashAndEquivalents, setCashAndEquivalents] = useState('');
  const [shareholdersEquity, setShareholdersEquity] = useState('');

  // ── Valuation ──
  const [multiplesPrice, setMultiplesPrice] = useState('');
  const [multiplesResult, setMultiplesResult] = useState<MultiplesResult | null>(null);
  const [dcfResult, setDcfResult] = useState<DcfResult | null>(null);
  const [reverseDcfResult, setReverseDcfResult] = useState<ReverseDcfResult | null>(null);
  const [dcfBaseFcf, setDcfBaseFcf] = useState('1000000');
  const [dcfGrowthRate, setDcfGrowthRate] = useState('0.08');
  const [dcfDiscountRate, setDcfDiscountRate] = useState('0.10');
  const [dcfTerminalGrowth, setDcfTerminalGrowth] = useState('0.02');
  const [dcfYears, setDcfYears] = useState('5');

  // ── Timeline event creation ──
  const [eventSourceId, setEventSourceId] = useState('');
  const [eventType, setEventType] = useState<EventType>('other');
  const [eventTitle, setEventTitle] = useState('');
  const [eventDate, setEventDate] = useState('');

  const [portfolios, setPortfolios] = useState<PaperPortfolio[]>([]);
  const [activePortfolioId, setActivePortfolioId] = useState('');
  const [positions, setPositions] = useState<PaperPosition[]>([]);
  const [transactions, setTransactions] = useState<PaperTransaction[]>([]);
  const [portfolioMetrics, setPortfolioMetrics] = useState<PortfolioMetrics | null>(null);
  const [tradeSymbol, setTradeSymbol] = useState('');
  const [tradeQty, setTradeQty] = useState('');
  const [tradePrice, setTradePrice] = useState('');
  const [tradeAction, setTradeAction] = useState<PaperAction>('PAPER_BUY');

  const loadPortfolios = useCallback(async () => {
    const result = await investmentRequest<{ portfolios: PaperPortfolio[] }>('/portfolios');
    setPortfolios(result.portfolios);
  }, []);

  useEffect(() => { void loadPortfolios().catch(e => setError(e.message)); }, [loadPortfolios]);

  const loadPortfolioDetail = useCallback(async (id: string) => {
    const result = await investmentRequest<{ portfolio: PaperPortfolio; positions: PaperPosition[]; transactions: PaperTransaction[] }>(`/portfolios/${id}`);
    setPositions(result.positions);
    setTransactions(result.transactions);
    try {
      const metrics = await investmentRequest<{ metrics: PortfolioMetrics }>(`/portfolios/${id}/metrics`, {}, 'POST');
      setPortfolioMetrics(metrics.metrics);
    } catch {
      setPortfolioMetrics(null);
    }
  }, []);

  useEffect(() => {
    if (activePortfolioId) void loadPortfolioDetail(activePortfolioId).catch(e => setError(e.message));
  }, [activePortfolioId, loadPortfolioDetail]);

  async function runResearch() {
    if (!symbol.trim()) return;
    setBusy(true); setError('');
    try {
      const result = await investmentRequest<{ symbol: string; sources: ResearchSource[] }>('/research', { symbol: symbol.trim() }, 'POST');
      setSources(result.sources);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function loadFundamentals() {
    if (!symbol.trim()) return;
    setBusy(true); setError('');
    try {
      const result = await investmentRequest<{ periods: FundamentalsPeriod[]; revenueCagr: number | null }>(`/fundamentals/${encodeURIComponent(symbol.trim())}`);
      setFundamentals(result.periods);
      setRevenueCagr(result.revenueCagr);
    } catch (e) { setError((e as Error).message); setFundamentals(null); }
    finally { setBusy(false); }
  }

  async function submitFinancialPeriod() {
    if (!symbol.trim() || !periodLabel.trim()) return;
    setBusy(true); setError('');
    try {
      await investmentRequest('/financial-period', {
        symbol: symbol.trim(), periodLabel: periodLabel.trim(), periodType,
        data: {
          revenue: Number(revenue) || undefined,
          costOfGoodsSold: Number(costOfGoodsSold) || undefined,
          operatingIncome: Number(operatingIncome) || undefined,
          netIncome: Number(netIncome) || undefined,
          operatingCashFlow: Number(operatingCashFlow) || undefined,
          capex: Number(capex) || undefined,
          totalDebt: Number(totalDebt) || undefined,
          cashAndEquivalents: Number(cashAndEquivalents) || undefined,
          shareholdersEquity: Number(shareholdersEquity) || undefined,
        },
      }, 'POST');
      setPeriodLabel('');
      await loadFundamentals();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function loadScoring() {
    if (!symbol.trim()) return;
    setBusy(true); setError('');
    try {
      const result = await investmentRequest<InvestmentScoring>(`/scoring/${encodeURIComponent(symbol.trim())}`);
      setScoring(result);
    } catch (e) { setError((e as Error).message); setScoring(null); }
    finally { setBusy(false); }
  }

  async function loadTimeline() {
    if (!symbol.trim()) return;
    setBusy(true); setError('');
    try {
      const result = await investmentRequest<InvestmentTimeline>(`/events/${encodeURIComponent(symbol.trim())}`);
      setTimeline(result);
    } catch (e) { setError((e as Error).message); setTimeline(null); }
    finally { setBusy(false); }
  }

  async function submitTimelineEvent() {
    if (!symbol.trim() || !eventSourceId || !eventTitle.trim()) return;
    setBusy(true); setError('');
    try {
      await investmentRequest('/events', {
        symbol: symbol.trim(), sourceId: eventSourceId, type: eventType, title: eventTitle.trim(),
        ...(eventDate ? { eventDate } : {}),
      }, 'POST');
      setEventTitle('');
      await loadTimeline();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function runMultiples() {
    setBusy(true); setError('');
    try {
      const result = await investmentRequest<{ results: MultiplesResult }>('/valuation', {
        method: 'multiples',
        inputs: { price: Number(multiplesPrice) || undefined },
      }, 'POST');
      setMultiplesResult(result.results);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function runDcf() {
    setBusy(true); setError('');
    try {
      const result = await investmentRequest<DcfResult & { ok: true }>('/valuation', {
        method: 'dcf',
        inputs: {
          baseFcf: Number(dcfBaseFcf), growthRate: Number(dcfGrowthRate),
          discountRate: Number(dcfDiscountRate), terminalGrowthRate: Number(dcfTerminalGrowth), years: Number(dcfYears),
        },
      }, 'POST');
      setDcfResult(result);
    } catch (e) { setError((e as Error).message); setDcfResult(null); }
    finally { setBusy(false); }
  }

  async function runReverseDcf() {
    setBusy(true); setError('');
    try {
      const result = await investmentRequest<ReverseDcfResult & { ok: true }>('/valuation', {
        method: 'reverse_dcf',
        inputs: {
          targetEnterpriseValue: Number(dcfBaseFcf) * 15, baseFcf: Number(dcfBaseFcf),
          discountRate: Number(dcfDiscountRate), terminalGrowthRate: Number(dcfTerminalGrowth), years: Number(dcfYears),
        },
      }, 'POST');
      setReverseDcfResult(result);
    } catch (e) { setError((e as Error).message); setReverseDcfResult(null); }
    finally { setBusy(false); }
  }

  async function createPortfolio() {
    setBusy(true); setError('');
    try {
      const result = await investmentRequest<{ id: string }>('/portfolios', { name: 'Portefeuille simulé', startingCash: 100000 }, 'POST');
      await loadPortfolios();
      setActivePortfolioId(result.id);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function submitTrade() {
    if (!activePortfolioId || !tradeSymbol.trim() || !tradeQty || !tradePrice) return;
    setBusy(true); setError('');
    try {
      await investmentRequest(`/portfolios/${activePortfolioId}/transactions`, {
        action: tradeAction, symbol: tradeSymbol.trim(), quantity: Number(tradeQty), simulatedPrice: Number(tradePrice),
      }, 'POST');
      await loadPortfolioDetail(activePortfolioId);
      await loadPortfolios();
      setTradeQty(''); setTradePrice('');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const activePortfolio = portfolios.find(p => p.id === activePortfolioId);

  return (
    <StudioShell
      icon={<LineChart size={18} />}
      title="Studio Investissement"
      onClose={onClose}
      subtitle="Analyse, recherche et simulation uniquement — aucun broker réel, aucun ordre réel, aucune transaction réelle."
    >
      {error && <StudioErrorState message={error} />}

      <StudioTabs tabs={SECTIONS} active={section} onChange={setSection} />

      {section === 'OVERVIEW' && (
        <div>
          <label>Symbole
            <input className="studio-field" value={symbol} onChange={e => setSymbol(e.target.value)} placeholder="AAPL" />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="studio-button studio-button--primary" disabled={busy || !symbol.trim()} onClick={() => void runResearch()}>Rechercher (web)</button>
            <button type="button" className="studio-button" disabled={busy || !symbol.trim()} onClick={() => void loadFundamentals()}>Charger fondamentaux</button>
            <button type="button" className="studio-button" disabled={busy || !symbol.trim()} onClick={() => void loadScoring()}>Calculer le scoring</button>
            <button type="button" className="studio-button" disabled={busy || !symbol.trim()} onClick={() => void loadTimeline()}>Charger la timeline</button>
          </div>
          {sources.length > 0 ? (
            <div style={{ marginTop: 16 }}>
              <h3>Sources (provenance)</h3>
              <ul style={{ listStyle: 'none', padding: 0 }}>
                {sources.map(s => (
                  <li key={s.id} style={{ marginBottom: 6 }}>
                    <StudioSourceBadge label={s.title} url={s.url} timestamp={s.retrievedAt} recency={s.dataRecency} />
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <StudioEmptyState message="Sélectionnez ou analysez un symbole." />
          )}
        </div>
      )}

      {section === 'FUNDAMENTALS' && (
        <div>
          {!fundamentals && <StudioEmptyState message="Charge d'abord les fondamentaux depuis Overview." />}
          {fundamentals && fundamentals.length === 0 && (
            <StudioEmptyState message="Aucune donnée financière saisie pour ce symbole." />
          )}
          {fundamentals && fundamentals.length > 0 && (
            <>
              {revenueCagr !== null && <p>CAGR revenus (période complète) : <strong>{pct(revenueCagr)}</strong></p>}
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr><th>Période</th><th>Devise</th><th>Marge brute</th><th>Marge op.</th><th>Marge nette</th><th>FCF</th><th>Dette nette</th><th>ROE</th></tr></thead>
                <tbody>
                  {fundamentals.map(p => (
                    <tr key={p.periodLabel}>
                      <td>{p.periodLabel} {p.dataKind === 'estimate' && '(estimation)'}</td>
                      <td>{p.currency}</td>
                      <td>{pct(p.metrics.grossMargin)}</td>
                      <td>{pct(p.metrics.operatingMargin)}</td>
                      <td>{pct(p.metrics.netMargin)}</td>
                      <td>{num(p.metrics.freeCashFlow, 0)}</td>
                      <td>{num(p.metrics.netDebt, 0)}</td>
                      <td>{pct(p.metrics.roe)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 8 }}>
                Données saisies manuellement ou issues de recherche web — jamais un flux de marché en temps réel.
              </p>
            </>
          )}

          {/* Financial-period input form — exposes the existing POST
              /financial-period endpoint, previously unreachable from any UI. */}
          <details style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Saisir une période financière</summary>
            <div style={{ marginTop: 10 }}>
              <label>Libellé de période<input className="studio-field" value={periodLabel} onChange={e => setPeriodLabel(e.target.value)} placeholder="FY2025" /></label>
              <label>Type
                <select className="studio-field" value={periodType} onChange={e => setPeriodType(e.target.value as 'annual' | 'quarterly')}>
                  <option value="annual">Annuelle</option>
                  <option value="quarterly">Trimestrielle</option>
                </select>
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
                <label>Revenu<input className="studio-field" type="number" value={revenue} onChange={e => setRevenue(e.target.value)} /></label>
                <label>Coût des ventes<input className="studio-field" type="number" value={costOfGoodsSold} onChange={e => setCostOfGoodsSold(e.target.value)} /></label>
                <label>Résultat opérationnel<input className="studio-field" type="number" value={operatingIncome} onChange={e => setOperatingIncome(e.target.value)} /></label>
                <label>Résultat net<input className="studio-field" type="number" value={netIncome} onChange={e => setNetIncome(e.target.value)} /></label>
                <label>Flux de trésorerie opérationnel<input className="studio-field" type="number" value={operatingCashFlow} onChange={e => setOperatingCashFlow(e.target.value)} /></label>
                <label>Capex<input className="studio-field" type="number" value={capex} onChange={e => setCapex(e.target.value)} /></label>
                <label>Dette totale<input className="studio-field" type="number" value={totalDebt} onChange={e => setTotalDebt(e.target.value)} /></label>
                <label>Trésorerie<input className="studio-field" type="number" value={cashAndEquivalents} onChange={e => setCashAndEquivalents(e.target.value)} /></label>
                <label>Capitaux propres<input className="studio-field" type="number" value={shareholdersEquity} onChange={e => setShareholdersEquity(e.target.value)} /></label>
              </div>
              <button type="button" className="studio-button studio-button--primary" disabled={busy || !symbol.trim() || !periodLabel.trim()} onClick={() => void submitFinancialPeriod()}>
                Enregistrer la période
              </button>
            </div>
          </details>
        </div>
      )}

      {section === 'VALUATION' && (
        <div>
          <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>
            Calculs déterministes côté serveur — le frontend n'invente ni ne recalcule aucune métrique critique.
            Chaque résultat affiche ses hypothèses complètes.
          </p>

          <details open style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Multiples</summary>
            <label>Prix<input className="studio-field" type="number" placeholder="150" value={multiplesPrice} onChange={e => setMultiplesPrice(e.target.value)} /></label>
            <button type="button" className="studio-button studio-button--primary" disabled={busy} onClick={() => void runMultiples()}>Calculer les multiples</button>
            {multiplesResult && (
              <table style={{ width: '100%', fontSize: 13, marginTop: 10 }}>
                <tbody>
                  <tr><td>P/E</td><td>{num(multiplesResult.pe)}</td></tr>
                  <tr><td>Forward P/E</td><td>{num(multiplesResult.forwardPe)}</td></tr>
                  <tr><td>EV/Sales</td><td>{num(multiplesResult.evToSales)}</td></tr>
                  <tr><td>EV/EBITDA</td><td>{num(multiplesResult.evToEbitda)}</td></tr>
                  <tr><td>P/FCF</td><td>{num(multiplesResult.pFcf)}</td></tr>
                  <tr><td>PEG</td><td>{num(multiplesResult.peg)}</td></tr>
                </tbody>
              </table>
            )}
          </details>

          <details open style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>DCF (discounted cash flow)</summary>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
              <label>FCF de base<input className="studio-field" type="number" value={dcfBaseFcf} onChange={e => setDcfBaseFcf(e.target.value)} /></label>
              <label>Taux de croissance<input className="studio-field" type="number" step="0.01" value={dcfGrowthRate} onChange={e => setDcfGrowthRate(e.target.value)} /></label>
              <label>Taux d'actualisation<input className="studio-field" type="number" step="0.01" value={dcfDiscountRate} onChange={e => setDcfDiscountRate(e.target.value)} /></label>
              <label>Croissance terminale<input className="studio-field" type="number" step="0.01" value={dcfTerminalGrowth} onChange={e => setDcfTerminalGrowth(e.target.value)} /></label>
              <label>Années<input className="studio-field" type="number" value={dcfYears} onChange={e => setDcfYears(e.target.value)} /></label>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="studio-button studio-button--primary" disabled={busy} onClick={() => void runDcf()}>Calculer le DCF</button>
              <button type="button" className="studio-button" disabled={busy} onClick={() => void runReverseDcf()}>Reverse DCF (EV cible = 15× FCF)</button>
            </div>
            {dcfResult && (
              <div style={{ marginTop: 10, fontSize: 13 }}>
                <p>Valeur d'entreprise estimée : <strong>{num(dcfResult.enterpriseValueEstimate, 0)}</strong></p>
                <p>Somme des flux actualisés : {num(dcfResult.sumOfDiscountedCashFlows, 0)} — Valeur terminale actualisée : {num(dcfResult.presentValueOfTerminalValue, 0)}</p>
                <table style={{ width: '100%', fontSize: 12, marginTop: 6 }}>
                  <thead><tr><th>Année</th><th>FCF</th><th>Facteur</th><th>Valeur actualisée</th></tr></thead>
                  <tbody>
                    {dcfResult.projectedCashFlows.map(row => (
                      <tr key={row.year}><td>{row.year}</td><td>{num(row.fcf, 0)}</td><td>{num(row.discountFactor, 3)}</td><td>{num(row.presentValue, 0)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {reverseDcfResult && (
              <p style={{ fontSize: 13, marginTop: 10 }}>
                Taux de croissance implicite : <strong>{pct(reverseDcfResult.impliedGrowthRate)}</strong> ({reverseDcfResult.iterations} itérations)
              </p>
            )}
          </details>
        </div>
      )}

      {section === 'SCORING' && (
        <div>
          <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>
            Scoring analytique — structure l'analyse, ne constitue jamais une recommandation d'achat ou de vente.
          </p>
          {!scoring && <StudioEmptyState message="Calcule d'abord le scoring depuis Overview." />}
          {scoring && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, margin: '12px 0' }}>
                {Object.values(scoring.categories).map(cat => <ScoreCard key={cat.category} category={cat} />)}
              </div>
              <p style={{ color: 'var(--text-dim)', fontSize: 11 }}>{scoring.disclaimer}</p>
            </>
          )}
        </div>
      )}

      {section === 'RISKS' && (
        <div>
          <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>
            Séparation RISQUES CONNUS / INCERTITUDES / HYPOTHÈSES — facteurs détaillés dans le scoring Risk.
          </p>
          {scoring ? <ScoreCard category={scoring.categories.risk} expanded /> : (
            <StudioEmptyState message="Calcule d'abord le scoring depuis Overview pour voir le détail des facteurs de risque." />
          )}
        </div>
      )}

      {section === 'TIMELINE' && (
        <div>
          {!timeline && <StudioEmptyState message="Charge d'abord la timeline depuis Overview." />}
          {timeline && timeline.dated.length === 0 && timeline.undated.length === 0 && (
            <StudioEmptyState message="Aucun événement enregistré pour ce symbole." />
          )}
          {timeline && timeline.dated.length > 0 && (
            <>
              <h3>Chronologie</h3>
              <StudioTimeline
                entries={timeline.dated.map((evt: TimelineEvent) => ({
                  id: evt.id, kind: evt.type, when: evt.date,
                  title: evt.title,
                  source: evt.source ? <a href={evt.source.url} target="_blank" rel="noreferrer" style={{ color: 'var(--cyan)' }}>source</a> : undefined,
                  interpretation: evt.marketInterpretation ? `Interprétation de marché (spéculative) : ${evt.marketInterpretation.statement} — base : ${evt.marketInterpretation.basis}` : undefined,
                }))}
              />
            </>
          )}
          {timeline && timeline.undated.length > 0 && (
            <>
              <h3>Sans date fiable</h3>
              <StudioTimeline
                entries={timeline.undated.map((evt: TimelineEvent) => ({
                  id: evt.id, kind: evt.type, when: null,
                  title: evt.title,
                  source: evt.source ? <a href={evt.source.url} target="_blank" rel="noreferrer" style={{ color: 'var(--cyan)' }}>source</a> : undefined,
                  interpretation: evt.marketInterpretation ? `Interprétation de marché (spéculative) : ${evt.marketInterpretation.statement} — base : ${evt.marketInterpretation.basis}` : undefined,
                }))}
              />
            </>
          )}
          {timeline && <p style={{ color: 'var(--text-dim)', fontSize: 11 }}>{timeline.disclaimer}</p>}

          {/* Event creation form — exposes the existing POST /events endpoint.
              A source must already exist for this symbol (Overview → Rechercher),
              since the backend requires every event to cite a real source. */}
          <details style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Ajouter un événement</summary>
            {sources.length === 0 ? (
              <StudioEmptyState message="Recherche d'abord des sources depuis Overview — chaque événement doit citer une source réelle." />
            ) : (
              <div style={{ marginTop: 10 }}>
                <label>Source
                  <select className="studio-field" value={eventSourceId} onChange={e => setEventSourceId(e.target.value)}>
                    <option value="">Choisir une source</option>
                    {sources.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
                  </select>
                </label>
                <label>Type
                  <select className="studio-field" value={eventType} onChange={e => setEventType(e.target.value as EventType)}>
                    {EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label>Titre<input className="studio-field" value={eventTitle} onChange={e => setEventTitle(e.target.value)} /></label>
                <label>Date (optionnel)<input className="studio-field" type="date" value={eventDate} onChange={e => setEventDate(e.target.value)} /></label>
                <button type="button" className="studio-button studio-button--primary" disabled={busy || !eventSourceId || !eventTitle.trim()} onClick={() => void submitTimelineEvent()}>
                  Ajouter l'événement
                </button>
              </div>
            )}
          </details>
        </div>
      )}

      {section === 'PAPER PORTFOLIO' && (
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <select aria-label="Portefeuilles simulés" className="studio-field" style={{ width: 'auto', flex: 1, margin: 0 }} value={activePortfolioId} onChange={e => setActivePortfolioId(e.target.value)}>
              <option value="">Choisir un portefeuille</option>
              {portfolios.map(p => <option key={p.id} value={p.id}>{p.name} — cash {p.cash.toFixed(2)} {p.base_currency}</option>)}
            </select>
            <button type="button" className="studio-button studio-button--primary" disabled={busy} onClick={() => void createPortfolio()}>Nouveau portefeuille</button>
          </div>

          {activePortfolio ? (
            <>
              <p><strong>PAPER</strong> — simulation uniquement. Cash disponible : {activePortfolio.cash.toFixed(2)} {activePortfolio.base_currency}</p>

              {portfolioMetrics && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, margin: '10px 0' }}>
                  <div><span style={{ color: 'var(--text-dim)', fontSize: 11 }}>Valeur totale du compte</span><p style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{num(portfolioMetrics.totalAccountValue, 2)}</p></div>
                  <div><span style={{ color: 'var(--text-dim)', fontSize: 11 }}>Valeur de marché</span><p style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{num(portfolioMetrics.totalMarketValue, 2)}</p></div>
                  <div>
                    <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>P&amp;L latent</span>
                    <p style={{ margin: 0, fontSize: 16, fontWeight: 600, color: portfolioMetrics.totalUnrealizedPnl >= 0 ? 'var(--emerald)' : '#ff4d58' }}>
                      {num(portfolioMetrics.totalUnrealizedPnl, 2)} ({pct(portfolioMetrics.totalUnrealizedPnlPercent)})
                    </p>
                  </div>
                </div>
              )}
              <p style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                P&amp;L calculé à partir du dernier coût moyen (aucun prix de marché en direct) — voir positions pour le détail par symbole.
              </p>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end', margin: '12px 0' }}>
                <label>Action
                  <select aria-label="Type d'ordre simulé" className="studio-field" value={tradeAction} onChange={e => setTradeAction(e.target.value as PaperAction)}>
                    {ALLOWED_PAPER_ACTIONS.map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                </label>
                <label>Symbole<input className="studio-field" value={tradeSymbol} onChange={e => setTradeSymbol(e.target.value)} placeholder="AAPL" /></label>
                <label>Quantité<input className="studio-field" type="number" value={tradeQty} onChange={e => setTradeQty(e.target.value)} /></label>
                <label>Prix simulé<input className="studio-field" type="number" value={tradePrice} onChange={e => setTradePrice(e.target.value)} /></label>
                <button type="button" className="studio-button studio-button--primary" disabled={busy || !tradeSymbol.trim() || !tradeQty || !tradePrice} onClick={() => void submitTrade()}>Exécuter (simulé)</button>
              </div>

              <h3>Positions</h3>
              {positions.length === 0 ? <StudioEmptyState message="Aucune position." /> : (
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead><tr><th>Symbole</th><th>Quantité</th><th>Coût moyen</th><th>Valeur marché</th><th>P&amp;L latent</th></tr></thead>
                  <tbody>
                    {positions.map(p => {
                      const m = portfolioMetrics?.positions.find(pm => pm.symbol === p.symbol);
                      return (
                        <tr key={p.id}>
                          <td>{p.symbol}</td>
                          <td>{p.quantity}</td>
                          <td>{p.avg_cost_basis.toFixed(2)}</td>
                          <td>{m ? num(m.marketValue) : '—'}</td>
                          <td style={{ color: m && m.unrealizedPnl >= 0 ? 'var(--emerald)' : '#ff4d58' }}>{m ? num(m.unrealizedPnl) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              <h3>Historique</h3>
              {transactions.length === 0 ? <StudioEmptyState message="Aucune transaction." /> : (
                <ul>{transactions.map(t => <li key={t.id}>[PAPER] {t.action} {t.quantity} {t.symbol} @ {t.simulated_price} — {t.created_at}</li>)}</ul>
              )}
            </>
          ) : (
            <StudioEmptyState message="Créez ou sélectionnez un portefeuille simulé pour commencer." />
          )}
        </div>
      )}
    </StudioShell>
  );
}
