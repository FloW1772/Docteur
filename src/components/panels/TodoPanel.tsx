import { useState, useEffect, useCallback } from 'react';
import { X, CheckCircle2, Circle, Trash2, ExternalLink, AlertCircle, Clock, Play } from 'lucide-react';
import { cortexClient, type TodoItem } from '../../lib/cortex/client';
import { generateId } from '../../lib/generateId';

interface Props {
  onClose: () => void;
  onCaptureNow: (item: TodoItem) => void;
  onSelectNeuron?: (id: string) => void;
}

function kindLabel(kind: string | null | undefined): string {
  if (!kind) return '';
  const map: Record<string, string> = {
    video: '🎬', playlist: '📋', channel: '📺', article: '📄',
    note: '📝', tool: '🔧', recherche: '🔍',
  };
  return map[kind] ?? '';
}

export default function TodoPanel({ onClose, onCaptureNow, onSelectNeuron }: Props) {
  const [items, setItems] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [newText, setNewText] = useState('');
  const [newNote, setNewNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try { setItems(await cortexClient.getTodos()); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleAdd() {
    const text = newText.trim();
    if (!text) return;
    const note = newNote.trim() || undefined;

    let url: string | undefined;
    let title: string | undefined;
    let type: 'capture' | 'task' = 'task';
    let detected_kind: string | undefined;

    // Detect URL
    try {
      const parsed = new URL(text);
      if (['http:', 'https:'].includes(parsed.protocol)) {
        url = text;
        type = 'capture';
        if (text.includes('youtube.com') || text.includes('youtu.be')) {
          if (text.includes('/playlist') || text.includes('list=')) detected_kind = 'playlist';
          else if (text.includes('/@') || text.includes('/channel/') || text.includes('/c/')) detected_kind = 'channel';
          else detected_kind = 'video';
        } else {
          detected_kind = 'article';
        }
      }
    } catch { /* not a URL — it's a free task */ }

    if (!url) {
      title = text;
      type = 'task';
    }

    try {
      await cortexClient.addTodo({ id: generateId(), type, url, title, note, detected_kind, priority: 0 });
      setNewText('');
      setNewNote('');
      setShowNote(false);
      await load();
    } catch { /* ignore */ }
  }

  async function handleDelete(id: string) {
    await cortexClient.deleteTodo(id);
    setSelected(prev => { const n = new Set(prev); n.delete(id); return n; });
    await load();
  }

  async function handleMarkDone(item: TodoItem) {
    await cortexClient.updateTodo(item.id, {
      status: 'done',
      done_at: new Date().toISOString(),
    });
    await load();
  }

  async function handleBatchCapture() {
    const pending = items.filter(i => selected.has(i.id) && i.status === 'pending' && i.type === 'capture');
    if (pending.length === 0) return;
    if (pending.length > 20 && !window.confirm(`Lancer la capture de ${pending.length} éléments ?`)) return;
    setSelected(new Set());
    for (const item of pending) {
      onCaptureNow(item);
    }
  }

  const pending  = items.filter(i => i.status === 'pending');
  const done     = items.filter(i => i.status === 'done');
  const failed   = items.filter(i => i.status === 'failed');
  const selectedPending = [...selected].filter(id => items.find(i => i.id === id && i.status === 'pending' && i.type === 'capture'));

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1200,
        background: 'rgba(8,4,20,0.82)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 420, maxHeight: '90vh',
          background: 'rgba(18,10,40,0.98)',
          border: '1px solid rgba(94,231,255,0.15)',
          borderRadius: '12px 0 0 0',
          display: 'flex', flexDirection: 'column',
          fontFamily: 'IBM Plex Mono, monospace',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px', borderBottom: '1px solid rgba(94,231,255,0.1)',
        }}>
          <span style={{ color: '#5ee7ff', fontWeight: 600, fontSize: 13, letterSpacing: '0.1em' }}>
            À FAIRE
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {selectedPending.length > 0 && (
              <button
                onClick={handleBatchCapture}
                title={`Capturer ${selectedPending.length} élément(s)`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  background: 'rgba(61,255,170,0.1)', border: '1px solid rgba(61,255,170,0.3)',
                  borderRadius: 5, padding: '3px 8px', cursor: 'pointer',
                  color: '#3dffaa', fontSize: 10,
                }}
              >
                <Play size={9} /> Capturer ({selectedPending.length})
              </button>
            )}
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#5a4a7a', padding: 4 }}>
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Add form */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(94,231,255,0.07)' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={newText}
              onChange={e => setNewText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleAdd(); } }}
              placeholder="URL ou tâche à faire…"
              style={{
                flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(94,231,255,0.15)',
                borderRadius: 6, padding: '6px 10px', color: '#e8d9ff', fontSize: 12,
                fontFamily: 'inherit', outline: 'none',
              }}
              autoFocus
            />
            <button
              onClick={() => void handleAdd()}
              disabled={!newText.trim()}
              style={{
                background: newText.trim() ? 'rgba(61,255,170,0.15)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${newText.trim() ? 'rgba(61,255,170,0.3)' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: 6, padding: '6px 12px', cursor: newText.trim() ? 'pointer' : 'default',
                color: newText.trim() ? '#3dffaa' : '#5a4a7a', fontSize: 11,
                fontFamily: 'inherit',
              }}
            >
              Ajouter
            </button>
          </div>
          {showNote ? (
            <textarea
              value={newNote}
              onChange={e => setNewNote(e.target.value)}
              placeholder="Note facultative…"
              rows={2}
              style={{
                marginTop: 6, width: '100%', boxSizing: 'border-box',
                background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(94,231,255,0.1)',
                borderRadius: 6, padding: '5px 8px', color: '#a090c8', fontSize: 11,
                fontFamily: 'inherit', resize: 'none', outline: 'none',
              }}
            />
          ) : (
            <button
              onClick={() => setShowNote(true)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a3a6a', fontSize: 10, marginTop: 4, padding: 0 }}
            >
              + ajouter une note
            </button>
          )}
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {loading && (
            <div style={{ textAlign: 'center', color: '#5a4a7a', fontSize: 11, padding: 20 }}>Chargement…</div>
          )}

          {!loading && pending.length === 0 && done.length === 0 && failed.length === 0 && (
            <div style={{ textAlign: 'center', color: '#4a3a6a', fontSize: 11, padding: 30 }}>
              Aucun élément à faire.<br />
              <span style={{ fontSize: 10, color: '#3a2a5a' }}>
                Ajoutez une URL ou une tâche ci-dessus,<br />ou préfixez une capture par "plus tard …"
              </span>
            </div>
          )}

          {[
            { label: 'EN ATTENTE', color: '#5ee7ff', list: pending },
            { label: 'ÉCHOUÉ', color: '#ff4d58', list: failed },
            { label: 'TERMINÉ', color: '#3dffaa', list: done },
          ].map(({ label, color, list }) =>
            list.length > 0 && (
              <div key={label}>
                <div style={{ padding: '6px 16px 3px', fontSize: 9, color: color, letterSpacing: '0.15em', opacity: 0.7 }}>
                  {label} ({list.length})
                </div>
                {list.map(item => (
                  <TodoRow
                    key={item.id}
                    item={item}
                    selected={selected.has(item.id)}
                    onToggleSelect={() => toggleSelect(item.id)}
                    onDelete={() => void handleDelete(item.id)}
                    onMarkDone={() => void handleMarkDone(item)}
                    onCaptureNow={() => onCaptureNow(item)}
                    onSelectNeuron={onSelectNeuron}
                  />
                ))}
              </div>
            )
          )}
        </div>

        {/* Footer */}
        {(done.length > 0 || failed.length > 0) && (
          <div style={{ padding: '8px 16px', borderTop: '1px solid rgba(94,231,255,0.07)', display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={async () => {
                for (const i of [...done, ...failed]) await cortexClient.deleteTodo(i.id);
                await load();
              }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a3a6a', fontSize: 10, fontFamily: 'inherit' }}
            >
              Effacer terminés/échoués
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function TodoRow({
  item, selected, onToggleSelect, onDelete, onMarkDone, onCaptureNow, onSelectNeuron,
}: {
  item: TodoItem;
  selected: boolean;
  onToggleSelect: () => void;
  onDelete: () => void;
  onMarkDone: () => void;
  onCaptureNow: () => void;
  onSelectNeuron?: (id: string) => void;
}) {
  const isCapture = item.type === 'capture';
  const isPending = item.status === 'pending';
  const isDone    = item.status === 'done';
  const isFailed  = item.status === 'failed';

  const label = item.title ?? (item.url ? (() => { try { return new URL(item.url!).hostname; } catch { return item.url; } })() : '—');

  return (
    <div
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 8,
        padding: '7px 16px',
        background: selected ? 'rgba(94,231,255,0.05)' : 'transparent',
        borderBottom: '1px solid rgba(255,255,255,0.03)',
      }}
    >
      {/* Checkbox (only for pending capture items) */}
      {isPending && isCapture ? (
        <button onClick={onToggleSelect} style={{ background: 'none', border: 'none', cursor: 'pointer', color: selected ? '#5ee7ff' : '#3a2a5a', padding: 0, flexShrink: 0, marginTop: 2 }}>
          {selected ? <CheckCircle2 size={13} /> : <Circle size={13} />}
        </button>
      ) : (
        <span style={{ width: 13, flexShrink: 0, marginTop: 2, opacity: 0.4 }}>
          {isDone ? <CheckCircle2 size={13} color="#3dffaa" /> : isFailed ? <AlertCircle size={13} color="#ff4d58" /> : <Clock size={13} color="#7a6c9a" />}
        </span>
      )}

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          {kindLabel(item.detected_kind) && (
            <span style={{ fontSize: 11 }}>{kindLabel(item.detected_kind)}</span>
          )}
          <span style={{
            fontSize: 11, color: isDone ? '#5a4a7a' : isFailed ? '#ff8a8a' : '#c8b8e8',
            textDecoration: isDone ? 'line-through' : 'none',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220,
          }}>
            {label}
          </span>
        </div>
        {item.note && (
          <div style={{ fontSize: 10, color: '#5a4a7a', marginTop: 2 }}>{item.note}</div>
        )}
        {item.error && (
          <div style={{ fontSize: 10, color: '#ff6b6b', marginTop: 2 }}>⚠ {item.error}</div>
        )}
        {item.url && (
          <div style={{ fontSize: 9, color: '#4a3a6a', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.url.length > 50 ? item.url.slice(0, 50) + '…' : item.url}
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
        {isPending && isCapture && (
          <button
            onClick={onCaptureNow}
            title="Capturer maintenant"
            style={{ background: 'rgba(61,255,170,0.08)', border: '1px solid rgba(61,255,170,0.2)', borderRadius: 4, padding: '2px 6px', cursor: 'pointer', color: '#3dffaa', fontSize: 9, fontFamily: 'inherit' }}
          >
            Capturer
          </button>
        )}
        {isPending && !isCapture && (
          <button
            onClick={onMarkDone}
            title="Marquer comme fait"
            style={{ background: 'rgba(61,255,170,0.08)', border: '1px solid rgba(61,255,170,0.2)', borderRadius: 4, padding: '2px 6px', cursor: 'pointer', color: '#3dffaa', fontSize: 9, fontFamily: 'inherit' }}
          >
            Fait
          </button>
        )}
        {isDone && item.result_page_id && onSelectNeuron && (
          <button
            onClick={() => onSelectNeuron(item.result_page_id!)}
            title="Voir le neurone"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#5ee7ff', padding: 2 }}
          >
            <ExternalLink size={11} />
          </button>
        )}
        <button
          onClick={onDelete}
          title="Supprimer"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#3a2a5a', padding: 2 }}
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}
