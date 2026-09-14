import { useEffect, useState, useCallback } from 'react';
import { Wand2, X, Copy, Check, RefreshCw, Trash2, Star, Search, Send, Settings, Plus, ArrowUp, ArrowDown, Library } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type { GeneratedPrompt, PromptGeneratorModelOption, PromptOutcome, PromptDestination, PromptSendEvent, PromptTemplate } from '../../lib/cortex/client';

const MAX_PREFILL_URL_LENGTH = 2000;

interface Props {
  onClose: () => void;
  strictLocalMode: boolean;
}

const OUTCOME_LABELS: Record<PromptOutcome, string> = {
  untested: 'Non testé',
  worked:   'A fonctionné',
  half:     'Partiellement',
  broken:   'Échoué',
};

const OUTCOME_COLORS: Record<PromptOutcome, string> = {
  untested: '#94a3b8',
  worked:   '#3dffaa',
  half:     '#ffb547',
  broken:   '#ff4d58',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const modalStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
};
const panelStyle: React.CSSProperties = {
  width: 760, maxWidth: 'calc(100vw - 24px)', maxHeight: '86vh', display: 'flex', flexDirection: 'column',
  background: '#0d0f14', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12, overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.7)',
};
const labelStyle: React.CSSProperties = { fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', letterSpacing: '0.05em', marginBottom: 4, display: 'block' };
const selectStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6, color: '#e2e8f0', padding: '6px 10px', fontSize: 12, width: '100%',
  fontFamily: 'inherit', outline: 'none',
};
const btnStyle: React.CSSProperties = {
  background: 'rgba(94,231,255,0.1)', border: '1px solid rgba(94,231,255,0.3)',
  borderRadius: 6, color: '#5ee7ff', padding: '6px 12px', fontSize: 12, cursor: 'pointer',
  fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
};
const iconBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', display: 'flex', padding: 4,
};

function ModelPicker({
  label, options, value, onChange, disabled,
}: {
  label: string;
  options: { id: string; provider: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ flex: 1 }}>
      <span style={labelStyle}>{label}</span>
      <select
        style={selectStyle}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
      >
        <option value="">— choisir —</option>
        {options.map(o => (
          <option key={`${o.provider}:${o.id}`} value={`${o.provider}:${o.id}`}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      style={{ ...btnStyle, padding: '4px 10px' }}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? 'Copié' : 'Copier'}
    </button>
  );
}

function sortDestinations(list: PromptDestination[]): PromptDestination[] {
  return [...list].sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    return a.order - b.order;
  });
}

function groupDestinationsByCategory(list: PromptDestination[]): Array<{ category: string; items: PromptDestination[] }> {
  const sorted = sortDestinations(list);
  const groups: Array<{ category: string; items: PromptDestination[] }> = [];
  for (const d of sorted) {
    let group = groups.find(g => g.category === d.category);
    if (!group) { group = { category: d.category, items: [] }; groups.push(group); }
    group.items.push(d);
  }
  return groups;
}

interface SendPanelProps {
  destinations: PromptDestination[];
  events: PromptSendEvent[];
  onSend: (d: PromptDestination) => void;
  notice: { text: string; link?: string } | null;
  onClose: () => void;
}

function SendPanel({ destinations, events, onSend, notice, onClose }: SendPanelProps) {
  const groups = groupDestinationsByCategory(destinations);
  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(94,231,255,0.2)', borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={labelStyle}>ENVOYER VERS…</span>
        <button type="button" style={iconBtnStyle} onClick={onClose}><X size={13} /></button>
      </div>

      {groups.length === 0 && <div style={{ fontSize: 12, color: '#64748b' }}>Aucune destination configurée.</div>}

      {groups.map(g => (
        <div key={g.category}>
          <div style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace', letterSpacing: '0.04em', marginBottom: 4 }}>{g.category}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {g.items.map(d => (
              <button
                key={d.id}
                type="button"
                style={{ ...btnStyle, padding: '4px 10px', background: d.favorite ? 'rgba(255,181,71,0.1)' : btnStyle.background, borderColor: d.favorite ? 'rgba(255,181,71,0.3)' : (btnStyle.border as string) }}
                onClick={() => onSend(d)}
                title={d.url || 'Copie uniquement'}
              >
                {d.favorite && <Star size={10} color="#ffb547" fill="#ffb547" />}
                {d.name}
              </button>
            ))}
          </div>
        </div>
      ))}

      {notice && (
        <div style={{ fontSize: 12, color: '#3dffaa', background: 'rgba(61,255,170,0.08)', border: '1px solid rgba(61,255,170,0.2)', borderRadius: 6, padding: '6px 10px' }}>
          {notice.text}
          {notice.link && (
            <>
              {' — '}
              <a href={notice.link} target="_blank" rel="noreferrer" style={{ color: '#5ee7ff' }}>ouvrir le lien</a>
            </>
          )}
        </div>
      )}

      {events.length > 0 && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ ...labelStyle, marginBottom: 0 }}>HISTORIQUE D'ENVOI</span>
          {events.map(e => (
            <div key={e.id} style={{ fontSize: 11, color: '#94a3b8' }}>
              {e.destination_name} · {formatDate(e.created_at)} {e.prefill_used && <span style={{ color: '#5ee7ff' }}>· préremplis</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface DestinationFormState {
  id: string | null;
  name: string;
  url: string;
  category: string;
  urlTemplate: string;
  favorite: boolean;
}

const EMPTY_DEST_FORM: DestinationFormState = { id: null, name: '', url: '', category: '', urlTemplate: '', favorite: false };

function DestinationsManager({
  destinations, categories, onReload,
}: {
  destinations: PromptDestination[];
  categories: string[];
  onReload: (list: PromptDestination[]) => void;
}) {
  const [form, setForm] = useState<DestinationFormState>(EMPTY_DEST_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const groups = groupDestinationsByCategory(destinations);

  async function handleSubmit() {
    setFormError(null);
    if (!form.name.trim()) { setFormError('Nom requis'); return; }
    try {
      const payload = {
        name: form.name.trim(),
        url: form.url.trim(),
        category: form.category.trim() || 'AUTRES',
        urlTemplate: form.urlTemplate.trim(),
        favorite: form.favorite,
      };
      const list = form.id
        ? await cortexClient.updatePromptDestination(form.id, payload)
        : await cortexClient.addPromptDestination(payload);
      onReload(list);
      setForm(EMPTY_DEST_FORM);
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  async function handleDelete(id: string) {
    try {
      const list = await cortexClient.deletePromptDestination(id);
      onReload(list);
    } catch { /* ignore */ }
  }

  async function handleFavoriteToggle(d: PromptDestination) {
    try {
      const list = await cortexClient.updatePromptDestination(d.id, { favorite: !d.favorite });
      onReload(list);
    } catch { /* ignore */ }
  }

  async function handleMove(id: string, direction: -1 | 1) {
    const ids = sortDestinations(destinations).map(d => d.id);
    const idx = ids.indexOf(id);
    const swapWith = idx + direction;
    if (swapWith < 0 || swapWith >= ids.length) return;
    [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
    try {
      const list = await cortexClient.reorderPromptDestinations(ids);
      onReload(list);
    } catch { /* ignore */ }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 11, color: '#64748b' }}>
        Gère les destinations proposées dans « Envoyer vers… ». Le préremplissage n'est possible que si le site le permet
        via un paramètre d'URL — essaie d'ouvrir <code>https://chatgpt.com/?q=test</code> et regarde si le champ se prérempli.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: 10 }}>
        <span style={labelStyle}>{form.id ? 'MODIFIER LA DESTINATION' : 'AJOUTER UNE DESTINATION'}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <input style={selectStyle} placeholder="Nom" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <input style={selectStyle} placeholder="URL (optionnelle, http/https)" value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input style={selectStyle} placeholder="Catégorie" list="prompt-dest-categories" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} />
          <datalist id="prompt-dest-categories">
            {categories.map(c => <option key={c} value={c} />)}
          </datalist>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={form.favorite} onChange={e => setForm({ ...form, favorite: e.target.checked })} />
            Favori
          </label>
        </div>
        <div>
          <input style={selectStyle} placeholder="Modèle d'URL de préremplissage, ex: https://chatgpt.com/?q={prompt}" value={form.urlTemplate} onChange={e => setForm({ ...form, urlTemplate: e.target.value })} />
          <div style={{ fontSize: 10, color: '#64748b', marginTop: 3 }}>
            Essaie d'ouvrir https://chatgpt.com/?q=test et regarde si le champ se prérempli.
          </div>
        </div>
        {formError && <div style={{ fontSize: 11, color: '#ff4d58' }}>{formError}</div>}
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" style={btnStyle} onClick={() => void handleSubmit()}>
            <Plus size={12} /> {form.id ? 'Enregistrer' : 'Ajouter'}
          </button>
          {form.id && <button type="button" style={iconBtnStyle} onClick={() => setForm(EMPTY_DEST_FORM)}>Annuler</button>}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {groups.map(g => (
          <div key={g.category}>
            <div style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace', letterSpacing: '0.04em', marginBottom: 4 }}>{g.category}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {g.items.map(d => (
                <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: '6px 8px' }}>
                  <button type="button" style={iconBtnStyle} onClick={() => void handleFavoriteToggle(d)} title="Favori">
                    <Star size={12} color={d.favorite ? '#ffb547' : '#64748b'} fill={d.favorite ? '#ffb547' : 'none'} />
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: '#e2e8f0' }}>{d.name}</div>
                    <div style={{ fontSize: 10, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.url || 'copie uniquement'}</div>
                  </div>
                  <button type="button" style={iconBtnStyle} onClick={() => void handleMove(d.id, -1)} title="Monter"><ArrowUp size={12} /></button>
                  <button type="button" style={iconBtnStyle} onClick={() => void handleMove(d.id, 1)} title="Descendre"><ArrowDown size={12} /></button>
                  <button type="button" style={iconBtnStyle} onClick={() => setForm({ id: d.id, name: d.name, url: d.url, category: d.category, urlTemplate: d.urlTemplate, favorite: d.favorite })} title="Modifier"><Settings size={12} /></button>
                  <button type="button" style={iconBtnStyle} onClick={() => void handleDelete(d.id)} title="Supprimer"><Trash2 size={12} color="#ff4d58" /></button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Bibliothèque de modèles ("Modèles") ───────────────────────────────────────
// Loads a template's prompt_text into the editor (request textarea) — never
// sends it anywhere, never calls generatePrompt(). Selecting a template is a
// pure local copy: the loaded text is a plain string in React state from
// then on, fully editable, and never overwrites the stored template row
// (editing here edits the in-editor copy only; use the pencil icon to edit
// the library entry itself).
function TemplateLibrary({
  templates, onReload, onLoad,
}: {
  templates: PromptTemplate[];
  onReload: (list: PromptTemplate[]) => void;
  onLoad: (text: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ name: string; category: string; description: string; prompt_text: string }>({ name: '', category: '', description: '', prompt_text: '' });
  const [formError, setFormError] = useState<string | null>(null);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? templates.filter(t => t.name.toLowerCase().includes(q) || t.category.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
    : templates;

  const groups: { category: string; items: PromptTemplate[] }[] = [];
  for (const t of filtered) {
    let g = groups.find(g => g.category === t.category);
    if (!g) { g = { category: t.category, items: [] }; groups.push(g); }
    g.items.push(t);
  }

  function startEdit(t: PromptTemplate) {
    setEditingId(t.id);
    setEditForm({ name: t.name, category: t.category, description: t.description, prompt_text: t.prompt_text });
    setFormError(null);
  }

  async function handleSaveEdit() {
    if (!editingId) return;
    if (!editForm.name.trim()) { setFormError('Nom requis'); return; }
    if (!editForm.prompt_text.trim()) { setFormError('Prompt requis'); return; }
    try {
      await cortexClient.updatePromptTemplate(editingId, {
        name: editForm.name.trim(),
        category: editForm.category.trim() || 'Autres',
        description: editForm.description.trim(),
        prompt_text: editForm.prompt_text,
      });
      const list = await cortexClient.getPromptTemplates();
      onReload(list);
      setEditingId(null);
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  async function handleDuplicate(t: PromptTemplate) {
    try {
      await cortexClient.createPromptTemplate({
        name: `${t.name} (copie)`,
        category: t.category,
        description: t.description,
        prompt_text: t.prompt_text,
      });
      const list = await cortexClient.getPromptTemplates();
      onReload(list);
    } catch { /* ignore */ }
  }

  async function handleDelete(id: string) {
    try {
      await cortexClient.deletePromptTemplate(id);
      const list = await cortexClient.getPromptTemplates();
      onReload(list);
    } catch { /* ignore */ }
  }

  async function handleLoad(t: PromptTemplate) {
    // Loads a COPY into the editor — the stored template row is untouched.
    // touchPromptTemplate only bumps last_used_at bookkeeping; it never
    // triggers an AI call or sends the prompt anywhere.
    onLoad(t.prompt_text);
    void cortexClient.touchPromptTemplate(t.id).catch(() => { /* non-critical */ });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 11, color: '#64748b' }}>
        Clique sur un modèle pour charger une copie de son texte dans la zone « Demande » ci-dessous — reste entièrement modifiable avant toute génération. Aucun appel IA n'a lieu ici.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Search size={12} color="#64748b" />
        <input style={selectStyle} placeholder="Rechercher un modèle…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 320, overflowY: 'auto' }}>
        {groups.map(g => (
          <div key={g.category}>
            <div style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace', letterSpacing: '0.04em', marginBottom: 4 }}>{g.category.toUpperCase()}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {g.items.map(t => (
                <div key={t.id} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: '8px 10px' }}>
                  {editingId === t.id ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <input style={selectStyle} placeholder="Nom" value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} />
                      <input style={selectStyle} placeholder="Catégorie" value={editForm.category} onChange={e => setEditForm({ ...editForm, category: e.target.value })} />
                      <input style={selectStyle} placeholder="Description" value={editForm.description} onChange={e => setEditForm({ ...editForm, description: e.target.value })} />
                      <textarea style={{ ...selectStyle, resize: 'vertical', fontSize: 12 }} rows={6} value={editForm.prompt_text} onChange={e => setEditForm({ ...editForm, prompt_text: e.target.value })} />
                      {formError && <div style={{ fontSize: 11, color: '#ff4d58' }}>{formError}</div>}
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" style={btnStyle} onClick={() => void handleSaveEdit()}>Enregistrer</button>
                        <button type="button" style={iconBtnStyle} onClick={() => setEditingId(null)}>Annuler</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                      <button type="button" onClick={() => void handleLoad(t)} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        <div style={{ fontSize: 12, color: '#e2e8f0' }}>{t.name}</div>
                        {t.description && <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{t.description}</div>}
                      </button>
                      <button type="button" style={iconBtnStyle} onClick={() => void handleDuplicate(t)} title="Dupliquer"><Copy size={12} /></button>
                      <button type="button" style={iconBtnStyle} onClick={() => startEdit(t)} title="Modifier"><Settings size={12} /></button>
                      <button type="button" style={iconBtnStyle} onClick={() => void handleDelete(t.id)} title="Supprimer"><Trash2 size={12} color="#ff4d58" /></button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div style={{ fontSize: 11, color: '#64748b' }}>Aucun modèle trouvé.</div>
        )}
      </div>
    </div>
  );
}

export default function PromptGeneratorModal({ onClose, strictLocalMode }: Props) {
  const [request, setRequest]     = useState('');
  const [localModels, setLocalModels] = useState<PromptGeneratorModelOption[]>([]);
  const [cloudModels, setCloudModels] = useState<PromptGeneratorModelOption[]>([]);
  const [draftChoice, setDraftChoice]   = useState(''); // "provider:id"
  const [reviewChoice, setReviewChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<GeneratedPrompt | null>(null);

  const [history, setHistory] = useState<GeneratedPrompt[]>([]);
  const [search, setSearch] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');

  const [destinations, setDestinations] = useState<PromptDestination[]>([]);
  const [showSendPanel, setShowSendPanel] = useState(false);
  const [sendEvents, setSendEvents] = useState<PromptSendEvent[]>([]);
  const [sendNotice, setSendNotice] = useState<{ text: string; link?: string } | null>(null);
  const [showDestinationSettings, setShowDestinationSettings] = useState(false);

  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [showTemplateLibrary, setShowTemplateLibrary] = useState(false);

  const allModels = [...localModels, ...cloudModels];

  const loadDestinations = useCallback(async () => {
    try {
      const list = await cortexClient.getPromptDestinations();
      setDestinations(list);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { void loadDestinations(); }, [loadDestinations]);

  const loadTemplates = useCallback(async () => {
    try {
      const list = await cortexClient.getPromptTemplates();
      setTemplates(list);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { void loadTemplates(); }, [loadTemplates]);

  const loadSendEvents = useCallback(async (promptId: string) => {
    try {
      const events = await cortexClient.getPromptSendEvents(promptId);
      setSendEvents(events);
    } catch { setSendEvents([]); }
  }, []);

  useEffect(() => {
    setSendNotice(null);
    setShowSendPanel(false);
    if (current?.id) void loadSendEvents(current.id);
    else setSendEvents([]);
  }, [current?.id, loadSendEvents]);

  function keptText(p: GeneratedPrompt): string {
    if (p.kept_version === 'draft') return p.draft_text;
    if (p.kept_version === 'reviewed') return p.reviewed_text;
    return p.reviewed_text || p.draft_text;
  }

  async function handleSend(p: GeneratedPrompt, destination: PromptDestination) {
    const text = keptText(p);
    void navigator.clipboard.writeText(text);

    let urlToOpen: string | null = destination.url || null;
    let prefillUsed = false;
    let overflowFallback = false;

    if (destination.urlTemplate) {
      if (text.length <= MAX_PREFILL_URL_LENGTH) {
        urlToOpen = destination.urlTemplate.replace('{prompt}', encodeURIComponent(text));
        prefillUsed = true;
      } else {
        overflowFallback = true;
      }
    }

    let notice: { text: string; link?: string };
    if (!urlToOpen) {
      notice = { text: 'Prompt copié — colle-le dans ton terminal' };
    } else {
      const win = window.open(urlToOpen, '_blank');
      const blocked = !win || win.closed || typeof win.closed === 'undefined';
      const baseText = overflowFallback
        ? 'Prompt trop long pour le préremplissage — copié dans le presse-papier'
        : `Prompt copié — colle-le dans ${destination.name}`;
      notice = blocked ? { text: `${baseText} (fenêtre bloquée)`, link: urlToOpen } : { text: baseText };
    }
    setSendNotice(notice);

    try {
      const result = await cortexClient.sendGeneratedPrompt(p.id, { destinationId: destination.id, prefillUsed });
      setSendEvents(result.events);
    } catch { /* ignore — copy/open already happened */ }
  }

  const loadModels = useCallback(async () => {
    try {
      const res = await cortexClient.getPromptGeneratorModels();
      setLocalModels(res.local);
      setCloudModels(res.cloud);
      const settings = await cortexClient.getPromptGeneratorSettings();
      if (settings.default_draft_model && settings.default_draft_provider) {
        setDraftChoice(`${settings.default_draft_provider}:${settings.default_draft_model}`);
      } else if (res.local[0]) {
        setDraftChoice(`local:${res.local[0].id}`);
      }
      if (settings.default_review_model && settings.default_review_provider) {
        setReviewChoice(`${settings.default_review_provider}:${settings.default_review_model}`);
      } else if (res.local[1]) {
        setReviewChoice(`local:${res.local[1].id}`);
      } else if (res.local[0]) {
        setReviewChoice(`local:${res.local[0].id}`);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await cortexClient.listGeneratedPrompts({
        q: search || undefined,
        outcome: outcomeFilter || undefined,
        model: modelFilter || undefined,
      });
      setHistory(res.prompts);
    } catch { /* silent */ }
  }, [search, outcomeFilter, modelFilter]);

  useEffect(() => { void loadModels(); }, [loadModels]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function parseChoice(choice: string): { provider: string; id: string } | null {
    const idx = choice.indexOf(':');
    if (idx === -1) return null;
    return { provider: choice.slice(0, idx), id: choice.slice(idx + 1) };
  }

  const draftParsed  = parseChoice(draftChoice);
  const reviewParsed = parseChoice(reviewChoice);
  const bothCloud = !!draftParsed && draftParsed.provider !== 'local' && !!reviewParsed && reviewParsed.provider !== 'local';

  async function handleGenerate() {
    if (!request.trim() || !draftParsed || !reviewParsed) return;
    setBusy(true);
    setError(null);
    try {
      const prompt = await cortexClient.generatePrompt({
        request: request.trim(),
        draft_model: draftParsed.id,
        draft_provider: draftParsed.provider,
        review_model: reviewParsed.id,
        review_provider: reviewParsed.provider,
      });
      setCurrent(prompt);
      await cortexClient.setPromptGeneratorSettings({
        default_draft_model: draftParsed.id,
        default_draft_provider: draftParsed.provider,
        default_review_model: reviewParsed.id,
        default_review_provider: reviewParsed.provider,
      });
      void loadHistory();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleApply(promptId: string, version: 'draft' | 'reviewed', text: string) {
    void navigator.clipboard.writeText(text);
    try {
      const updated = await cortexClient.updateGeneratedPrompt(promptId, { kept_version: version });
      if (current?.id === promptId) setCurrent(updated);
      void loadHistory();
    } catch { /* ignore */ }
  }

  async function handleOutcome(promptId: string, outcome: PromptOutcome) {
    try {
      const updated = await cortexClient.updateGeneratedPrompt(promptId, { outcome });
      if (current?.id === promptId) setCurrent(updated);
      void loadHistory();
    } catch { /* ignore */ }
  }

  async function handleTemplate(p: GeneratedPrompt) {
    try {
      await cortexClient.updateGeneratedPrompt(p.id, { is_template: !p.is_template });
      void loadHistory();
    } catch { /* ignore */ }
  }

  async function handleDelete(id: string) {
    try {
      await cortexClient.deleteGeneratedPrompt(id);
      if (current?.id === id) setCurrent(null);
      void loadHistory();
    } catch { /* ignore */ }
  }

  async function handleRegenerate(p: GeneratedPrompt) {
    setBusy(true);
    setError(null);
    try {
      const prompt = await cortexClient.regeneratePrompt(p.id);
      setCurrent(prompt);
      void loadHistory();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function loadFromHistory(p: GeneratedPrompt) {
    setCurrent(p);
    setRequest(p.request);
  }

  function openSendFromHistory(p: GeneratedPrompt) {
    setCurrent(p);
    setRequest(p.request);
    setShowSendPanel(true);
  }

  return (
    <div style={modalStyle} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={panelStyle}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Wand2 size={14} color="#5ee7ff" />
          <span style={{ fontFamily: 'monospace', fontSize: 13, letterSpacing: '0.05em', color: '#e2e8f0', flex: 1 }}>GÉNÉRATEUR DE PROMPTS</span>
          <button
            type="button"
            title="Modèles"
            style={{ ...iconBtnStyle, color: showTemplateLibrary ? '#5ee7ff' : '#94a3b8' }}
            onClick={() => setShowTemplateLibrary(v => !v)}
          >
            <Library size={15} />
          </button>
          <button
            type="button"
            title="Destinations de prompts"
            style={{ ...iconBtnStyle, color: showDestinationSettings ? '#5ee7ff' : '#94a3b8' }}
            onClick={() => setShowDestinationSettings(v => !v)}
          >
            <Settings size={15} />
          </button>
          <button type="button" onClick={onClose} style={iconBtnStyle}><X size={16} /></button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {showTemplateLibrary && (
            <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: 14 }}>
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#e2e8f0', letterSpacing: '0.04em', display: 'block', marginBottom: 8 }}>MODÈLES</span>
              <TemplateLibrary
                templates={templates}
                onReload={setTemplates}
                onLoad={text => setRequest(text)}
              />
            </div>
          )}

          {showDestinationSettings && (
            <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: 14 }}>
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#e2e8f0', letterSpacing: '0.04em', display: 'block', marginBottom: 8 }}>DESTINATIONS DE PROMPTS</span>
              <DestinationsManager
                destinations={destinations}
                categories={[...new Set(destinations.map(d => d.category))]}
                onReload={setDestinations}
              />
            </div>
          )}

          {strictLocalMode && (
            <div style={{ fontSize: 11, color: '#ffb547', background: 'rgba(255,181,71,0.08)', border: '1px solid rgba(255,181,71,0.2)', borderRadius: 6, padding: '6px 10px' }}>
              Mode strictement local actif — seuls les modèles locaux sont proposés.
            </div>
          )}

          {/* ── Request input ── */}
          <div>
            <span style={labelStyle}>DEMANDE</span>
            <textarea
              value={request}
              onChange={e => setRequest(e.target.value)}
              placeholder='prompt [ce que je veux obtenir]'
              rows={3}
              style={{ ...selectStyle, resize: 'vertical', fontSize: 13 }}
            />
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <ModelPicker label="MODÈLE RÉDACTION" options={allModels} value={draftChoice} onChange={setDraftChoice} />
            <ModelPicker label="MODÈLE RELECTURE" options={allModels} value={reviewChoice} onChange={setReviewChoice} />
          </div>

          {bothCloud && (
            <div style={{ fontSize: 11, color: '#ffb547', background: 'rgba(255,181,71,0.08)', border: '1px solid rgba(255,181,71,0.2)', borderRadius: 6, padding: '6px 10px' }}>
              2 appels cloud (rédaction + relecture) — vérifiez vos quotas avant de lancer.
            </div>
          )}

          {error && (
            <div style={{ fontSize: 12, color: '#ff4d58', background: 'rgba(255,77,88,0.08)', border: '1px solid rgba(255,77,88,0.15)', borderRadius: 6, padding: '8px 10px' }}>
              {error}
            </div>
          )}

          <button
            type="button"
            style={{ ...btnStyle, justifyContent: 'center', opacity: busy || !request.trim() ? 0.5 : 1 }}
            disabled={busy || !request.trim() || !draftChoice || !reviewChoice}
            onClick={() => void handleGenerate()}
          >
            {busy ? 'Génération en cours…' : 'Générer'}
          </button>

          {/* ── Result ── */}
          {current && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>
                  {current.draft_model} → {current.review_model}
                  {current.unchanged && <span style={{ color: '#3dffaa', marginLeft: 8 }}>· relecture : aucun changement</span>}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  {(['untested', 'worked', 'half', 'broken'] as PromptOutcome[]).map(o => (
                    <button
                      key={o}
                      type="button"
                      onClick={() => void handleOutcome(current.id, o)}
                      style={{
                        fontSize: 10, padding: '3px 8px', borderRadius: 10, cursor: 'pointer',
                        border: `1px solid ${current.outcome === o ? OUTCOME_COLORS[o] : 'rgba(255,255,255,0.1)'}`,
                        background: current.outcome === o ? `${OUTCOME_COLORS[o]}22` : 'transparent',
                        color: current.outcome === o ? OUTCOME_COLORS[o] : '#94a3b8',
                      }}
                    >
                      {OUTCOME_LABELS[o]}
                    </button>
                  ))}
                  <button type="button" style={btnStyle} onClick={() => setShowSendPanel(v => !v)}>
                    <Send size={12} /> Envoyer vers…
                  </button>
                </div>
              </div>

              {showSendPanel && (
                <SendPanel
                  destinations={destinations}
                  events={sendEvents}
                  notice={sendNotice}
                  onSend={d => void handleSend(current, d)}
                  onClose={() => setShowSendPanel(false)}
                />
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={labelStyle}>BROUILLON {current.kept_version === 'draft' && <Check size={11} color="#3dffaa" style={{ verticalAlign: 'middle', marginLeft: 4 }} />}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <CopyButton text={current.draft_text} />
                    <button type="button" style={btnStyle} onClick={() => void handleApply(current.id, 'draft', current.draft_text)}>Appliquer</button>
                  </div>
                </div>
                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12.5, color: '#e2e8f0', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: 10, margin: 0, maxHeight: 220, overflowY: 'auto' }}>
                  {current.draft_text}
                </pre>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={labelStyle}>RELECTURE {current.kept_version === 'reviewed' && <Check size={11} color="#3dffaa" style={{ verticalAlign: 'middle', marginLeft: 4 }} />}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <CopyButton text={current.reviewed_text} />
                    <button type="button" style={btnStyle} onClick={() => void handleApply(current.id, 'reviewed', current.reviewed_text)}>Appliquer</button>
                  </div>
                </div>
                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12.5, color: '#e2e8f0', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: 10, margin: 0, maxHeight: 220, overflowY: 'auto' }}>
                  {current.reviewed_text}
                </pre>
              </div>

              <div>
                <span style={labelStyle}>CHANGEMENTS EXPLIQUÉS</span>
                <div style={{ fontSize: 12, color: '#94a3b8', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 6, padding: 10, whiteSpace: 'pre-wrap' }}>
                  {current.changes_explained || '—'}
                </div>
              </div>
            </div>
          )}

          {/* ── History ── */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Search size={12} color="#94a3b8" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Rechercher dans l'historique…"
                style={{ ...selectStyle, flex: 1 }}
              />
              <select style={{ ...selectStyle, width: 140 }} value={outcomeFilter} onChange={e => setOutcomeFilter(e.target.value)}>
                <option value="">Tous résultats</option>
                {(['untested', 'worked', 'half', 'broken'] as PromptOutcome[]).map(o => (
                  <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>
                ))}
              </select>
              <select style={{ ...selectStyle, width: 160 }} value={modelFilter} onChange={e => setModelFilter(e.target.value)}>
                <option value="">Tous modèles</option>
                {allModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
              {history.length === 0 && <div style={{ fontSize: 12, color: '#64748b', textAlign: 'center', padding: 12 }}>Aucun prompt généré.</div>}
              {history.map(p => (
                <div
                  key={p.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                    background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => loadFromHistory(p)}>
                    <div style={{ fontSize: 12, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.is_template && <Star size={10} color="#ffb547" style={{ verticalAlign: 'middle', marginRight: 4 }} fill="#ffb547" />}
                      {p.request}
                    </div>
                    <div style={{ fontSize: 10, color: '#64748b' }}>
                      {formatDate(p.created_at)} · {p.draft_model} → {p.review_model} · <span style={{ color: OUTCOME_COLORS[p.outcome] }}>{OUTCOME_LABELS[p.outcome]}</span>
                    </div>
                  </div>
                  <button type="button" title="Favori / modèle" style={iconBtnStyle} onClick={() => void handleTemplate(p)}>
                    <Star size={13} color={p.is_template ? '#ffb547' : '#64748b'} fill={p.is_template ? '#ffb547' : 'none'} />
                  </button>
                  <button type="button" title="Envoyer vers…" style={iconBtnStyle} onClick={() => openSendFromHistory(p)}>
                    <Send size={13} />
                  </button>
                  <button type="button" title="Régénérer" style={iconBtnStyle} onClick={() => void handleRegenerate(p)}>
                    <RefreshCw size={13} />
                  </button>
                  <button type="button" title="Supprimer" style={iconBtnStyle} onClick={() => void handleDelete(p.id)}>
                    <Trash2 size={13} color="#ff4d58" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
