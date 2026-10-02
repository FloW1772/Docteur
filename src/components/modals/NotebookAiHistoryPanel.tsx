import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Trash2, X, Upload, ShieldAlert, Check, Ban, Pencil, Search, Send, AlertTriangle, ArrowLeft, Sparkles } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type {
  AiImport, AiImportPreview, AiConversation, AiMessage, AiHistoryHit, AiHistoryAnswer, AiCitationPreview, AiCandidate, AiCandidateDetail,
  AiProvider, AiHistoryFilters, NotebookRetention,
} from '../../lib/cortex/client';

// NB-4 — imported AI histories. STRICT LOCAL: nothing here calls a cloud service. An imported history is
// UNTRUSTED DATA: roles stay distinct, a past AI answer is shown as "non vérifiée", and memory candidates
// are Notebook-scoped proposals that only a human can approve (there is NO "approve all" and NO global memory).
// Every server-provided string (titles, messages, statements, attachment names…) is rendered as a React
// text node — never as HTML.

type Tab = 'imports' | 'conversations' | 'search' | 'candidates';
const IN_PROGRESS = ['QUEUED', 'SCANNING', 'PARSING', 'NORMALIZING', 'SECURITY_SCAN', 'INDEXING'];
const PROVIDER_LABEL: Record<string, string> = { CHATGPT: 'ChatGPT', GEMINI: 'Gemini', CLAUDE: 'Claude', UNKNOWN: 'Provider non vérifié' };
const ROLE_LABEL: Record<string, string> = { USER: 'VOUS', ASSISTANT: 'IA (ancienne réponse, non vérifiée)', SYSTEM: 'SYSTÈME HISTORIQUE (donnée)', TOOL: 'RÉSULTAT D\'OUTIL (donnée)', UNKNOWN: 'INCONNU' };
const STATUS_COLOR: Record<string, string> = { READY: '#3dffaa', FAILED: '#ff4d58', CANCELLED: '#94a3b8', REVIEW_REQUIRED: '#f59e0b', DISTILLING: '#5ee7ff' };

const btn: React.CSSProperties = { background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)', borderRadius: 6, color: '#a78bfa', padding: '6px 12px', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 6 };
const ghost: React.CSSProperties = { ...btn, background: 'none', border: '1px solid rgba(255,255,255,0.12)', color: '#94a3b8' };
const input: React.CSSProperties = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#e2e8f0', padding: '7px 10px', fontSize: 12, fontFamily: 'inherit', outline: 'none' };
const select: React.CSSProperties = { ...input, padding: '4px 6px', fontSize: 10, background: '#100c1d' };
const card: React.CSSProperties = { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6 };
const fmtDate = (iso: string | null | undefined) => { if (!iso) return 'date inconnue'; try { return new Date(iso).toLocaleDateString('fr-FR'); } catch { return iso; } };

function Badge({ text, color = '#94a3b8', testid }: { text: string; color?: string; testid?: string }) {
  return <span data-testid={testid} className="font-mono" style={{ fontSize: 9, color, border: `1px solid ${color}55`, borderRadius: 4, padding: '1px 5px', letterSpacing: '0.04em' }}>{text}</span>;
}
const roleColor = (r: string) => (r === 'USER' ? '#3dffaa' : r === 'ASSISTANT' ? '#f59e0b' : '#94a3b8');

// ── Imports tab ─────────────────────────────────────────────────────────────
function ImportsTab({ notebookId, onChanged }: { notebookId: string; onChanged: () => void }) {
  const [imports, setImports] = useState<AiImport[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [declared, setDeclared] = useState<AiProvider | ''>('');
  const [policy, setPolicy] = useState<'block' | 'redact'>('block');
  const [retention, setRetention] = useState<NotebookRetention>('KEEP');
  const [duration, setDuration] = useState('24h');
  const [preview, setPreview] = useState<AiImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const reload = useCallback(async () => {
    try { const r = await cortexClient.aiHistoryImports(notebookId); if (alive.current) { setImports(r.imports); onChanged(); } } catch (e) { if (alive.current) setError((e as Error).message); }
  }, [notebookId, onChanged]);
  useEffect(() => { void reload(); }, [reload]);
  const active = imports.some(i => IN_PROGRESS.includes(i.status));
  useEffect(() => { if (!active) return; const t = setInterval(() => { void reload(); }, 1200); return () => clearInterval(t); }, [active, reload]);

  async function doPreview(f: File) {
    setError(null); setNotice(null); setPreview(null); setBusy(true);
    try { setPreview(await cortexClient.aiHistoryPreview(notebookId, f, { declaredProvider: declared || undefined, secretPolicy: policy })); }
    catch (e) { const err = e as Error & { code?: string }; setError(`${err.code ? `${err.code} — ` : ''}${err.message}`); }
    finally { setBusy(false); }
  }
  async function confirmImport() {
    if (!preview?.previewId) return;
    setBusy(true); setError(null);
    try {
      await cortexClient.aiHistoryImport(notebookId, { previewId: preview.previewId, secretPolicy: policy, retention, ...(retention === 'DELETE_AFTER' ? { retentionDuration: duration } : {}) });
      setPreview(null); setFile(null); setNotice('Import lancé — il n\'est READY qu\'une fois entièrement indexé.'); await reload();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function cancel(id: string) { try { await cortexClient.aiHistoryCancel(notebookId, id); setNotice('Annulation demandée — tout ce qui a été écrit est retiré.'); await reload(); } catch (e) { setError((e as Error).message); } }
  async function del(id: string) { setConfirmDelete(null); try { await cortexClient.aiHistoryDelete(notebookId, id); await reload(); } catch (e) { setError((e as Error).message); } }
  async function distill(id: string) {
    setBusy(true); setError(null);
    try { const r = await cortexClient.aiHistoryDistill(notebookId, id, false); setNotice(`Distillation ${r.method} : ${r.created} candidat(s) créé(s), ${r.extended} enrichi(s) — à relire dans l'onglet Candidats.`); await reload(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="p-3 flex flex-col gap-3" data-testid="ai-imports-tab">
      <div style={card} className="p-3">
        <p className="font-mono mb-2" style={{ fontSize: 11, color: '#c0b0e0' }}>Importer un historique IA (ChatGPT, Gemini, Claude ou format générique)</p>
        <p className="font-mono mb-2" style={{ fontSize: 9, color: '#5a4a7a', lineHeight: 1.5 }}>
          L'archive est lue en mémoire puis jetée : seuls les messages normalisés, leurs empreintes et leur provenance sont conservés. Rien n'est envoyé hors de cette machine.
          L'historique reste une donnée non fiable : une ancienne réponse d'IA n'est jamais présentée comme un fait vérifié.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" hidden data-testid="ai-file-input" accept=".zip,.json,.html,.htm,.md,.markdown,.txt"
            onChange={e => { const f = e.target.files?.[0] ?? null; e.target.value = ''; setFile(f); if (f) void doPreview(f); }} />
          <button type="button" data-testid="ai-pick-file" style={btn} disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={12} /> Choisir un export…</button>
          {file && <span className="font-mono" style={{ fontSize: 10, color: '#94a3b8' }}>{file.name}</span>}
          <label className="font-mono flex items-center gap-1" style={{ fontSize: 10, color: '#94a3b8' }}>Provider déclaré
            <select data-testid="ai-declared" aria-label="Provider déclaré (non vérifié)" style={select} value={declared} onChange={e => setDeclared(e.target.value as AiProvider | '')}>
              <option value="">Détection automatique</option><option value="CHATGPT">ChatGPT</option><option value="GEMINI">Gemini</option><option value="CLAUDE">Claude</option>
            </select></label>
          <label className="font-mono flex items-center gap-1" style={{ fontSize: 10, color: '#94a3b8' }}>Secrets
            <select data-testid="ai-policy" aria-label="Politique de secrets" style={select} value={policy} onChange={e => setPolicy(e.target.value as 'block' | 'redact')}>
              <option value="block">Bloquer les messages</option><option value="redact">Masquer les secrets</option></select></label>
          <label className="font-mono flex items-center gap-1" style={{ fontSize: 10, color: '#94a3b8' }}>Conservation
            <select data-testid="ai-retention" aria-label="Conservation" style={select} value={retention} onChange={e => setRetention(e.target.value as NotebookRetention)}>
              <option value="KEEP">Conserver</option><option value="MANUAL">Manuelle</option><option value="DELETE_AFTER">Supprimer après…</option><option value="SESSION_ONLY">Session uniquement</option></select></label>
          {retention === 'DELETE_AFTER' && (
            <select aria-label="Durée" style={select} value={duration} onChange={e => setDuration(e.target.value)}><option value="1h">1 h</option><option value="24h">24 h</option><option value="7d">7 j</option></select>
          )}
        </div>
        <p className="font-mono mt-2" style={{ fontSize: 9, color: '#5a4a7a' }}>Destination : ce Notebook uniquement.</p>
      </div>

      {busy && !preview && <p className="font-mono" role="status" style={{ fontSize: 11, color: '#5ee7ff' }}><RefreshCw size={10} className="animate-spin" style={{ display: 'inline', marginRight: 4 }} />Analyse locale de l'export…</p>}
      {error && <p className="font-mono" role="alert" data-testid="ai-error" style={{ fontSize: 11, color: '#ff4d58' }}>{error}</p>}
      {notice && <p className="font-mono" role="status" style={{ fontSize: 11, color: '#5ee7ff' }}>{notice}</p>}

      {preview && (
        <div style={card} className="p-3" data-testid="ai-preview" role="region" aria-label="Aperçu de l'import">
          <p className="font-mono flex items-center gap-2 flex-wrap" style={{ fontSize: 11, color: '#e2e8f0' }}>
            Aperçu · <Badge testid="ai-preview-provider" text={preview.providerVerified ? `${PROVIDER_LABEL[preview.provider]} (structure reconnue)` : 'provider non vérifié'} color={preview.providerVerified ? '#3dffaa' : '#f59e0b'} />
            <Badge text={preview.adapter} />{preview.syntheticCoverage && <Badge text="format testé sur fixtures synthétiques" color="#94a3b8" />}
          </p>
          <p className="font-mono mt-1" data-testid="ai-preview-counts" style={{ fontSize: 10, color: '#c0b0e0', lineHeight: 1.7 }}>
            {preview.counts.conversations} conversation(s) · {preview.counts.messages} message(s) · {fmtDate(preview.dateRange.from)} → {fmtDate(preview.dateRange.to)}<br />
            Pièces jointes : {preview.counts.attachments} (présentes {preview.counts.attachmentsAvailable}, absentes {preview.counts.attachmentsMissing}, non supportées {preview.counts.attachmentsUnsupported}, bloquées {preview.counts.attachmentsBlocked}) — leur contenu n'est pas indexé<br />
            Entrées d'archive refusées : {preview.blockedEntries.length}{preview.counts.invalid ? ` · conversations invalides : ${preview.counts.invalid}` : ''}
          </p>
          {preview.blockedEntries.length > 0 && <p className="font-mono" style={{ fontSize: 9, color: '#f59e0b' }}>{preview.blockedEntries.map(b => `${b.name} (${b.reason})`).join(', ')}</p>}
          {preview.findings.length > 0 ? (
            <p className="font-mono flex items-center gap-1.5 mt-1" data-testid="ai-preview-findings" role="alert" style={{ fontSize: 10, color: '#f59e0b' }}>
              <ShieldAlert size={11} /> Secrets détectés ({preview.findings.map(f => `${f.kind} ×${f.count}`).join(', ')}) — valeurs jamais affichées ; politique choisie : {policy === 'block' ? 'les messages concernés seront ignorés' : 'les secrets seront masqués (les clés privées restent bloquées)'}.
            </p>
          ) : <p className="font-mono mt-1" style={{ fontSize: 10, color: '#3dffaa' }}>Aucun secret détecté.</p>}
          <div className="flex gap-2 mt-2">
            <button type="button" data-testid="ai-confirm-import" style={btn} disabled={busy || !preview.previewId} onClick={() => void confirmImport()}><Check size={12} /> Confirmer l'import</button>
            <button type="button" data-testid="ai-cancel-preview" style={ghost} onClick={() => { setPreview(null); setFile(null); }}>Annuler</button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5" data-testid="ai-import-list">
        {imports.length === 0 && <p className="font-mono" style={{ fontSize: 11, color: '#3d3060' }}>Aucun historique importé.</p>}
        {imports.map(i => (
          <div key={i.importId} data-testid="ai-import-row" className="px-2.5 py-2" style={card}>
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono truncate" style={{ fontSize: 12, color: '#c0b0e0' }} title={i.sourceName}>{i.sourceName}</p>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span data-testid="ai-import-status" data-status={i.status} className="font-mono" style={{ fontSize: 10, color: STATUS_COLOR[i.status] ?? '#5ee7ff' }}>
                  {IN_PROGRESS.includes(i.status) && <RefreshCw size={8} className="animate-spin" style={{ display: 'inline', marginRight: 3 }} />}{i.status}{i.errorCode ? ` · ${i.errorCode}` : ''}
                </span>
                {IN_PROGRESS.includes(i.status) && <button type="button" data-testid="ai-cancel-import" style={{ ...ghost, fontSize: 10, padding: '2px 8px' }} onClick={() => void cancel(i.importId)}><X size={10} /> Annuler l'import</button>}
                {i.status === 'READY' && <button type="button" data-testid="ai-distill" style={{ ...ghost, fontSize: 10, padding: '2px 8px' }} disabled={busy} onClick={() => void distill(i.importId)}><Sparkles size={10} /> Distiller</button>}
                {confirmDelete === i.importId ? (
                  <span role="group" aria-label={`Confirmer la suppression de ${i.sourceName}`} className="flex gap-1">
                    <button type="button" data-testid="ai-delete-confirm" autoFocus style={{ ...btn, color: '#ff4d58', borderColor: 'rgba(255,77,88,0.4)', fontSize: 10, padding: '2px 8px' }} onClick={() => void del(i.importId)}>Supprimer</button>
                    <button type="button" data-testid="ai-delete-cancel" style={{ ...ghost, fontSize: 10, padding: '2px 8px' }} onClick={() => setConfirmDelete(null)}>Annuler</button>
                  </span>
                ) : <button type="button" data-testid="ai-delete" aria-label={`Supprimer l'import ${i.sourceName}`} style={{ background: 'none', border: 'none', color: '#5a4a7a', cursor: 'pointer' }} onClick={() => setConfirmDelete(i.importId)}><Trash2 size={13} /></button>}
              </div>
            </div>
            <p className="font-mono mt-1" style={{ fontSize: 9, color: '#5a4a7a' }}>
              {PROVIDER_LABEL[i.provider]}{i.providerVerified ? '' : ' (non vérifié)'} · {i.counts.conversations ?? 0} conv. · {i.counts.messagesNew ?? 0} messages ajoutés · {i.counts.messagesDuplicate ?? 0} doublons · {i.counts.messagesBlocked ?? 0} bloqués · {i.counts.chunks ?? 0} segments indexés
              {i.retention && i.retention !== 'KEEP' ? ` · ${i.retention}${i.expiresAt ? ` (${fmtDate(i.expiresAt)})` : ''}` : ''}
              {i.distillStatus && i.distillStatus !== 'NONE' ? ` · distillation : ${i.distillStatus}` : ''}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Conversations tab ───────────────────────────────────────────────────────
function ConversationsTab({ notebookId }: { notebookId: string }) {
  const [convs, setConvs] = useState<AiConversation[]>([]); const [total, setTotal] = useState(0); const [offset, setOffset] = useState(0);
  const [provider, setProvider] = useState<AiProvider | ''>(''); const [q, setQ] = useState('');
  const [open, setOpen] = useState<{ c: AiConversation; messages: AiMessage[]; total: number } | null>(null); const [error, setError] = useState<string | null>(null);
  const PAGE = 30;
  useEffect(() => { let live = true; (async () => { try { const r = await cortexClient.aiHistoryConversations(notebookId, { provider: provider || undefined, q: q || undefined, limit: PAGE, offset }); if (live) { setConvs(r.conversations); setTotal(r.total); } } catch (e) { if (live) setError((e as Error).message); } })(); return () => { live = false; }; }, [notebookId, provider, q, offset]);
  async function openConv(c: AiConversation) { try { const r = await cortexClient.aiHistoryMessages(notebookId, c.conversationId); setOpen({ c: r.conversation, messages: r.messages, total: r.total }); } catch (e) { setError((e as Error).message); } }

  if (open) {
    return (
      <div className="p-3" data-testid="ai-conversation-view">
        <button type="button" data-testid="ai-back" style={ghost} onClick={() => setOpen(null)}><ArrowLeft size={11} /> Conversations</button>
        <h3 className="font-mono mt-2" data-testid="ai-conv-title" style={{ fontSize: 13, color: '#f0eaff' }}>{open.c.title || '(sans titre)'}</h3>
        <p className="font-mono mb-2" style={{ fontSize: 9, color: '#5a4a7a' }}>{PROVIDER_LABEL[open.c.provider]}{open.c.providerVerified ? '' : ' (non vérifié)'} · {fmtDate(open.c.createdAt)} · {open.total} message(s)</p>
        <ol className="flex flex-col gap-1.5" aria-label="Messages de la conversation" style={{ listStyle: 'none', padding: 0 }}>
          {open.messages.map(m => (
            <li key={m.messageId} data-testid="ai-message" className="px-2.5 py-2" style={{ ...card, opacity: m.onMainPath && m.isCurrent ? 1 : 0.65 }}>
              <p className="font-mono flex items-center gap-2 flex-wrap" style={{ fontSize: 9 }}>
                <Badge testid="ai-msg-role" text={ROLE_LABEL[m.role] ?? m.role} color={roleColor(m.role)} /><span style={{ color: '#5a4a7a' }}>{fmtDate(m.createdAt)}</span><Badge text={m.trustLevel} />
                {!m.onMainPath && <Badge text="branche alternative" color="#f59e0b" />}{!m.isCurrent && <Badge text="version remplacée" color="#f59e0b" />}
                {m.flags.includes('redacted') && <Badge text="secrets masqués" color="#f59e0b" />}
              </p>
              <pre className="font-mono mt-1" data-testid="ai-msg-content" style={{ fontSize: 11, color: '#e2e8f0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{m.content}</pre>
              {(m.attachments ?? []).map(a => <p key={a.name + a.status} className="font-mono" data-testid="ai-attachment" style={{ fontSize: 9, color: '#94a3b8' }}>📎 {a.name} — {a.status} (non indexée)</p>)}
            </li>
          ))}
        </ol>
      </div>
    );
  }
  return (
    <div className="p-3 flex flex-col gap-2" data-testid="ai-conversations-tab">
      <div className="flex flex-wrap gap-2 items-center">
        <input style={{ ...input, flex: 1, minWidth: 140 }} aria-label="Filtrer par titre" placeholder="Filtrer par titre…" value={q} onChange={e => { setOffset(0); setQ(e.target.value); }} />
        <select data-testid="ai-conv-provider" aria-label="Filtrer par provider" style={select} value={provider} onChange={e => { setOffset(0); setProvider(e.target.value as AiProvider | ''); }}>
          <option value="">Tous les providers</option><option value="CHATGPT">ChatGPT</option><option value="GEMINI">Gemini</option><option value="CLAUDE">Claude</option><option value="UNKNOWN">Non vérifié</option></select>
      </div>
      {error && <p className="font-mono" role="alert" style={{ fontSize: 11, color: '#ff4d58' }}>{error}</p>}
      <ul className="flex flex-col gap-1" style={{ listStyle: 'none', padding: 0 }} aria-label="Conversations">
        {convs.length === 0 && <li className="font-mono" style={{ fontSize: 11, color: '#3d3060' }}>Aucune conversation.</li>}
        {convs.map(c => (
          <li key={c.conversationId}><button type="button" data-testid="ai-conv-open" onClick={() => void openConv(c)} className="w-full text-left px-2.5 py-2" style={{ ...card, cursor: 'pointer', color: '#c0b0e0', fontFamily: 'inherit' }}>
            <span className="font-mono" style={{ fontSize: 12 }}>{c.title || '(sans titre)'}</span>
            <span className="font-mono block" style={{ fontSize: 9, color: '#5a4a7a' }}>{PROVIDER_LABEL[c.provider]}{c.providerVerified ? '' : ' (non vérifié)'} · {fmtDate(c.createdAt)} · {c.messageCount} message(s)</span></button></li>
        ))}
      </ul>
      <div className="flex gap-2 items-center">
        <button type="button" style={ghost} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Précédent</button>
        <span className="font-mono" style={{ fontSize: 10, color: '#5a4a7a' }}>{total === 0 ? 0 : offset + 1}–{Math.min(total, offset + PAGE)} / {total}</span>
        <button type="button" style={ghost} disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Suivant</button>
      </div>
    </div>
  );
}

// ── Search / ask tab ────────────────────────────────────────────────────────
function SearchTab({ notebookId }: { notebookId: string }) {
  const [query, setQuery] = useState(''); const [provider, setProvider] = useState<AiProvider | ''>(''); const [role, setRole] = useState<'USER' | 'ASSISTANT' | ''>('');
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [trust, setTrust] = useState(''); const [broad, setBroad] = useState(false);
  const [hits, setHits] = useState<AiHistoryHit[] | null>(null); const [answer, setAnswer] = useState<AiHistoryAnswer | null>(null); const [mode, setMode] = useState<string | null>(null);
  const [preview, setPreview] = useState<AiCitationPreview | { error: string } | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => { if (preview) previewRef.current?.focus(); }, [preview]);
  const filters = (): AiHistoryFilters => ({ ...(provider ? { provider } : {}), ...(role ? { role } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(trust ? { trustLevels: [trust] } : {}), profile: broad ? 'broad' : 'precise' });
  async function run(kind: 'search' | 'ask') {
    const q = query.trim(); if (!q) return; setBusy(true); setError(null); setPreview(null);
    try {
      if (kind === 'search') { const r = await cortexClient.aiHistorySearch(notebookId, q, filters()); setHits(r.results); setAnswer(null); setMode(r.retrieval_mode); }
      else { const r = await cortexClient.aiHistoryAsk(notebookId, q, filters()); setAnswer(r); setHits(null); setMode(r.retrievalMode); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function open(chunkId: string, el: HTMLElement | null) { trigger.current = el; try { setPreview(await cortexClient.aiHistoryCitation(notebookId, chunkId)); } catch (e) { setPreview({ error: (e as Error).message }); } }
  const close = () => { setPreview(null); trigger.current?.focus(); };
  return (
    <div className="p-3 flex flex-col gap-2" data-testid="ai-search-tab">
      <div className="flex flex-wrap items-center gap-2">
        <select data-testid="ai-f-provider" aria-label="Provider" style={select} value={provider} onChange={e => setProvider(e.target.value as AiProvider | '')}><option value="">Tous providers</option><option value="CHATGPT">ChatGPT</option><option value="GEMINI">Gemini</option><option value="CLAUDE">Claude</option></select>
        <select data-testid="ai-f-role" aria-label="Locuteur" style={select} value={role} onChange={e => setRole(e.target.value as 'USER' | 'ASSISTANT' | '')}><option value="">Vous + IA</option><option value="USER">Mes messages seulement</option><option value="ASSISTANT">Réponses IA seulement</option></select>
        <label className="font-mono" style={{ fontSize: 10, color: '#94a3b8' }}>Du <input data-testid="ai-f-from" type="date" aria-label="Date de début" style={select} value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label className="font-mono" style={{ fontSize: 10, color: '#94a3b8' }}>au <input data-testid="ai-f-to" type="date" aria-label="Date de fin" style={select} value={to} onChange={e => setTo(e.target.value)} /></label>
        <select data-testid="ai-f-trust" aria-label="Niveau de confiance" style={select} value={trust} onChange={e => setTrust(e.target.value)}><option value="">Toute confiance</option><option value="USER_AUTHORED">USER_AUTHORED</option><option value="PAST_AI_OUTPUT">PAST_AI_OUTPUT</option><option value="TOOL_RESULT">TOOL_RESULT</option></select>
        <label className="font-mono flex items-center gap-1" style={{ fontSize: 10, color: '#94a3b8' }}><input type="checkbox" checked={broad} onChange={e => setBroad(e.target.checked)} /> Recherche large</label>
      </div>
      <div className="flex gap-2">
        <input data-testid="ai-query" aria-label="Recherche ou question sur les historiques" style={{ ...input, flex: 1 }} value={query} onChange={e => setQuery(e.target.value)} placeholder="Ex. : qu'est-ce que j'avais décidé sur Device Fabric ?" onKeyDown={e => { if (e.key === 'Enter' && !busy) void run('ask'); }} />
        <button type="button" data-testid="ai-search" aria-label="Rechercher" style={ghost} disabled={busy} onClick={() => void run('search')}><Search size={13} /></button>
        <button type="button" data-testid="ai-ask" aria-label="Poser la question (LLM local)" style={btn} disabled={busy} onClick={() => void run('ask')}>{busy ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />}</button>
      </div>
      {error && <p className="font-mono" role="alert" style={{ fontSize: 11, color: '#ff4d58' }}>{error}</p>}
      {mode && <p className="font-mono" data-testid="ai-retrieval-mode" role="status" style={{ fontSize: 10, color: mode === 'FTS_ONLY' ? '#f59e0b' : '#3dffaa' }}>{mode === 'FTS_ONLY' ? 'Recherche texte locale' : 'Recherche hybride locale (texte + vecteurs)'}</p>}
      <div data-testid="ai-results" aria-live="polite">
        {answer && (
          <div className="mb-2">
            {answer.status === 'NO_RELEVANT_SOURCE' && <p data-testid="ai-no-source" className="font-mono flex items-center gap-1.5" style={{ fontSize: 12, color: '#f59e0b' }}><AlertTriangle size={12} /> NO_RELEVANT_SOURCE — rien de pertinent dans les historiques importés.</p>}
            {answer.status === 'ANSWERED' && <p className="font-mono whitespace-pre-wrap" data-testid="ai-answer" style={{ fontSize: 12, color: '#e2e8f0', lineHeight: 1.6 }}>{answer.answer}</p>}
            {(answer.voices ?? []).length > 0 && <p className="font-mono mt-1" data-testid="ai-voices" style={{ fontSize: 9, color: '#94a3b8' }}>Voix distinctes : {answer.voices!.map(v => v.speaker).join(' · ')}</p>}
            {answer.sourceConflicts.length > 0 && <p data-testid="ai-conflicts" role="alert" className="font-mono mt-1" style={{ fontSize: 10, color: '#f59e0b' }}>⚠ {answer.sourceConflicts.length} conflit(s) possible(s) entre messages : {answer.sourceConflicts.map(c => `${c.a.sourceTitle} ↔ ${c.b.sourceTitle} (${c.type})`).join(' ; ')}</p>}
            {answer.uncertainties.filter(u => u.code !== 'SOURCE_CONFLICT').length > 0 && <ul data-testid="ai-uncertainties" className="font-mono mt-1" style={{ fontSize: 9, color: '#f59e0b', listStyle: 'disc', paddingLeft: 16 }}>{answer.uncertainties.filter(u => u.code !== 'SOURCE_CONFLICT').map(u => <li key={u.code}>{u.message}</li>)}</ul>}
            {answer.citations.map(c => (
              <div key={c.chunkId} data-testid="ai-citation" className="px-2.5 py-2 mt-1.5" style={card}>
                <button type="button" data-testid="ai-citation-open" aria-label={`Ouvrir la citation ${c.ref}`} onClick={e => void open(c.chunkId, e.currentTarget)} className="font-mono text-left" style={{ fontSize: 10, color: '#5ee7ff', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  [{c.ref}] {c.providerLabel} · {c.conversationTitle} · {ROLE_LABEL[c.role] ?? c.role} · {fmtDate(c.date)}
                </button>
                <p className="font-mono" style={{ fontSize: 9, color: c.verification === 'UNVERIFIED_PAST_AI' ? '#f59e0b' : '#3dffaa' }}>{c.verification === 'UNVERIFIED_PAST_AI' ? 'Ancienne réponse d\'IA — non vérifiée' : 'Votre propre message'}{c.branch ? ' · branche alternative' : ''}</p>
                <p className="font-mono mt-1" style={{ fontSize: 10, color: '#7a6c9a' }}>{c.passage}</p>
              </div>
            ))}
          </div>
        )}
        {hits && hits.length === 0 && <p className="font-mono" style={{ fontSize: 11, color: '#3d3060' }}>Aucun résultat.</p>}
        {(hits ?? []).map(h => (
          <div key={h.chunkId} data-testid="ai-hit" className="px-2.5 py-2 mb-1.5" style={card}>
            <button type="button" data-testid="ai-hit-open" aria-label={`Ouvrir l'extrait de ${h.conversationTitle}`} onClick={e => void open(h.chunkId, e.currentTarget)} className="font-mono text-left" style={{ fontSize: 10, color: '#5ee7ff', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              {h.providerLabel} · {h.conversationTitle} · {ROLE_LABEL[h.role] ?? h.role} · {fmtDate(h.date)} · {h.trustLevel}
            </button>
            {h.injectionFlags.length > 0 && <span className="font-mono" style={{ fontSize: 10, color: '#f59e0b' }}> · ⚠ texte d'instruction détecté (traité comme donnée)</span>}
            <p className="font-mono mt-1" style={{ fontSize: 10, color: '#7a6c9a', whiteSpace: 'pre-wrap' }}>{h.text}</p>
          </div>
        ))}
      </div>
      {preview && (
        <div ref={previewRef} tabIndex={-1} role="dialog" aria-label="Aperçu de la citation" data-testid="ai-citation-preview" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }} className="px-3 py-2" style={{ background: 'rgba(94,231,255,0.05)', border: '1px solid rgba(94,231,255,0.25)', borderRadius: 6, outline: 'none' }}>
          {'error' in preview ? <p className="font-mono" style={{ fontSize: 11, color: '#ff4d58' }}>{preview.error}</p> : (
            <>
              <p className="font-mono" data-testid="ai-preview-meta" style={{ fontSize: 10, color: '#5ee7ff' }}>{preview.providerLabel}{preview.providerVerified ? '' : ' (non vérifié)'} · {preview.conversationTitle} · {ROLE_LABEL[preview.role] ?? preview.role} · {fmtDate(preview.date)} · {preview.trustLevel}</p>
              {preview.messages.map(m => (
                <div key={m.messageId} data-testid="ai-preview-message" className="mt-2">
                  <p className="font-mono" style={{ fontSize: 9, color: roleColor(m.role) }}>{ROLE_LABEL[m.role] ?? m.role} · {fmtDate(m.createdAt)}{m.onMainPath ? '' : ' · branche alternative'}</p>
                  <pre className="font-mono" style={{ fontSize: 11, color: '#e2e8f0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{m.content}</pre>
                </div>
              ))}
            </>
          )}
          <button type="button" data-testid="ai-preview-close" aria-label="Fermer l'aperçu" style={{ ...ghost, marginTop: 8, fontSize: 10, padding: '3px 8px' }} onClick={close}><X size={10} /> Fermer</button>
        </div>
      )}
    </div>
  );
}

// ── Memory candidates tab ───────────────────────────────────────────────────
function CandidatesTab({ notebookId }: { notebookId: string }) {
  const [list, setList] = useState<AiCandidate[]>([]); const [status, setStatus] = useState('CANDIDATE'); const [type, setType] = useState(''); const [types, setTypes] = useState<string[]>([]);
  const [detail, setDetail] = useState<AiCandidateDetail | null>(null); const [editing, setEditing] = useState<{ id: string; text: string } | null>(null); const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => { try { const r = await cortexClient.aiHistoryCandidates(notebookId, { status: status || undefined, type: type || undefined }); setList(r.candidates); setTypes(r.types); } catch (e) { setError((e as Error).message); } }, [notebookId, status, type]);
  useEffect(() => { void reload(); }, [reload]);
  async function act(id: string, action: 'approve' | 'reject' | 'edit' | 'reopen', statement?: string) { setError(null); try { await cortexClient.aiHistoryReview(notebookId, id, action, statement); setEditing(null); await reload(); if (detail?.candidateId === id) setDetail(await cortexClient.aiHistoryCandidate(notebookId, id)); } catch (e) { setError((e as Error).message); } }
  async function show(id: string) { try { setDetail(await cortexClient.aiHistoryCandidate(notebookId, id)); } catch (e) { setError((e as Error).message); } }
  return (
    <div className="p-3 flex flex-col gap-2" data-testid="ai-candidates-tab">
      <p className="font-mono px-2.5 py-2" data-testid="ai-candidates-banner" style={{ ...card, fontSize: 10, color: '#94a3b8', lineHeight: 1.5 }}>
        Candidats de mémoire de CE Notebook — propositions dérivées de l'historique importé. Ce n'est <strong>pas</strong> la mémoire globale de Docteur : rien n'est promu sans ta relecture, et même approuvé, un candidat reste dans le Notebook.
      </p>
      <div className="flex gap-2">
        <select data-testid="ai-cand-status" aria-label="Statut" style={select} value={status} onChange={e => setStatus(e.target.value)}><option value="">Tous</option><option value="CANDIDATE">À relire</option><option value="APPROVED">Approuvés</option><option value="REJECTED">Rejetés</option><option value="SUPERSEDED">Remplacés</option></select>
        <select aria-label="Type" style={select} value={type} onChange={e => setType(e.target.value)}><option value="">Tous types</option>{types.map(t => <option key={t} value={t}>{t}</option>)}</select>
      </div>
      {error && <p className="font-mono" role="alert" style={{ fontSize: 11, color: '#ff4d58' }}>{error}</p>}
      <ul className="flex flex-col gap-1.5" style={{ listStyle: 'none', padding: 0 }} aria-label="Candidats de mémoire">
        {list.length === 0 && <li className="font-mono" style={{ fontSize: 11, color: '#3d3060' }}>Aucun candidat. Lance « Distiller » sur un import READY.</li>}
        {list.map(c => (
          <li key={c.candidateId} data-testid="ai-candidate" className="px-2.5 py-2" style={card}>
            <p className="font-mono flex items-center gap-2 flex-wrap" style={{ fontSize: 9 }}>
              <Badge text={c.type} color="#5ee7ff" /><Badge testid="ai-cand-trust" text={c.trustLevel} color={c.trustLevel === 'PAST_AI_OUTPUT' ? '#f59e0b' : '#3dffaa'} /><Badge text={c.status} color={STATUS_COLOR[c.status] ?? '#94a3b8'} />
              <span style={{ color: '#5a4a7a' }}>{c.evidenceCount ?? 0} preuve(s) · {c.conversationCount ?? 0} conv. · confiance {Math.round(c.confidence * 100)} % · {fmtDate(c.statedAt)}{c.method === 'llm' ? ' · LLM local' : ''}</span>
              {c.orphaned && <Badge text="sans preuve restante" color="#f59e0b" />}
            </p>
            {editing?.id === c.candidateId ? (
              <div className="flex gap-2 mt-1"><input style={{ ...input, flex: 1 }} aria-label="Modifier l'énoncé" data-testid="ai-cand-edit-input" value={editing.text} onChange={e => setEditing({ id: c.candidateId, text: e.target.value })} />
                <button type="button" data-testid="ai-cand-edit-save" style={btn} onClick={() => void act(c.candidateId, 'edit', editing.text)}>Enregistrer</button><button type="button" style={ghost} onClick={() => setEditing(null)}>Annuler</button></div>
            ) : <p className="font-mono mt-1" data-testid="ai-cand-statement" style={{ fontSize: 12, color: '#e2e8f0', whiteSpace: 'pre-wrap' }}>{c.statement}</p>}
            <div className="flex gap-1.5 mt-1.5 flex-wrap">
              {c.status !== 'APPROVED' && <button type="button" data-testid="ai-cand-approve" style={{ ...btn, fontSize: 10, padding: '3px 8px' }} onClick={() => void act(c.candidateId, 'approve')}><Check size={10} /> Approuver</button>}
              {c.status !== 'REJECTED' && <button type="button" data-testid="ai-cand-reject" style={{ ...ghost, fontSize: 10, padding: '3px 8px' }} onClick={() => void act(c.candidateId, 'reject')}><Ban size={10} /> Rejeter</button>}
              <button type="button" data-testid="ai-cand-edit" style={{ ...ghost, fontSize: 10, padding: '3px 8px' }} onClick={() => setEditing({ id: c.candidateId, text: c.statement })}><Pencil size={10} /> Modifier</button>
              <button type="button" data-testid="ai-cand-detail" style={{ ...ghost, fontSize: 10, padding: '3px 8px' }} onClick={() => void show(c.candidateId)}>Preuves</button>
              {c.status !== 'CANDIDATE' && <button type="button" style={{ ...ghost, fontSize: 10, padding: '3px 8px' }} onClick={() => void act(c.candidateId, 'reopen')}>Rouvrir</button>}
            </div>
          </li>
        ))}
      </ul>
      {detail && (
        <div data-testid="ai-cand-detail-panel" role="region" aria-label="Preuves du candidat" className="px-3 py-2" style={card}>
          <p className="font-mono" style={{ fontSize: 10, color: '#c0b0e0' }}>Preuves ({detail.evidence.length}) — chaque preuve renvoie à un vrai message</p>
          {detail.evidence.map(e => <p key={e.messageId} className="font-mono" data-testid="ai-evidence" style={{ fontSize: 10, color: '#94a3b8' }}>{PROVIDER_LABEL[e.provider]} · {e.conversationTitle} · {ROLE_LABEL[e.role] ?? e.role} · {fmtDate(e.ts)} — « {e.quote} »</p>)}
          {detail.links.map(l => <p key={`${l.candidateId}${l.relatedId}`} className="font-mono" data-testid="ai-supersession" style={{ fontSize: 10, color: '#f59e0b' }}>Remplacement possible ({l.ambiguous ? 'ambigu — à relire' : 'formulation explicite'}) : {l.detail}</p>)}
          <button type="button" style={{ ...ghost, marginTop: 6, fontSize: 10, padding: '3px 8px' }} onClick={() => setDetail(null)}><X size={10} /> Fermer</button>
        </div>
      )}
    </div>
  );
}

export default function NotebookAiHistoryPanel({ notebookId, onChanged }: { notebookId: string; onChanged?: () => void }) {
  const [tab, setTab] = useState<Tab>('imports');
  const changed = useRef(onChanged); changed.current = onChanged;
  const stableChanged = useCallback(() => changed.current?.(), []);
  const TABS: Array<[Tab, string]> = [['imports', 'Imports'], ['conversations', 'Conversations'], ['search', 'Recherche'], ['candidates', 'Candidats de mémoire']];
  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="ai-history-panel">
      <div role="tablist" aria-label="Historique IA" className="flex" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        {TABS.map(([t, label]) => (
          <button key={t} type="button" role="tab" id={`ai-tab-${t}`} aria-selected={tab === t} aria-controls={`ai-panel-${t}`} data-testid={`ai-tab-${t}`} onClick={() => setTab(t)}
            onKeyDown={e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const i = TABS.findIndex(x => x[0] === tab); const n = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0]; setTab(n); document.getElementById(`ai-tab-${n}`)?.focus(); } }}
            className="font-mono py-2 px-3" style={{ fontSize: 10, color: tab === t ? '#3dffaa' : '#5a4a7a', background: 'none', border: 'none', borderBottom: tab === t ? '2px solid #3dffaa' : '2px solid transparent', cursor: 'pointer' }}>{label}</button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto" role="tabpanel" id={`ai-panel-${tab}`} aria-labelledby={`ai-tab-${tab}`}>
        {tab === 'imports' && <ImportsTab notebookId={notebookId} onChanged={stableChanged} />}
        {tab === 'conversations' && <ConversationsTab notebookId={notebookId} />}
        {tab === 'search' && <SearchTab notebookId={notebookId} />}
        {tab === 'candidates' && <CandidatesTab notebookId={notebookId} />}
      </div>
    </div>
  );
}
