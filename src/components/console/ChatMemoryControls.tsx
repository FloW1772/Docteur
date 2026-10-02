import { useCallback, useEffect, useState } from 'react';
import { cortexClient } from '../../lib/cortex/client';
import type { AnswerResult, MemoryProject, Notebook } from '../../lib/cortex/client';

// NB-7 — Docteur Memory in the MAIN CHAT: the explicit controls and the "Mémoire utilisée : N" disclosure.
// STRICT LOCAL: memory is context the user approved; it is used only when relevant, only with an EXPLICIT project / notebook,
// and every memory that reached the model is listed under the answer (no hidden injection). Every server-provided string
// (statements, project / notebook names, evidence, titles) is rendered as a React text node — never as HTML.

const STORAGE_KEY = 'docteur.chatMemory.v1';
export interface ChatMemoryPrefs { enabled: boolean; project: string | null; notebook: string | null }
const DEFAULT_PREFS: ChatMemoryPrefs = { enabled: true, project: null, notebook: null };

function readPrefs(): ChatMemoryPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<ChatMemoryPrefs>;
    return { enabled: p.enabled !== false, project: typeof p.project === 'string' ? p.project : null, notebook: typeof p.notebook === 'string' ? p.notebook : null };
  } catch { return DEFAULT_PREFS; }
}

// Preferences only (switch + explicit selections) — never memory content.
export function useChatMemoryPrefs(): [ChatMemoryPrefs, (next: Partial<ChatMemoryPrefs>) => void] {
  const [prefs, setPrefs] = useState<ChatMemoryPrefs>(readPrefs);
  const update = useCallback((next: Partial<ChatMemoryPrefs>) => {
    setPrefs(prev => { const merged = { ...prev, ...next }; try { localStorage.setItem(STORAGE_KEY, JSON.stringify(merged)); } catch { /* storage unavailable: session only */ } return merged; });
  }, []);
  return [prefs, update];
}

const pill: React.CSSProperties = { fontSize: 10, padding: '3px 9px', borderRadius: 20, cursor: 'pointer' };
const sel: React.CSSProperties = { fontSize: 10, background: '#100c1d', color: '#c8b8e8', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: '2px 6px', maxWidth: 150 };

export function ChatMemoryControls({ prefs, onChange }: { prefs: ChatMemoryPrefs; onChange: (n: Partial<ChatMemoryPrefs>) => void }) {
  const [projects, setProjects] = useState<MemoryProject[]>([]);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  useEffect(() => {
    let alive = true;
    void cortexClient.memoryStatus().then(s => { if (alive) setProjects(s.projects); }).catch(() => {});
    void cortexClient.listNotebooks().then(r => { if (alive) setNotebooks(r.notebooks); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return (
    <div className="font-mono" data-testid="chat-memory-controls" style={{ display: 'flex', gap: 6, padding: '0 4px 8px', alignItems: 'center', flexWrap: 'wrap' }}>
      <button type="button" data-testid="chat-memory-toggle" role="switch" aria-checked={prefs.enabled} onClick={() => onChange({ enabled: !prefs.enabled })}
        title="Docteur Memory : souvenirs que tu as approuvés, utilisés seulement s'ils sont pertinents — 100 % local. OFF = aucun souvenir consulté pour cette conversation."
        style={{ ...pill, border: `1px solid ${prefs.enabled ? 'rgba(61,255,170,0.4)' : 'rgba(255,255,255,0.12)'}`, background: prefs.enabled ? 'rgba(61,255,170,0.1)' : 'transparent', color: prefs.enabled ? '#3dffaa' : '#7a6c9a' }}>
        🧠 Mémoire : {prefs.enabled ? 'ON' : 'OFF'}
      </button>
      {prefs.enabled && (
        <>
          <label style={{ fontSize: 10, color: '#7a6c9a' }}>Projet{' '}
            <select data-testid="chat-memory-project" aria-label="Projet pour la mémoire" style={sel} value={prefs.project ?? ''} onChange={e => onChange({ project: e.target.value || null })}>
              <option value="">— aucun (pas de mémoire de projet) —</option>
              {projects.map(p => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 10, color: '#7a6c9a' }}>Notebook{' '}
            <select data-testid="chat-memory-notebook" aria-label="Notebook pour la mémoire" style={sel} value={prefs.notebook ?? ''} onChange={e => onChange({ notebook: e.target.value || null })}>
              <option value="">— aucun —</option>
              {notebooks.map(n => <option key={n.id} value={n.id}>{n.title}</option>)}
            </select>
          </label>
          <span style={{ fontSize: 9, color: '#5a4a7a' }}>{prefs.project || prefs.notebook ? 'contexte explicite' : 'sans projet : seule la mémoire GLOBAL peut servir'}</span>
        </>
      )}
    </div>
  );
}

const SCOPE_LABEL = (u: NonNullable<AnswerResult['memoryUsed']>[number]) => (u.scope.kind === 'GLOBAL' ? 'GLOBAL' : u.scope.kind === 'PROJECT' ? `PROJET ${u.scope.projectId ?? ''}` : 'NOTEBOOK');

// Collapsed by default: « Mémoire utilisée : N ». Nothing is rendered when no memory reached the model.
export function ChatMemoryUsed({ answer }: { answer: AnswerResult }) {
  const used = answer.memoryUsed ?? []; const sources = answer.notebookSources ?? [];
  if (used.length === 0 && sources.length === 0) return null;
  const conflicts = answer.memory?.conflicts ?? [];
  return (
    <details data-testid="chat-memory-used" style={{ marginTop: 8, padding: '4px 8px', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6 }}>
      <summary className="font-mono" data-testid="chat-memory-used-summary" style={{ fontSize: 10, color: '#3dffaa', cursor: 'pointer' }}>
        Mémoire utilisée : {used.length}{sources.length > 0 ? ` · sources Notebook : ${sources.length}` : ''}
      </summary>
      <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }} aria-label="Souvenirs utilisés">
        {used.map(u => (
          <li key={u.memoryId} data-testid="chat-memory-item" className="font-mono" style={{ fontSize: 10, color: '#c0b0e0', marginBottom: 6, overflowWrap: 'anywhere' }}>
            <span style={{ color: '#5ee7ff' }}>[{u.marker}]</span> <span style={{ color: '#a78bfa' }}>{SCOPE_LABEL(u)}</span> · {u.type}
            {u.isHistorical && <span data-testid="chat-memory-historical" style={{ color: '#f59e0b' }}> · HISTORIQUE ({u.status})</span>}
            <span style={{ color: '#5a4a7a' }}> · {u.reason} {u.score}</span>
            <div data-testid="chat-memory-statement" style={{ color: '#e2e8f0', fontSize: 11 }}>{u.statement}</div>
            <div style={{ color: '#5a4a7a' }}>{u.provenance}</div>
            {u.evidence.length > 0 && <div data-testid="chat-memory-evidence" style={{ color: '#5a4a7a' }}>Preuves : {u.evidence.map(e => `${e.provider ?? e.kind}${e.status === 'OK' ? '' : ' (source supprimée)'}`).join(' · ')}</div>}
          </li>
        ))}
      </ul>
      {sources.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }} aria-label="Sources Notebook">
          {sources.map(s => (
            <li key={s.ref} data-testid="chat-notebook-source" className="font-mono" style={{ fontSize: 10, color: '#c0b0e0', overflowWrap: 'anywhere' }}>
              <span style={{ color: '#5ee7ff' }}>[{s.marker}]</span> {s.type}{s.type === 'AI_HISTORY_MESSAGE' ? ' (ancienne réponse IA, non vérifiée)' : ''} · {s.title}
            </li>
          ))}
        </ul>
      )}
      {conflicts.length > 0 && <p data-testid="chat-memory-conflict" className="font-mono" style={{ fontSize: 10, color: '#f59e0b', marginTop: 4 }}>Désaccord possible entre deux éléments de contexte : l'assistant a reçu les deux positions (la mémoire n'est pas une vérité supérieure).</p>}
    </details>
  );
}
