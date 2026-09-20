import { useEffect, useMemo, useState } from 'react';
import { X, HelpCircle, Search } from 'lucide-react';
import { CAPABILITIES, LIMITATIONS, SHORTCUTS, GESTURES, type FeatureKey, type FeatureState } from '../../content/capabilities';
import { getRegisteredFeatures, searchFeatures } from '../../content/featureRegistry';

interface Props {
  onClose: () => void;
  onOpenFeature: (feature: FeatureKey) => void;
}

const STATE_LABEL: Record<FeatureState, string> = {
  disponible:   'Disponible',
  local:        'Local',
  a_configurer: 'À configurer',
  partiel:      'Partiel',
};

const STATE_COLOR: Record<FeatureState, string> = {
  disponible:   '#3dffaa',
  local:        '#5ee7ff',
  a_configurer: '#ff8b3d',
  partiel:      '#a78bfa',
};

export default function HelpModal({ onClose, onOpenFeature }: Props) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filteredDirectory = useMemo(() => {
    const q = query.trim().toLowerCase();
    const features = getRegisteredFeatures();
    const matchedIds = q ? new Set(searchFeatures(q).map(item => item.id)) : new Set(features.map(item => item.id));

    const grouped = new Map<string, { title: string; emoji: string; items: Array<{ name: string; description: string; feature: FeatureKey; state: FeatureState; keywords?: string[] }> }>();
    for (const definition of features) {
      if (!matchedIds.has(definition.id)) continue;
      const categoryTitle = definition.category || 'Autre';
      const group = grouped.get(categoryTitle) ?? { title: categoryTitle, emoji: '🔧', items: [] };
      group.items.push({
        name: definition.name,
        description: definition.shortDescription,
        feature: definition.id as FeatureKey,
        state: definition.status === 'AVAILABLE' ? 'disponible' : definition.status === 'PARTIAL' ? 'partiel' : definition.status === 'EXPERIMENTAL' ? 'partiel' : 'local',
        keywords: definition.aliases ?? [],
      });
      grouped.set(categoryTitle, group);
    }

    return [...grouped.values()].map(category => ({
      ...category,
      emoji: category.emoji,
      title: category.title,
    }));
  }, [query]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-box"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(720px, calc(100vw - 24px))',
          border: '1px solid rgba(94,231,255,0.2)',
          borderRadius: 12,
          padding: 0,
          overflow: 'hidden',
          boxShadow: '0 30px 90px rgba(0,0,0,0.56)',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-3 px-5 py-4"
          style={{ borderBottom: '1px solid rgba(94,231,255,0.1)', flexShrink: 0 }}
        >
          <HelpCircle size={16} style={{ color: '#5ee7ff', flexShrink: 0 }} />
          <div className="flex-1">
            <h3 className="font-grotesk font-semibold text-base" style={{ color: '#f0eaff' }}>
              Centre d'aide
            </h3>
            <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
              Fonctionnalités de Docteur — cherche ou parcours, puis ouvre directement
            </p>
          </div>
          <button type="button" title="Fermer (Echap)" style={{ color: '#5a4a7a' }} onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3" style={{ borderBottom: '1px solid rgba(94,231,255,0.1)', flexShrink: 0 }}>
          <div className="flex items-center gap-2" style={{
            background: 'rgba(94,231,255,0.05)',
            border: '1px solid rgba(94,231,255,0.15)',
            borderRadius: 8,
            padding: '7px 10px',
          }}>
            <Search size={13} style={{ color: '#5ee7ff', flexShrink: 0 }} />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Rechercher une fonctionnalité (ex. drive, mémoire, images…)"
              aria-label="Rechercher une fonctionnalité"
              className="font-mono text-xs flex-1"
              style={{ background: 'transparent', border: 'none', outline: 'none', color: '#e4e0f5' }}
            />
          </div>
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', flex: 1 }}>

          {/* Feature directory */}
          <div className="px-5 py-4 flex flex-col gap-5">
            {filteredDirectory.length === 0 && (
              <p className="font-mono text-xs" style={{ color: '#5a4a7a' }}>
                Aucune fonctionnalité ne correspond à « {query} ».
              </p>
            )}
            {filteredDirectory.map(category => (
              <div key={category.title}>
                <p className="font-mono text-xs mb-2" style={{ color: '#5ee7ff', letterSpacing: '0.15em' }}>
                  {category.emoji} {category.title.toUpperCase()}
                </p>
                <div className="flex flex-col gap-1.5">
                  {category.items.map(item => (
                    <div
                      key={item.name}
                      className="flex items-start gap-2"
                      style={{
                        background: 'rgba(255,255,255,0.02)',
                        border: '1px solid rgba(255,255,255,0.05)',
                        borderRadius: 8,
                        padding: '8px 10px',
                      }}
                    >
                      <div className="flex-1" style={{ minWidth: 0 }}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-grotesk text-xs font-semibold" style={{ color: '#e4e0f5' }}>
                            {item.name}
                          </span>
                          <span
                            className="font-mono"
                            style={{
                              fontSize: 8,
                              color: STATE_COLOR[item.state],
                              border: `1px solid ${STATE_COLOR[item.state]}33`,
                              background: `${STATE_COLOR[item.state]}14`,
                              borderRadius: 4,
                              padding: '1px 6px',
                              letterSpacing: '0.05em',
                            }}
                          >
                            {STATE_LABEL[item.state]}
                          </span>
                        </div>
                        <p className="font-mono text-xs mt-1" style={{ color: '#8070a8', lineHeight: 1.5 }}>
                          {item.description}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => onOpenFeature(item.feature)}
                        className="font-mono"
                        style={{
                          fontSize: 10,
                          flexShrink: 0,
                          color: '#5ee7ff',
                          background: 'rgba(94,231,255,0.08)',
                          border: '1px solid rgba(94,231,255,0.2)',
                          borderRadius: 6,
                          padding: '5px 10px',
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Ouvrir
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {!query.trim() && (
          <>
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', margin: '0 20px' }} />

          {/* Capabilities sections */}
          <div className="px-5 py-4 flex flex-col gap-5">
            {CAPABILITIES.map(section => (
              <div key={section.title}>
                <p
                  className="font-mono text-xs mb-2"
                  style={{ color: '#5ee7ff', letterSpacing: '0.15em' }}
                >
                  {section.emoji} {section.title}
                </p>
                <ul className="flex flex-col gap-1.5">
                  {section.items.map((item, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span style={{ color: '#3d3060', fontSize: 10, marginTop: 3, flexShrink: 0 }}>▸</span>
                      <span className="font-mono text-xs flex-1" style={{ color: '#c0b0e0', lineHeight: 1.6 }}>
                        {item.text}
                        {item.shortcut && (
                          <span
                            className="ml-2 px-1.5 rounded font-mono"
                            style={{
                              fontSize: 9,
                              background: 'rgba(94,231,255,0.08)',
                              color: '#5ee7ff',
                              border: '1px solid rgba(94,231,255,0.15)',
                              padding: '1px 6px',
                              verticalAlign: 'middle',
                            }}
                          >
                            {item.shortcut}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', margin: '0 20px' }} />

          {/* Limitations */}
          <div className="px-5 py-4">
            <p
              className="font-mono text-xs mb-2"
              style={{ color: '#ff8b3d', letterSpacing: '0.15em' }}
            >
              ⚠️ CE QUE DOCTEUR NE SAIT PAS ENCORE FAIRE
            </p>
            <ul className="flex flex-col gap-1.5">
              {LIMITATIONS.map((item, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span style={{ color: '#5a4a7a', fontSize: 10, marginTop: 3, flexShrink: 0 }}>—</span>
                  <span className="font-mono text-xs" style={{ color: '#7a6c9a', lineHeight: 1.6 }}>
                    {item}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', margin: '0 20px' }} />

          {/* Shortcuts */}
          <div className="px-5 py-4">
            <p
              className="font-mono text-xs mb-2"
              style={{ color: '#a78bfa', letterSpacing: '0.15em' }}
            >
              ⌨️ RACCOURCIS CLAVIER
            </p>
            <div className="flex flex-col gap-1.5">
              {SHORTCUTS.map((s, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span
                    className="font-mono rounded"
                    style={{
                      fontSize: 10,
                      background: 'rgba(167,139,250,0.08)',
                      color: '#a78bfa',
                      border: '1px solid rgba(167,139,250,0.15)',
                      padding: '2px 8px',
                      minWidth: 120,
                      textAlign: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {s.keys}
                  </span>
                  <span className="font-mono text-xs" style={{ color: '#8070a8' }}>{s.desc}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', margin: '0 20px' }} />

          {/* Gesture control */}
          <div className="px-5 py-4">
            <p
              className="font-mono text-xs mb-2"
              style={{ color: '#3dffaa', letterSpacing: '0.15em' }}
            >
              🖐️ CONTRÔLE GESTUEL (Alt+C pour activer la caméra)
            </p>
            <div className="flex flex-col gap-3">
              {GESTURES.map((g, i) => (
                <div key={i} className="flex flex-col gap-0.5">
                  <span className="font-mono text-xs font-semibold" style={{ color: '#3dffaa' }}>{g.gesture}</span>
                  <span className="font-mono text-xs" style={{ color: '#8070a8', lineHeight: 1.5 }}>Comment : {g.how}</span>
                  <span className="font-mono text-xs" style={{ color: '#c0b0e0', lineHeight: 1.5 }}>→ {g.action}</span>
                </div>
              ))}
            </div>
            <p className="font-mono text-xs mt-3" style={{ color: '#5a4a7a', lineHeight: 1.5 }}>
              Réglage de sensibilité dans Paramètres. Le bouton 🐛 sur l'aperçu caméra active un panneau de débogage (geste brut, déplacement mesuré, seuils).
            </p>
          </div>

          {/* Footer hint */}
          <div className="px-5 pb-4">
            <p className="font-mono" style={{ fontSize: 9, color: '#3d3060' }}>
              Pour mettre à jour ce contenu : src/content/capabilities.ts
            </p>
          </div>
          </>
          )}
        </div>
      </div>
    </div>
  );
}
