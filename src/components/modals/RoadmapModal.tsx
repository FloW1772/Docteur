import { useState } from 'react';
import { X, ChevronDown } from 'lucide-react';

// ── Données — éditez ici pour mettre à jour la roadmap ───────────────────────

type Status = 'done' | 'progress' | 'future' | 'abandoned';

interface RoadmapItem {
  label:    string;
  note?:    string;
  domain?:  string;
}

interface RoadmapSection {
  status:  Status;
  title:   string;
  emoji:   string;
  color:   string;
  dimColor: string;
  items:   RoadmapItem[];
}

const SECTIONS: RoadmapSection[] = [
  {
    "status": "done",
    "title": "Terminé et vérifié",
    "emoji": "✓",
    "color": "#3dffaa",
    "dimColor": "rgba(61,255,170,0.08)",
    "items": [
      {
        "domain": "Infrastructure",
        "label": "Compaction LanceDB",
        "note": "Base réelle : 11,11 Go → 24,35 Mo, 182 → 1 fragment en 209,5 s ; 6 587 entrées et identifiants conservés (8 septembre 2026)."
      },
      {
        "domain": "Recherche",
        "label": "Recherche vectorielle après compaction",
        "note": "Les cinq résultats et scores sont identiques avant/après. Une nouvelle question a aussi été testée avec nomic-embed-text dans Ollama : embedding de 768 dimensions et résultats retournés."
      }
    ]
  },
  {
    "status": "progress",
    "title": "Implémenté · validation réelle à compléter",
    "emoji": "⟳",
    "color": "#f59e0b",
    "dimColor": "rgba(245,158,11,0.07)",
    "items": [
      {
        "domain": "Capture",
        "label": "Web, capture profonde, fichiers et corpus",
        "note": "Routes et formulaires branchés ; batch, playlists, chaînes, analyse ciblée et repli MSN à éprouver sur des sources réelles."
      },
      {
        "domain": "Capture",
        "label": "Transcription et OCR",
        "note": "Pipeline vidéo, Whisper local/Groq et Tesseract présents ; caméra, écran et qualité de transcription à valider sur les appareils."
      },
      {
        "domain": "Capture",
        "label": "Dossier surveillé et rapports externes",
        "note": "Watcher démarré par le serveur, imports .md/.txt/.json ; dépôt réel et reprise après erreur à valider."
      },
      {
        "domain": "Recherche",
        "label": "Question/RAG, conversation et comparaison",
        "note": "Routes branchées, mémoire de préférences et clarification présentes ; qualité des réponses et citations à éprouver."
      },
      {
        "domain": "Recherche",
        "label": "Veille et recherche web",
        "note": "Recherche simple/profonde, multi-source et recoupement branchés ; disponibilité des sources et qualité à valider."
      },
      {
        "domain": "Recherche",
        "label": "Kiwix hors ligne et catalogue",
        "note": "kiwix-serve et résolution .meta4 → .zim déjà branchés ; téléchargement et lecture réels à valider."
      },
      {
        "domain": "Recherche",
        "label": "Routeur local/cloud",
        "note": "Clients partagés Gemini, Groq, OpenRouter et autres fournisseurs présents ; scénarios de quotas et replis à valider."
      },
      {
        "domain": "Production",
        "label": "Professeur",
        "note": "Groq et Gemini : validation, plan et première explication testés avec les vrais fournisseurs. OpenRouter : plan réussi, explication vide. Révisions, progression complète et local restent à valider."
      },
      {
        "domain": "Production",
        "label": "Candidature et CV",
        "note": "Import PDF, CV maître, analyse, réécriture et lettres branchés ; parcours réel et confidentialité à revalider."
      },
      {
        "domain": "Production",
        "label": "Prompts, styles, lecture et export PDF",
        "note": "Interfaces et routes présentes ; qualité, relecture croisée et exports réels à valider. Destinations externes : copier-coller."
      },
      {
        "domain": "Automatisation",
        "label": "Agents, compétences et tâches",
        "note": "Planificateur démarré, exécution et sorties reliées à l’interface ; cycles longs et reprise à valider."
      },
      {
        "domain": "Interface",
        "label": "Cortex 3D, lecture et personnalisation",
        "note": "Chargement progressif, registre des modales, personnalité, lecteur vidéo et raccourcis branchés ; ergonomie à revalider."
      },
      {
        "domain": "Interface",
        "label": "Voix, gestes et audio",
        "note": "Porcupine, commandes, VAD, caméra et lecteur audio présents ; tests matériels et permissions à compléter."
      },
      {
        "domain": "Interface",
        "label": "PWA mobile et consultation hors ligne",
        "note": "Service worker et stockage local présents ; installation Android, synchronisation et lecture PC éteint à valider."
      },
      {
        "domain": "Confidentialité",
        "label": "Mode local, filtrage privé et verrou de sortie",
        "note": "Protections présentes dans le code ; couverture de tous les chemins et absence de fuite à revalider, sans garantie globale."
      },
      {
        "domain": "Infrastructure",
        "label": "Compaction automatique et Settings",
        "note": "Contrôle toutes les 5 minutes, seuil de fragments et espace obsolète ; déclenchement prolongé en usage réel à observer."
      },
      {
        "domain": "Infrastructure",
        "label": "Sauvegarde et restauration",
        "note": "Planification et routes branchées ; restauration complète sur une copie à revalider."
      },
      {
        "domain": "Infrastructure",
        "label": "Lancement, HTTPS et performances",
        "note": "Scripts et configuration présents ; certificats PC/Android, démarrage et charge du corpus actuel à mesurer."
      },
      {
        "domain": "Infrastructure",
        "label": "Sécurité et qualité du corpus",
        "note": "Contrôles CORS/SSRF et chemins présents ; audit exhaustif à renouveler. Doublons et contenu expiré restent à traiter."
      }
    ]
  },
  {
    "status": "future",
    "title": "Non implémenté ou à concevoir",
    "emoji": "◇",
    "color": "#7b8cf8",
    "dimColor": "rgba(123,140,248,0.06)",
    "items": [
      {
        "domain": "Automatisation",
        "label": "Digest quotidien / hebdomadaire de la veille"
      },
      {
        "domain": "Recherche",
        "label": "Suggestions automatiques de synapses"
      },
      {
        "domain": "Interface",
        "label": "Synthèse vocale locale Piper",
        "note": "À distinguer de la lecture vocale déjà disponible."
      },
      {
        "domain": "Interface",
        "label": "Contrôle vocal externe, reconnaissance du locuteur et écran de veille"
      },
      {
        "domain": "Recherche",
        "label": "Bot Discord en lecture seule"
      },
      {
        "domain": "Automatisation",
        "label": "Interactions web via MCP",
        "note": "À concevoir dans le périmètre autorisé ; aucune exécution de commandes système."
      },
      {
        "domain": "Infrastructure",
        "label": "Adaptation automatique de la charge CPU/réseau"
      }
    ]
  },
  {
    "status": "abandoned",
    "title": "Décisions écartées",
    "emoji": "✕",
    "color": "#6b7280",
    "dimColor": "rgba(107,114,128,0.06)",
    "items": [
      {
        "label": "Choix du navigateur depuis Docteur",
        "note": "Impossible depuis une page web."
      },
      {
        "label": "Sherlock / OSINT sur des personnes",
        "note": "Profilage de personnes."
      },
      {
        "label": "Exécution de commandes depuis Docteur",
        "note": "Risque de sécurité."
      },
      {
        "label": "Scraping LinkedIn / Indeed",
        "note": "Conditions d’utilisation des plateformes."
      },
      {
        "label": "Exposition sur internet",
        "note": "Risque de sécurité ; usage personnel local."
      },
      {
        "label": "Décodeur ZIM natif en Node",
        "note": "Fragile sur Windows ; kiwix-serve retenu."
      },
      {
        "label": "Envoi automatique vers Replit / Lovable",
        "note": "Pas d’API publique ; copier-coller conservé."
      },
      {
        "label": "Application native Electron / Tauri",
        "note": "Perte du mobile et risque élevé."
      },
      {
        "label": "Indexation/création de projets Git",
        "note": "Hors périmètre ; outils dédiés."
      },
      {
        "label": "Candidatures automatiques et aspiration systématique de sites",
        "note": "Conditions d’utilisation et périmètre du projet."
      }
    ]
  }
];

// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  isOpen:  boolean;
  onClose: () => void;
}

function groupByDomain(items: RoadmapItem[]): { domain: string | null; items: RoadmapItem[] }[] {
  const groups: { domain: string | null; items: RoadmapItem[] }[] = [];
  for (const item of items) {
    const domain = item.domain ?? null;
    let group = groups.find(g => g.domain === domain);
    if (!group) { group = { domain, items: [] }; groups.push(group); }
    group.items.push(item);
  }
  return groups;
}

export default function RoadmapModal({ isOpen, onClose }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  if (!isOpen) return null;

  const toggleDomain = (key: string) => {
    setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position:       'fixed',
        inset:           0,
        background:     'rgba(4,2,12,0.92)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        zIndex:          160,
        display:         'flex',
        alignItems:      'flex-start',
        justifyContent:  'center',
        padding:         '5vh 16px 32px',
        overflowY:       'auto',
        animation:       'modal-fade-in 0.16s ease-out',
      }}
    >
      <div style={{
        width:        '100%',
        maxWidth:      900,
        background:   'rgba(8,6,18,0.98)',
        border:       '1px solid rgba(61,255,170,0.15)',
        borderRadius:  16,
        overflow:      'hidden',
        animation:    'modal-scale-in 0.16s ease-out',
        boxShadow:    '0 32px 80px rgba(0,0,0,0.7)',
      }}>

        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div style={{
          display:      'flex',
          alignItems:   'center',
          padding:      '18px 24px',
          borderBottom: '1px solid rgba(61,255,170,0.1)',
          gap:           12,
        }}>
          <div style={{ flex: 1 }}>
            <h2 className="font-grotesk font-semibold" style={{ color: '#3dffaa', fontSize: 13, letterSpacing: '0.3em', margin: 0 }}>
              ROADMAP
            </h2>
            <p className="font-mono" style={{ color: '#3d3060', fontSize: 10, marginTop: 3, letterSpacing: '0.1em' }}>
              Audit du 8 septembre 2026 · code branché ≠ usage réel validé
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ color: '#3d3060', cursor: 'pointer', padding: 4, background: 'none', border: 'none', lineHeight: 0 }}
            onMouseEnter={e => { e.currentTarget.style.color = '#c0b0e0'; }}
            onMouseLeave={e => { e.currentTarget.style.color = '#3d3060'; }}
            title="Fermer"
          >
            <X size={16} />
          </button>
        </div>

        {/* ── Sections ────────────────────────────────────────────────────────── */}
        <div className="roadmap-grid" style={{ display: 'grid', gap: 0, padding: 0 }}>
          {SECTIONS.map((section, si) => (
            <div
              key={section.status}
              style={{
                padding:     '24px 22px',
                gridColumn: section.status === 'abandoned' ? '1 / -1' : undefined,
                borderRight: si < SECTIONS.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
              }}
            >
              {/* Section header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
                <span style={{
                  width: 24, height: 24, borderRadius: '50%',
                  background: `rgba(${hexRgbOf(section.color)},0.12)`,
                  border:     `1px solid ${section.color}44`,
                  display:    'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize:   11, color: section.color, flexShrink: 0,
                  fontFamily: 'IBM Plex Mono, monospace',
                }}>
                  {section.emoji}
                </span>
                <div>
                  <p className="font-mono" style={{ color: section.color, fontSize: 9, letterSpacing: '0.2em', margin: 0 }}>
                    {section.status === 'done' ? 'FAIT' : section.status === 'progress' ? 'EN COURS' : section.status === 'abandoned' ? 'ÉCARTÉ' : 'FUTUR'}
                  </p>
                  <p className="font-grotesk font-semibold" style={{ color: '#d0c0f0', fontSize: 12, margin: 0, marginTop: 1 }}>
                    {section.title}
                  </p>
                </div>
              </div>

              {/* Items groupés par domaine */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {groupByDomain(section.items).map((group, gi) => {
                  const groupKey = `${section.status}-${group.domain ?? gi}`;
                  const isCollapsed = !!collapsed[groupKey];
                  return (
                    <div key={groupKey}>
                      {group.domain && (
                        <button
                          type="button"
                          onClick={() => toggleDomain(groupKey)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 4,
                            width: '100%', background: 'none', border: 'none', cursor: 'pointer',
                            padding: '0 0 6px', textAlign: 'left',
                          }}
                        >
                          <ChevronDown size={10} color={section.color} style={{
                            opacity: 0.7,
                            transform: isCollapsed ? 'rotate(-90deg)' : 'none',
                            transition: 'transform 0.12s ease',
                            flexShrink: 0,
                          }} />
                          <p className="font-mono" style={{ color: section.color, fontSize: 9, letterSpacing: '0.15em', margin: 0, opacity: 0.75 }}>
                            {group.domain.toUpperCase()}
                          </p>
                        </button>
                      )}
                      {!isCollapsed && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {group.items.map((item, ii) => (
                            <div
                              key={ii}
                              style={{
                                padding:      '8px 12px',
                                borderRadius:  8,
                                background:   section.dimColor,
                                border:       `1px solid ${section.color}18`,
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                                <span style={{
                                  color:      section.color,
                                  fontSize:   10,
                                  flexShrink: 0,
                                  marginTop:  1,
                                  fontFamily: 'IBM Plex Mono, monospace',
                                  opacity:    0.8,
                                }}>
                                  {section.emoji}
                                </span>
                                <div style={{ minWidth: 0 }}>
                                  <p className="font-grotesk" style={{ color: '#e8e0ff', fontSize: 12, margin: 0, lineHeight: 1.4 }}>
                                    {item.label}
                                  </p>
                                  {item.note && (
                                    <p className="font-mono" style={{ color: '#4a3a6a', fontSize: 10, margin: 0, marginTop: 3, lineHeight: 1.4 }}>
                                      {item.note}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────────── */}
        <div style={{
          padding:     '12px 24px',
          borderTop:   '1px solid rgba(61,255,170,0.06)',
          textAlign:   'center',
        }}>
          <p className="font-mono" style={{ color: '#1e1535', fontSize: 9, letterSpacing: '0.1em' }}>
            Projet personnel · non public · évolue au fil des idées
          </p>
        </div>
      </div>

      <style>{`
        .roadmap-grid { grid-template-columns: repeat(3, 1fr); }
        @media (max-width: 700px) {
          .roadmap-grid { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}

// ── Util ─────────────────────────────────────────────────────────────────────

function hexRgbOf(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}
