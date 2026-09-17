import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { X, LineChart } from 'lucide-react';
import {
  investmentRequest, ALLOWED_PAPER_ACTIONS,
  type ResearchSource, type FundamentalsPeriod, type PaperPortfolio, type PaperPosition, type PaperTransaction, type PaperAction,
  type InvestmentScoring, type ScoreCategory, type InvestmentTimeline, type TimelineEvent,
} from '../../lib/investment-studio';

const field: CSSProperties = { display: 'block', width: '100%', background: '#171c27', border: '1px solid #455066', borderRadius: 6, padding: 9, color: '#e2e8f0', margin: '6px 0 14px' };
const button: CSSProperties = { background: '#283750', color: '#e2e8f0', border: '1px solid #536687', borderRadius: 6, padding: '8px 12px', cursor: 'pointer' };
const SECTIONS = ['OVERVIEW', 'FUNDAMENTALS', 'VALUATION', 'SCORING', 'RISKS', 'TIMELINE', 'PAPER PORTFOLIO'] as const;
type Section = typeof SECTIONS[number];
const SCORE_COLOR = (score: number | null) => score === null ? '#7a6c9a' : score >= 70 ? '#3dffaa' : score >= 40 ? '#ffb547' : '#ff4d58';

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
}

function ScoreCard({ category, expanded = false }: { category: ScoreCategory; expanded?: boolean }) {
  const [open, setOpen] = useState(expanded);
  return (
    <div style={{ background: '#131722', border: '1px solid #2c3648', borderRadius: 8, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>{category.category}</strong>
        <span style={{ color: SCORE_COLOR(category.score), fontWeight: 700 }}>{category.score === null ? '—' : category.score}</span>
      </div>
      {category.scoreMeaning && <p style={{ fontSize: 10, color: '#a9b6ce', margin: '4px 0' }}>{category.scoreMeaning}</p>}
      <p style={{ fontSize: 11, color: '#a9b6ce' }}>Complétude des données : {pct(category.dataCompleteness)}</p>
      <button type="button" style={{ ...button, fontSize: 11, padding: '4px 8px' }} onClick={() => setOpen(o => !o)}>
        {open ? 'Masquer le détail' : 'Voir le détail'}
      </button>
      {open && (
        <ul style={{ marginTop: 8, fontSize: 11, paddingLeft: 16 }}>
          {category.factors.map(f => (
            <li key={f.id} style={{ color: f.status === 'positive' ? '#3dffaa' : f.status === 'negative' ? '#ff4d58' : '#7a6c9a', marginBottom: 4 }}>
              {f.label} — {f.status === 'insufficient_data' ? 'donnée manquante' : String(f.value)}
              {f.note && ` (${f.note})`}
            </li>
          ))}
        </ul>
      )}
      {category.missingData.length > 0 && (
        <p style={{ fontSize: 10, color: '#7a6c9a', marginTop: 6 }}>Données manquantes : {category.missingData.join(', ')}</p>
      )}
    </div>
  );
}

function TimelineItem({ event }: { event: TimelineEvent }) {
  return (
    <li style={{ marginBottom: 10, fontSize: 12 }}>
      <span style={{ color: '#5ee7ff', fontFamily: 'monospace', fontSize: 10 }}>[{event.type.toUpperCase()}]</span>{' '}
      {event.dateReliable ? <strong>{event.date}</strong> : <em style={{ color: '#7a6c9a' }}>date non fiable</em>}
      {' — '}{event.title}
      {event.source && (
        <>
          {' '}(<a href={event.source.url} target="_blank" rel="noreferrer" style={{ color: '#5ee7ff' }}>source</a>
          {' · '}<span style={{ color: '#a9b6ce', fontSize: 10 }}>récupéré le {event.source.retrievedAt}</span>)
        </>
      )}
      {event.marketInterpretation && (
        <p style={{ fontSize: 10, color: '#ffb547', marginTop: 2 }}>
          Interprétation de marché (spéculative) : {event.marketInterpretation.statement} — base : {event.marketInterpretation.basis}
        </p>
      )}
    </li>
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

  const [portfolios, setPortfolios] = useState<PaperPortfolio[]>([]);
  const [activePortfolioId, setActivePortfolioId] = useState('');
  const [positions, setPositions] = useState<PaperPosition[]>([]);
  const [transactions, setTransactions] = useState<PaperTransaction[]>([]);
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
  }, []);

  useEffect(() => {
    if (activePortfolioId) void loadPortfolioDetail(activePortfolioId).catch(e => setError(e.message));
  }, [activePortfolioId, loadPortfolioDetail]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

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
    <div className="modal-backdrop" onClick={onClose}>
      <section
        role="dialog" aria-modal="true" aria-label="Studio Investissement"
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(960px, calc(100vw - 24px))', maxHeight: '90vh', overflowY: 'auto', background: '#0d0f14', color: '#e2e8f0', border: '1px solid #455066', borderRadius: 12, padding: 22 }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <LineChart />
          <h2 style={{ flex: 1 }}>Studio Investissement</h2>
          <button style={button} aria-label="Fermer Studio Investissement" onClick={onClose}><X size={18} /></button>
        </header>
        <p>Analyse, recherche et simulation uniquement — aucun broker réel, aucun ordre réel, aucune transaction réelle.</p>

        {error && <p role="alert" style={{ color: '#ffaaaa' }}>{error}</p>}

        <nav style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '12px 0' }}>
          {SECTIONS.map(s => (
            <button key={s} type="button" style={{ ...button, opacity: section === s ? 1 : 0.6 }} onClick={() => setSection(s)}>{s}</button>
          ))}
        </nav>

        {section === 'OVERVIEW' && (
          <div>
            <label>Symbole<input style={field} value={symbol} onChange={e => setSymbol(e.target.value)} placeholder="AAPL" /></label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button style={button} disabled={busy || !symbol.trim()} onClick={() => void runResearch()}>Rechercher (web)</button>
              <button style={button} disabled={busy || !symbol.trim()} onClick={() => void loadFundamentals()}>Charger fondamentaux</button>
              <button style={button} disabled={busy || !symbol.trim()} onClick={() => void loadScoring()}>Calculer le scoring</button>
              <button style={button} disabled={busy || !symbol.trim()} onClick={() => void loadTimeline()}>Charger la timeline</button>
            </div>
            {sources.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <h3>Sources (provenance)</h3>
                <ul>
                  {sources.map(s => (
                    <li key={s.id}>
                      <a href={s.url} target="_blank" rel="noreferrer" style={{ color: '#5ee7ff' }}>{s.title}</a>
                      {' — '}<span style={{ color: '#a9b6ce', fontSize: 12 }}>{s.dataRecency} · récupéré le {s.retrievedAt}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {section === 'FUNDAMENTALS' && (
          <div>
            {!fundamentals && <p role="status">Charge d'abord les fondamentaux depuis Overview.</p>}
            {fundamentals && fundamentals.length === 0 && <p role="status">Aucune donnée financière saisie pour ce symbole.</p>}
            {fundamentals && fundamentals.length > 0 && (
              <>
                {revenueCagr !== null && <p>CAGR revenus (période complète) : <strong>{pct(revenueCagr)}</strong></p>}
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead><tr><th>Période</th><th>Devise</th><th>Marge brute</th><th>Marge op.</th><th>Marge nette</th><th>ROE</th></tr></thead>
                  <tbody>
                    {fundamentals.map(p => (
                      <tr key={p.periodLabel}>
                        <td>{p.periodLabel} {p.dataKind === 'estimate' && '(estimation)'}</td>
                        <td>{p.currency}</td>
                        <td>{pct(p.metrics.grossMargin)}</td>
                        <td>{pct(p.metrics.operatingMargin)}</td>
                        <td>{pct(p.metrics.netMargin)}</td>
                        <td>{pct(p.metrics.roe)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p style={{ color: '#a9b6ce', fontSize: 11, marginTop: 8 }}>
                  Données saisies manuellement ou issues de recherche web — jamais un flux de marché en temps réel.
                </p>
              </>
            )}
          </div>
        )}

        {section === 'VALUATION' && (
          <p role="status">
            Utilise l'API /api/investment/valuation (multiples, DCF, reverse DCF) — chaque résultat affiche
            ses hypothèses complètes. Interface dédiée à construire dans une itération suivante.
          </p>
        )}

        {section === 'SCORING' && (
          <div>
            <p style={{ color: '#a9b6ce', fontSize: 12 }}>
              Scoring analytique — structure l'analyse, ne constitue jamais une recommandation d'achat ou de vente.
            </p>
            {!scoring && <p role="status">Calcule d'abord le scoring depuis Overview.</p>}
            {scoring && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, margin: '12px 0' }}>
                  {Object.values(scoring.categories).map(cat => <ScoreCard key={cat.category} category={cat} />)}
                </div>
                <p style={{ color: '#a9b6ce', fontSize: 11 }}>{scoring.disclaimer}</p>
              </>
            )}
          </div>
        )}

        {section === 'RISKS' && (
          <div>
            <p style={{ color: '#a9b6ce', fontSize: 12 }}>
              Séparation RISQUES CONNUS / INCERTITUDES / HYPOTHÈSES — facteurs détaillés dans le scoring Risk.
            </p>
            {scoring ? <ScoreCard category={scoring.categories.risk} expanded /> : (
              <p role="status">Calcule d'abord le scoring depuis Overview pour voir le détail des facteurs de risque.</p>
            )}
          </div>
        )}

        {section === 'TIMELINE' && (
          <div>
            {!timeline && <p role="status">Charge d'abord la timeline depuis Overview.</p>}
            {timeline && timeline.dated.length === 0 && timeline.undated.length === 0 && (
              <p role="status">Aucun événement enregistré pour ce symbole.</p>
            )}
            {timeline && timeline.dated.length > 0 && (
              <>
                <h3>Chronologie</h3>
                <ul>
                  {timeline.dated.map(evt => <TimelineItem key={evt.id} event={evt} />)}
                </ul>
              </>
            )}
            {timeline && timeline.undated.length > 0 && (
              <>
                <h3>Sans date fiable</h3>
                <ul>
                  {timeline.undated.map(evt => <TimelineItem key={evt.id} event={evt} />)}
                </ul>
              </>
            )}
            {timeline && <p style={{ color: '#a9b6ce', fontSize: 11 }}>{timeline.disclaimer}</p>}
          </div>
        )}

        {section === 'PAPER PORTFOLIO' && (
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
              <select aria-label="Portefeuilles simulés" style={{ ...field, width: 'auto', flex: 1, margin: 0 }} value={activePortfolioId} onChange={e => setActivePortfolioId(e.target.value)}>
                <option value="">Choisir un portefeuille</option>
                {portfolios.map(p => <option key={p.id} value={p.id}>{p.name} — cash {p.cash.toFixed(2)} {p.base_currency}</option>)}
              </select>
              <button style={button} disabled={busy} onClick={() => void createPortfolio()}>Nouveau portefeuille</button>
            </div>

            {activePortfolio && (
              <>
                <p><strong>PAPER</strong> — simulation uniquement. Cash disponible : {activePortfolio.cash.toFixed(2)} {activePortfolio.base_currency}</p>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end', margin: '12px 0' }}>
                  <label>Action<select aria-label="Type d'ordre simulé" style={field} value={tradeAction} onChange={e => setTradeAction(e.target.value as PaperAction)}>
                    {ALLOWED_PAPER_ACTIONS.map(a => <option key={a} value={a}>{a}</option>)}
                  </select></label>
                  <label>Symbole<input style={field} value={tradeSymbol} onChange={e => setTradeSymbol(e.target.value)} placeholder="AAPL" /></label>
                  <label>Quantité<input style={field} type="number" value={tradeQty} onChange={e => setTradeQty(e.target.value)} /></label>
                  <label>Prix simulé<input style={field} type="number" value={tradePrice} onChange={e => setTradePrice(e.target.value)} /></label>
                  <button style={button} disabled={busy || !tradeSymbol.trim() || !tradeQty || !tradePrice} onClick={() => void submitTrade()}>Exécuter (simulé)</button>
                </div>

                <h3>Positions</h3>
                {positions.length === 0 ? <p role="status">Aucune position.</p> : (
                  <ul>{positions.map(p => <li key={p.id}>{p.symbol} — {p.quantity} @ coût moyen {p.avg_cost_basis.toFixed(2)}</li>)}</ul>
                )}

                <h3>Historique</h3>
                {transactions.length === 0 ? <p role="status">Aucune transaction.</p> : (
                  <ul>{transactions.map(t => <li key={t.id}>[PAPER] {t.action} {t.quantity} {t.symbol} @ {t.simulated_price} — {t.created_at}</li>)}</ul>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
