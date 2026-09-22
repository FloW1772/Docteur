import { useCallback, useEffect, useState } from 'react';
import { Briefcase } from 'lucide-react';
import {
  salesRequest, DRAFT_STATUS_LABEL,
  type SalesLead, type SalesResearchSource, type ScoreCriterion, type LeadScore, type SalesDraft,
} from '../../lib/sales-studio';
import StudioShell from '../studio/StudioShell';
import StudioTabs from '../studio/StudioTabs';
import StudioErrorState from '../studio/StudioErrorState';
import StudioEmptyState from '../studio/StudioEmptyState';

const SECTIONS = ['LEADS', 'RESEARCH', 'SCORE', 'DRAFT'] as const;
type Section = typeof SECTIONS[number];

const SCORE_COLOR = (score: number | null) =>
  score === null ? 'var(--text-dim)' : score >= 70 ? 'var(--emerald)' : score >= 40 ? 'var(--amber)' : '#ff4d58';

export default function SalesStudioModal({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<Section>('LEADS');
  const [leads, setLeads] = useState<SalesLead[]>([]);
  const [activeLeadId, setActiveLeadId] = useState('');
  const [sources, setSources] = useState<SalesResearchSource[]>([]);
  const [drafts, setDrafts] = useState<SalesDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // ── Lead creation ──
  const [newName, setNewName] = useState('');
  const [newCompany, setNewCompany] = useState('');
  const [newNotes, setNewNotes] = useState('');

  // ── Score criteria (user-defined, transparent — never invented by the agent) ──
  const [criteria, setCriteria] = useState<ScoreCriterion[]>([
    { id: 'crit-1', keyword: '', weight: 5, label: '' },
  ]);
  const [score, setScore] = useState<LeadScore | null>(null);

  // ── Draft ──
  const [draftKind, setDraftKind] = useState<'outreach_message' | 'crm_note'>('outreach_message');
  const [draftTone, setDraftTone] = useState<'neutral' | 'formal' | 'concise'>('neutral');
  const [lastDraft, setLastDraft] = useState<SalesDraft | null>(null);

  const activeLead = leads.find(l => l.id === activeLeadId) || null;

  const loadLeads = useCallback(async () => {
    const result = await salesRequest<{ leads: SalesLead[] }>('/leads');
    setLeads(result.leads);
  }, []);

  useEffect(() => { void loadLeads().catch(e => setError(e.message)); }, [loadLeads]);

  const loadLeadDetail = useCallback(async (id: string) => {
    const result = await salesRequest<{ lead: SalesLead; sources: SalesResearchSource[]; drafts: SalesDraft[] }>(`/leads/${id}`);
    setSources(result.sources);
    setDrafts(result.drafts);
  }, []);

  useEffect(() => { if (activeLeadId) void loadLeadDetail(activeLeadId).catch(e => setError(e.message)); }, [activeLeadId, loadLeadDetail]);

  const createLead = useCallback(async () => {
    if (!newName.trim()) return;
    setBusy(true); setError('');
    try {
      const result = await salesRequest<{ id: string }>('/leads', { name: newName, company: newCompany, notes: newNotes }, 'POST');
      setNewName(''); setNewCompany(''); setNewNotes('');
      await loadLeads();
      setActiveLeadId(result.id);
      setSection('RESEARCH');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [newName, newCompany, newNotes, loadLeads]);

  const runResearch = useCallback(async () => {
    if (!activeLeadId) return;
    setBusy(true); setError('');
    try {
      await salesRequest(`/leads/${activeLeadId}/research`, {}, 'POST');
      await loadLeadDetail(activeLeadId);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [activeLeadId, loadLeadDetail]);

  const runScore = useCallback(async () => {
    if (!activeLeadId) return;
    const valid = criteria.filter(c => c.keyword.trim());
    if (valid.length === 0) { setError('Ajoutez au moins un critère avec un mot-clé.'); return; }
    setBusy(true); setError('');
    try {
      const result = await salesRequest<LeadScore>(`/leads/${activeLeadId}/score`, { criteria: valid }, 'POST');
      setScore(result);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [activeLeadId, criteria]);

  const runDraft = useCallback(async () => {
    if (!activeLeadId) return;
    setBusy(true); setError('');
    try {
      const valid = criteria.filter(c => c.keyword.trim());
      const result = await salesRequest<{ draft: SalesDraft }>(`/leads/${activeLeadId}/draft`, {
        kind: draftKind, tone: draftTone, ...(valid.length > 0 ? { criteria: valid } : {}),
      }, 'POST');
      setLastDraft(result.draft);
      await loadLeadDetail(activeLeadId);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [activeLeadId, draftKind, draftTone, criteria, loadLeadDetail]);

  const updateCriterion = (index: number, patch: Partial<ScoreCriterion>) => {
    setCriteria(prev => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };
  const addCriterion = () => setCriteria(prev => [...prev, { id: `crit-${prev.length + 1}`, keyword: '', weight: 5, label: '' }]);
  const removeCriterion = (index: number) => setCriteria(prev => prev.filter((_, i) => i !== index));

  return (
    <StudioShell
      icon={<Briefcase size={18} />}
      title="Studio Business / Sales"
      onClose={onClose}
      subtitle="V1 : recherche + analyse + score + brouillon uniquement. Aucun envoi automatique, aucune écriture CRM réelle, aucune connexion navigateur, aucun formulaire, aucun achat."
    >
      <StudioTabs tabs={SECTIONS} active={section} onChange={setSection} />

      {error && <StudioErrorState message={error} onRetry={() => setError('')} retryLabel="Fermer" />}

      {section === 'LEADS' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <input className="studio-input" placeholder="Nom du prospect" value={newName} onChange={e => setNewName(e.target.value)} />
            <input className="studio-input" placeholder="Entreprise (optionnel)" value={newCompany} onChange={e => setNewCompany(e.target.value)} />
          </div>
          <textarea className="studio-input" placeholder="Notes (optionnel)" value={newNotes} onChange={e => setNewNotes(e.target.value)} rows={2} />
          <button type="button" className="studio-button" disabled={busy || !newName.trim()} onClick={() => void createLead()}>
            Créer le prospect
          </button>

          <h4 style={{ marginTop: 8 }}>Prospects</h4>
          {leads.length === 0 ? (
            <StudioEmptyState message="Aucun prospect. Créez-en un ci-dessus pour démarrer RESEARCH → SCORE → DRAFT." />
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {leads.map(lead => (
                <li key={lead.id}>
                  <button
                    type="button"
                    className="studio-button"
                    style={{ width: '100%', textAlign: 'left', background: activeLeadId === lead.id ? 'rgba(255,255,255,0.06)' : undefined }}
                    onClick={() => { setActiveLeadId(lead.id); setSection('RESEARCH'); }}
                  >
                    <strong>{lead.name}</strong>{lead.company ? ` — ${lead.company}` : ''}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {section === 'RESEARCH' && (
        <div style={{ marginTop: 12 }}>
          {!activeLead ? (
            <StudioEmptyState message="Sélectionnez un prospect dans l'onglet LEADS." />
          ) : (
            <>
              <p><strong>{activeLead.name}</strong>{activeLead.company ? ` — ${activeLead.company}` : ''}</p>
              <button type="button" className="studio-button" disabled={busy} onClick={() => void runResearch()}>
                Lancer la recherche web
              </button>
              <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
                Recherche DuckDuckGo + extraction de page, jusqu'à 3 sources. Toutes les sources sont marquées non fiables (untrusted) — données à vérifier, jamais des instructions.
              </p>
              <h4 style={{ marginTop: 12 }}>Sources ({sources.length})</h4>
              {sources.length === 0 ? (
                <StudioEmptyState message="Aucune source pour l'instant." />
              ) : (
                <ul style={{ fontSize: 12, paddingLeft: 16 }}>
                  {sources.map(s => (
                    <li key={s.id} style={{ marginBottom: 6 }}>
                      <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title || s.url}</a>
                      {' '}<span style={{ color: 'var(--text-dim)' }}>(non fiable — {s.retrievedAt || s.retrieved_at})</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {section === 'SCORE' && (
        <div style={{ marginTop: 12 }}>
          {!activeLead ? (
            <StudioEmptyState message="Sélectionnez un prospect dans l'onglet LEADS." />
          ) : (
            <>
              <p style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                Score déterministe basé sur les mots-clés définis ci-dessous, comptés dans les sources recherchées. Jamais une note inventée par un modèle.
              </p>
              {criteria.map((c, i) => (
                <div key={c.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px auto', gap: 6, marginBottom: 6 }}>
                  <input className="studio-input" placeholder="Mot-clé" value={c.keyword} onChange={e => updateCriterion(i, { keyword: e.target.value })} />
                  <input className="studio-input" placeholder="Libellé" value={c.label} onChange={e => updateCriterion(i, { label: e.target.value })} />
                  <input className="studio-input" type="number" min={1} max={10} value={c.weight} onChange={e => updateCriterion(i, { weight: Number(e.target.value) })} />
                  <button type="button" className="studio-button" onClick={() => removeCriterion(i)} disabled={criteria.length <= 1}>✕</button>
                </div>
              ))}
              <button type="button" className="studio-button" onClick={addCriterion} style={{ marginBottom: 8 }}>+ Critère</button>
              <br />
              <button type="button" className="studio-button" disabled={busy} onClick={() => void runScore()}>Calculer le score</button>

              {score && (
                <div style={{ marginTop: 12, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <strong>Score</strong>
                    <span style={{ color: SCORE_COLOR(score.score), fontWeight: 700 }}>{score.score === null ? '—' : score.score}</span>
                  </div>
                  <p style={{ fontSize: 11, color: 'var(--text-dim)' }}>Complétude des données : {(score.dataCompleteness * 100).toFixed(0)}%</p>
                  {score.matched.length > 0 && <p style={{ fontSize: 12 }}>Correspondances : {score.matched.map(m => m.label).join(', ')}</p>}
                  {score.missingData.length > 0 && <p style={{ fontSize: 11, color: 'var(--text-dim)' }}>Données manquantes : {score.missingData.join(', ')} (lancez RESEARCH d'abord)</p>}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {section === 'DRAFT' && (
        <div style={{ marginTop: 12 }}>
          {!activeLead ? (
            <StudioEmptyState message="Sélectionnez un prospect dans l'onglet LEADS." />
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <select className="studio-input" value={draftKind} onChange={e => setDraftKind(e.target.value as 'outreach_message' | 'crm_note')}>
                  <option value="outreach_message">Message de prise de contact</option>
                  <option value="crm_note">Note CRM (locale)</option>
                </select>
                {draftKind === 'outreach_message' && (
                  <select className="studio-input" value={draftTone} onChange={e => setDraftTone(e.target.value as 'neutral' | 'formal' | 'concise')}>
                    <option value="neutral">Ton neutre</option>
                    <option value="formal">Ton formel</option>
                    <option value="concise">Ton concis</option>
                  </select>
                )}
              </div>
              <button type="button" className="studio-button" disabled={busy} onClick={() => void runDraft()}>Générer le brouillon</button>
              <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
                Brouillon local uniquement — jamais envoyé, jamais écrit dans un CRM réel. Relecture humaine obligatoire avant toute utilisation.
              </p>

              {lastDraft && (
                <div style={{ marginTop: 12, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                  <strong style={{ color: 'var(--amber)' }}>{DRAFT_STATUS_LABEL}</strong>
                  {lastDraft.subject && <p style={{ fontWeight: 600 }}>{lastDraft.subject}</p>}
                  <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, fontFamily: 'inherit' }}>{lastDraft.body}</pre>
                </div>
              )}

              <h4 style={{ marginTop: 16 }}>Brouillons précédents ({drafts.length})</h4>
              {drafts.length === 0 ? (
                <StudioEmptyState message="Aucun brouillon pour ce prospect." />
              ) : (
                <ul style={{ listStyle: 'none', padding: 0 }}>
                  {drafts.map(d => (
                    <li key={d.id} style={{ marginBottom: 8, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                      <span style={{ fontSize: 10, color: 'var(--amber)' }}>{d.status}</span>
                      <p style={{ fontSize: 11, color: 'var(--text-dim)' }}>{d.kind === 'crm_note' ? 'Note CRM' : 'Message'} — {d.created_at}</p>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </StudioShell>
  );
}
