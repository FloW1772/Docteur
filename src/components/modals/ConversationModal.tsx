import { useEffect, useRef, useState } from 'react';
import { X, Send, Plus, Save, Loader2, AlertTriangle } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type { ChatMessage, ChatSource } from '../../lib/cortex/client';

interface Props {
  onClose: () => void;
  onSaveConversation: (messages: ChatMessage[]) => void;
}

export default function ConversationModal({ onClose, onSaveConversation }: Props) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages]   = useState<ChatMessage[]>([]);
  const [input, setInput]         = useState('');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [notInstalled, setNotInstalled] = useState(false);
  const [gpuBusy, setGpuBusy]     = useState(false);
  const [chatModel, setChatModel] = useState('mistral-nemo:12b-instruct-2407-q4_K_M');
  const [lastSources, setLastSources] = useState<ChatSource[]>([]);
  const [pendingFact, setPendingFact] = useState<string | null>(null);
  const [factSaved, setFactSaved]     = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cortexClient.chatStatus().then(s => {
      setChatModel(s.model || 'mistral-nemo:12b-instruct-2407-q4_K_M');
      setNotInstalled(!s.installed);
      setGpuBusy(s.gpu_busy);
    }).catch(() => {});
    void startNewConversation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function startNewConversation() {
    setError(null);
    setPendingFact(null);
    setFactSaved(false);
    setLastSources([]);
    try {
      const { id } = await cortexClient.createConversation();
      setConversationId(id);
      setMessages([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Impossible de créer la conversation');
    }
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || loading || !conversationId) return;
    setLoading(true);
    setError(null);
    setPendingFact(null);
    setFactSaved(false);
    // Optimistic: show the user's message immediately.
    const optimisticUser: ChatMessage = { id: `local-${Date.now()}`, conversation_id: conversationId, role: 'user', content: text, created_at: new Date().toISOString() };
    setMessages(prev => [...prev, optimisticUser]);
    setInput('');
    try {
      const result = await cortexClient.sendChatMessage(conversationId, text);
      if (!result.ok) {
        if (result.model_installed === false) setNotInstalled(true);
        if (result.gpu_busy) setGpuBusy(true);
        setError(result.error ?? 'Réponse impossible');
        return;
      }
      const reply: ChatMessage = {
        id: `local-reply-${Date.now()}`, conversation_id: conversationId,
        role: 'assistant', content: result.answer ?? '', created_at: new Date().toISOString(),
      };
      setMessages(prev => [...prev, reply]);
      setLastSources(result.sources ?? []);
      if (result.suggested_fact) setPendingFact(result.suggested_fact);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Réponse impossible — utilise le mode Question en attendant.');
    } finally {
      setLoading(false);
    }
  }

  async function confirmFact() {
    if (!pendingFact) return;
    try {
      await cortexClient.addPreferenceFact(pendingFact);
      setFactSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Impossible de retenir ce fait');
    }
  }

  const unavailable = notInstalled || gpuBusy;

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(5,2,12,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 620, maxWidth: '100%', height: '78vh', maxHeight: 720,
          background: '#120c22', border: '1px solid rgba(94,231,255,0.2)', borderRadius: 14,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between" style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
          <div className="flex items-center gap-2">
            <span className="font-grotesk font-semibold" style={{ color: '#f0eaff' }}>Discussion</span>
            <span className="font-mono text-xs" style={{ color: '#5a4a7a' }}>100% local · {chatModel}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              title="Nouvelle conversation"
              onClick={() => void startNewConversation()}
              style={{ color: '#7a6c9a', background: 'none', border: 'none', cursor: 'pointer', display: 'flex' }}
            >
              <Plus size={16} />
            </button>
            <button
              type="button"
              title="Sauvegarder cette conversation"
              disabled={messages.length === 0}
              onClick={() => onSaveConversation(messages)}
              style={{ color: messages.length === 0 ? '#3d3060' : '#3dffaa', background: 'none', border: 'none', cursor: messages.length === 0 ? 'default' : 'pointer', display: 'flex' }}
            >
              <Save size={16} />
            </button>
            <button type="button" onClick={onClose} style={{ color: '#7a6c9a', background: 'none', border: 'none', cursor: 'pointer', display: 'flex' }}>
              <X size={18} />
            </button>
          </div>
        </div>

        {notInstalled && (
          <div style={{ margin: '10px 16px 0', background: 'rgba(94,231,255,0.06)', border: '1px solid rgba(94,231,255,0.15)', borderRadius: 8, padding: 10 }}>
            <p className="font-mono text-xs" style={{ color: '#5ee7ff' }}>
              Modèle de conversation "{chatModel}" non installé (~7,5 Go, 100% local) — installe-le depuis Réglages → Modèles Ollama.
            </p>
          </div>
        )}
        {!notInstalled && gpuBusy && (
          <div style={{ margin: '10px 16px 0', background: 'rgba(255,181,71,0.06)', border: '1px solid rgba(255,181,71,0.15)', borderRadius: 8, padding: 10 }}>
            <p className="font-mono text-xs" style={{ color: '#ffb547' }}>
              Un autre traitement GPU est en cours — réessaie dans un instant.
            </p>
          </div>
        )}

        {/* Messages */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {messages.length === 0 && !loading && (
            <p className="font-mono text-xs" style={{ color: '#5a4a7a', textAlign: 'center', marginTop: 40 }}>
              Dis bonjour — la conversation garde le fil des échanges.
            </p>
          )}
          {messages.map(m => (
            <div key={m.id} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
              <div
                style={{
                  padding: '8px 12px', borderRadius: 10,
                  background: m.role === 'user' ? 'rgba(94,231,255,0.12)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${m.role === 'user' ? 'rgba(94,231,255,0.25)' : 'rgba(255,255,255,0.08)'}`,
                }}
              >
                <p className="font-mono text-xs" style={{ color: '#f0eaff', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{m.content}</p>
              </div>
            </div>
          ))}
          {loading && (
            <div style={{ alignSelf: 'flex-start' }} className="flex items-center gap-2">
              <Loader2 size={13} className="animate-spin" style={{ color: '#7a6c9a' }} />
              <span className="font-mono text-xs" style={{ color: '#7a6c9a' }}>Docteur réfléchit…</span>
            </div>
          )}
        </div>

        {lastSources.length > 0 && (
          <div style={{ padding: '0 16px 8px', flexShrink: 0 }}>
            <p className="font-mono text-xs" style={{ color: '#5a4a7a' }}>
              Sources : {lastSources.map(s => s.title).join(' · ')}
            </p>
          </div>
        )}

        {pendingFact && !factSaved && (
          <div style={{ margin: '0 16px 10px', background: 'rgba(61,255,170,0.06)', border: '1px solid rgba(61,255,170,0.2)', borderRadius: 8, padding: 10, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <p className="font-mono text-xs flex-1" style={{ color: '#3dffaa' }}>Je retiens : « {pendingFact} » ?</p>
            <button type="button" onClick={() => void confirmFact()} className="font-mono text-xs px-2 py-1 rounded" style={{ background: 'rgba(61,255,170,0.16)', border: '1px solid rgba(61,255,170,0.35)', color: '#3dffaa', cursor: 'pointer' }}>Oui</button>
            <button type="button" onClick={() => setPendingFact(null)} className="font-mono text-xs px-2 py-1 rounded" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: '#7a6c9a', cursor: 'pointer' }}>Non</button>
          </div>
        )}
        {factSaved && (
          <div style={{ margin: '0 16px 10px', flexShrink: 0 }}>
            <p className="font-mono text-xs" style={{ color: '#3dffaa' }}>✓ Retenu — visible dans Réglages → Mémoire.</p>
          </div>
        )}

        {error && (
          <div style={{ margin: '0 16px 10px', flexShrink: 0 }} className="flex items-center gap-2">
            <AlertTriangle size={12} style={{ color: '#ff6b75', flexShrink: 0 }} />
            <p className="font-mono text-xs" style={{ color: '#ff6b75' }}>{error}</p>
          </div>
        )}

        {/* Input */}
        <div style={{ padding: '10px 16px 16px', flexShrink: 0, display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend(); } }}
            placeholder={unavailable ? 'Conversation indisponible pour le moment…' : 'Écris quelque chose…'}
            disabled={unavailable || loading}
            className="font-mono text-xs"
            style={{
              flex: 1, borderRadius: 8, padding: '9px 12px',
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', color: '#f0eaff',
              opacity: unavailable ? 0.5 : 1,
            }}
          />
          <button
            type="button"
            disabled={unavailable || loading || !input.trim()}
            onClick={() => void handleSend()}
            style={{
              width: 36, height: 36, borderRadius: 8, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: unavailable || loading || !input.trim() ? 'rgba(94,231,255,0.05)' : 'rgba(94,231,255,0.14)',
              border: '1px solid rgba(94,231,255,0.3)', color: '#5ee7ff',
              cursor: unavailable || loading || !input.trim() ? 'default' : 'pointer',
            }}
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
