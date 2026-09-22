// Code Intelligence Studio — strictly read-only: repository text/filename/
// symbol search plus a git status/diff/log/show viewer. No Apply, Write,
// Commit, Reset, Checkout, or Run button exists anywhere in this file, by
// design (CI-21/CI-24) — this Studio observes and searches only.
import { useState } from 'react';
import { Code2 } from 'lucide-react';
import StudioShell from '../studio/StudioShell';
import StudioTabs from '../studio/StudioTabs';
import StudioStatus from '../studio/StudioStatus';
import StudioEmptyState from '../studio/StudioEmptyState';
import StudioErrorState from '../studio/StudioErrorState';
import {
  searchCodeIntel, searchCodeIntelSymbols, getCodeIntelGitStatus, getCodeIntelGitDiff, getCodeIntelGitLog, getCodeIntelGitShow,
  type CodeIntelSearchResult, type CodeIntelGitStatusEntry, type CodeIntelGitLogCommit,
} from '../../lib/code-intel-studio';

const TABS = ['SEARCH', 'SYMBOLS', 'GIT STATUS', 'DIFF', 'HISTORY'] as const;
type Tab = typeof TABS[number];

interface Props {
  onClose: () => void;
}

export default function CodeIntelStudioModal({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>('SEARCH');

  // Search tab
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'text' | 'filename'>('text');
  const [results, setResults] = useState<CodeIntelSearchResult[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  // Symbols tab
  const [symbolQuery, setSymbolQuery] = useState('');
  const [symbolResults, setSymbolResults] = useState<CodeIntelSearchResult[]>([]);
  const [symbolSearching, setSymbolSearching] = useState(false);
  const [symbolError, setSymbolError] = useState('');

  // Git status tab
  const [statusEntries, setStatusEntries] = useState<CodeIntelGitStatusEntry[] | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState('');

  // Diff tab
  const [diffStaged, setDiffStaged] = useState(false);
  const [diffPath, setDiffPath] = useState('');
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState('');

  // History tab
  const [commits, setCommits] = useState<CodeIntelGitLogCommit[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [showRef, setShowRef] = useState<string | null>(null);
  const [showContent, setShowContent] = useState<string | null>(null);

  async function runSearch() {
    if (!query.trim()) return;
    setSearching(true); setSearchError('');
    try {
      const res = await searchCodeIntel(query.trim(), kind, 50);
      setResults(res.results); setTruncated(res.truncated);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : 'Recherche impossible.');
    } finally { setSearching(false); }
  }

  async function runSymbolSearch() {
    if (!symbolQuery.trim()) return;
    setSymbolSearching(true); setSymbolError('');
    try {
      const res = await searchCodeIntelSymbols(symbolQuery.trim(), 50);
      setSymbolResults(res.results);
    } catch (e) {
      setSymbolError(e instanceof Error ? e.message : 'Recherche impossible.');
    } finally { setSymbolSearching(false); }
  }

  async function loadStatus() {
    setStatusLoading(true); setStatusError('');
    try {
      const res = await getCodeIntelGitStatus();
      setStatusEntries(res.entries);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : 'git status indisponible.');
    } finally { setStatusLoading(false); }
  }

  async function loadDiff() {
    setDiffLoading(true); setDiffError('');
    try {
      const res = await getCodeIntelGitDiff(diffStaged, diffPath.trim() || undefined);
      setDiffText(res.diff);
    } catch (e) {
      setDiffError(e instanceof Error ? e.message : 'git diff indisponible.');
    } finally { setDiffLoading(false); }
  }

  async function loadHistory() {
    setHistoryLoading(true); setHistoryError('');
    try {
      const res = await getCodeIntelGitLog(20);
      setCommits(res.commits);
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : 'git log indisponible.');
    } finally { setHistoryLoading(false); }
  }

  async function loadShow(hash: string) {
    setShowRef(hash); setShowContent(null); setHistoryError('');
    try {
      const res = await getCodeIntelGitShow(hash);
      setShowContent(res.content);
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : 'git show indisponible.');
    }
  }

  return (
    <StudioShell
      icon={<Code2 size={18} />}
      title="Code Intelligence"
      onClose={onClose}
      subtitle={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <StudioStatus label="LECTURE SEULE — READ ONLY" tone="neutral" compact />
          <span>Recherche et Git en lecture seule. Aucune écriture, aucun commit, aucun terminal.</span>
        </span>
      }
    >
      <StudioTabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'SEARCH' && (
        <div className="studio-section">
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') runSearch(); }}
              placeholder="Rechercher dans le code…"
              style={{ flex: 1 }}
            />
            <select value={kind} onChange={e => setKind(e.target.value as 'text' | 'filename')}>
              <option value="text">Texte</option>
              <option value="filename">Nom de fichier</option>
            </select>
            <button type="button" onClick={runSearch} disabled={searching || !query.trim()}>
              {searching ? 'Recherche…' : 'Rechercher'}
            </button>
          </div>
          {searchError && <StudioErrorState message={searchError} />}
          {!searchError && results.length === 0 && !searching && (
            <StudioEmptyState message="Aucun résultat. Lancez une recherche." />
          )}
          {results.length > 0 && (
            <ul className="studio-list">
              {results.map((r, i) => (
                <li key={`${r.relativePath}-${r.line}-${i}`} className="studio-list-item">
                  <div style={{ fontFamily: 'monospace', fontSize: 13 }}>
                    {r.relativePath}{r.line ? `:${r.line}` : ''}
                  </div>
                  {r.snippet && <pre style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.8, whiteSpace: 'pre-wrap' }}>{r.snippet}</pre>}
                </li>
              ))}
            </ul>
          )}
          {truncated && <p style={{ fontSize: 12, opacity: 0.7 }}>Résultats tronqués — affinez la recherche.</p>}
        </div>
      )}

      {tab === 'SYMBOLS' && (
        <div className="studio-section">
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>
            Recherche heuristique par motifs de déclaration (regex) — pas un index AST/LSP exact.
          </p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              type="text"
              value={symbolQuery}
              onChange={e => setSymbolQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') runSymbolSearch(); }}
              placeholder="Nom de symbole…"
              style={{ flex: 1 }}
            />
            <button type="button" onClick={runSymbolSearch} disabled={symbolSearching || !symbolQuery.trim()}>
              {symbolSearching ? 'Recherche…' : 'Rechercher'}
            </button>
          </div>
          {symbolError && <StudioErrorState message={symbolError} />}
          {!symbolError && symbolResults.length === 0 && !symbolSearching && (
            <StudioEmptyState message="Aucun symbole trouvé." />
          )}
          {symbolResults.length > 0 && (
            <ul className="studio-list">
              {symbolResults.map((r, i) => (
                <li key={`${r.relativePath}-${r.line}-${i}`} className="studio-list-item">
                  <div style={{ fontFamily: 'monospace', fontSize: 13 }}>
                    <span style={{ opacity: 0.6 }}>[{r.symbol}]</span> {r.relativePath}:{r.line}
                  </div>
                  {r.snippet && <pre style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.8 }}>{r.snippet}</pre>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'GIT STATUS' && (
        <div className="studio-section">
          <button type="button" onClick={loadStatus} disabled={statusLoading}>
            {statusLoading ? 'Chargement…' : 'Actualiser'}
          </button>
          {statusError && <StudioErrorState message={statusError} />}
          {statusEntries && statusEntries.length === 0 && <StudioEmptyState message="Aucune modification." />}
          {statusEntries && statusEntries.length > 0 && (
            <ul className="studio-list">
              {statusEntries.map((e, i) => (
                <li key={`${e.path}-${i}`} style={{ fontFamily: 'monospace', fontSize: 13 }}>
                  <span style={{ opacity: 0.6 }}>{e.statusCode}</span> {e.path}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'DIFF' && (
        <div className="studio-section">
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={diffStaged} onChange={e => setDiffStaged(e.target.checked)} />
              Indexé (staged)
            </label>
            <input
              type="text"
              value={diffPath}
              onChange={e => setDiffPath(e.target.value)}
              placeholder="Chemin optionnel (ex: src/App.tsx)"
              style={{ flex: 1 }}
            />
            <button type="button" onClick={loadDiff} disabled={diffLoading}>
              {diffLoading ? 'Chargement…' : 'Voir le diff'}
            </button>
          </div>
          {diffError && <StudioErrorState message={diffError} />}
          {diffText !== null && diffText.length === 0 && <StudioEmptyState message="Aucune différence." />}
          {diffText && (
            <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto' }}>{diffText}</pre>
          )}
        </div>
      )}

      {tab === 'HISTORY' && (
        <div className="studio-section">
          <button type="button" onClick={loadHistory} disabled={historyLoading}>
            {historyLoading ? 'Chargement…' : 'Charger l’historique'}
          </button>
          {historyError && <StudioErrorState message={historyError} />}
          {commits && commits.length === 0 && <StudioEmptyState message="Aucun commit." />}
          {commits && commits.length > 0 && (
            <ul className="studio-list">
              {commits.map(c => (
                <li key={c.hash} className="studio-list-item">
                  <div style={{ fontFamily: 'monospace', fontSize: 12, opacity: 0.7 }}>{c.hash.slice(0, 10)} — {c.author} — {c.date}</div>
                  <div>{c.subject}</div>
                  <button type="button" onClick={() => loadShow(c.hash)} style={{ fontSize: 12, marginTop: 4 }}>
                    Voir (git show)
                  </button>
                  {showRef === c.hash && showContent !== null && (
                    <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto', marginTop: 8 }}>{showContent}</pre>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </StudioShell>
  );
}
