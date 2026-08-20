import type { Page } from '../../lib/types';

const TOOLS = [
  { value: '',            label: '— outil —' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'copilot',     label: 'Copilot' },
  { value: 'cline',       label: 'Cline' },
  { value: 'aider',       label: 'Aider' },
];

const RESULTS: { value: string; label: string; color: string }[] = [
  { value: 'ok',        label: 'OK',       color: '#34d399' },
  { value: 'partial',   label: 'Partiel',  color: '#f59e0b' },
  { value: 'broken',    label: 'Cassé',    color: '#f87171' },
  { value: 'untested',  label: 'Non testé',color: '#6b7280' },
];

interface Props {
  page: Page;
  onUpdate: (id: string, updates: Partial<Omit<Page, 'id' | 'createdAt'>>) => void;
}

function meta(page: Page) {
  return (page.metadata ?? {}) as Record<string, unknown>;
}

function setMeta(page: Page, onUpdate: Props['onUpdate'], key: string, value: unknown) {
  onUpdate(page.id, { metadata: { ...meta(page), [key]: value } });
}

export default function PromptMeta({ page, onUpdate }: Props) {
  const m = meta(page);
  const projet   = (m.projet   as string  | undefined) ?? '';
  const outil    = (m.outil    as string  | undefined) ?? '';
  const resultat = (m.resultat as string  | undefined) ?? '';
  const template = (m.template as boolean | undefined) ?? false;
  const note     = (m.note     as string  | undefined) ?? '';

  const inputStyle: React.CSSProperties = {
    background:    'transparent',
    border:        '1px solid rgba(52,211,153,0.12)',
    borderRadius:   6,
    color:          '#d0c0f0',
    fontSize:       11,
    fontFamily:    'IBM Plex Mono, monospace',
    padding:       '4px 8px',
    outline:        'none',
    width:          '100%',
  };

  return (
    <div
      style={{
        margin:        '0 32px 16px',
        padding:       '12px 14px',
        borderRadius:   10,
        background:    'rgba(52,211,153,0.04)',
        border:        '1px solid rgba(52,211,153,0.1)',
        display:        'flex',
        flexDirection:  'column',
        gap:            10,
      }}
    >
      {/* Row 1: Projet + Outil */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          placeholder="Projet (ex: Docteur, cli-tool…)"
          value={projet}
          onChange={e => setMeta(page, onUpdate, 'projet', e.target.value)}
          style={{ ...inputStyle, flex: 2 }}
        />
        <select
          value={outil}
          onChange={e => setMeta(page, onUpdate, 'outil', e.target.value)}
          style={{ ...inputStyle, flex: 1, cursor: 'pointer', appearance: 'none' }}
        >
          {TOOLS.map(t => (
            <option key={t.value} value={t.value} style={{ background: '#0f0b1e' }}>{t.label}</option>
          ))}
        </select>
      </div>

      {/* Row 2: Résultat badges + Template toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 9, color: '#3a5040', letterSpacing: '0.1em', marginRight: 2 }}>RÉSULTAT</span>
        {RESULTS.map(r => {
          const active = resultat === r.value;
          return (
            <button
              key={r.value}
              type="button"
              onClick={() => setMeta(page, onUpdate, 'resultat', active ? '' : r.value)}
              style={{
                fontFamily:    'IBM Plex Mono, monospace',
                fontSize:       9,
                letterSpacing:  '0.1em',
                padding:       '2px 8px',
                borderRadius:   999,
                border:         `1px solid ${active ? r.color : r.color + '33'}`,
                background:     active ? `${r.color}22` : 'transparent',
                color:          active ? r.color : r.color + '88',
                cursor:         'pointer',
                transition:     'all 0.12s',
              }}
            >
              {r.label}
            </button>
          );
        })}

        <span style={{ flex: 1 }} />

        {/* Template toggle */}
        <button
          type="button"
          onClick={() => setMeta(page, onUpdate, 'template', !template)}
          style={{
            fontFamily:    'IBM Plex Mono, monospace',
            fontSize:       9,
            letterSpacing:  '0.1em',
            padding:       '2px 8px',
            borderRadius:   999,
            border:         `1px solid ${template ? 'rgba(52,211,153,0.4)' : 'rgba(52,211,153,0.12)'}`,
            background:     template ? 'rgba(52,211,153,0.12)' : 'transparent',
            color:          template ? '#34d399' : '#3a5040',
            cursor:         'pointer',
            transition:     'all 0.12s',
          }}
          title={template ? 'Marqué comme modèle — cliquer pour retirer' : 'Marquer comme modèle réutilisable'}
        >
          {template ? '★ MODÈLE' : '☆ modèle'}
        </button>
      </div>

      {/* Row 3: Note libre */}
      <textarea
        placeholder="Note libre (contexte, résultat observé, leçons…)"
        value={note}
        rows={2}
        onChange={e => setMeta(page, onUpdate, 'note', e.target.value)}
        style={{
          ...inputStyle,
          resize:     'vertical',
          lineHeight:  1.5,
          minHeight:   42,
        }}
      />
    </div>
  );
}
