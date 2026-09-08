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
    status:   'done',
    title:    'Déjà en place',
    emoji:    '✓',
    color:    '#3dffaa',
    dimColor: 'rgba(61,255,170,0.08)',
    items: [
      { domain: 'Capture',       label: 'Capture web simple et profonde', note: 'articles, YouTube, MSN, texte collé, fichiers' },
      { domain: 'Capture',       label: 'Capture en batch, playlists et chaînes YouTube complètes' },
      { domain: 'Capture',       label: 'Analyse ciblée à la capture' },
      { domain: 'Capture',       label: 'Transcription locale + cloud', note: 'faster-whisper local · Groq Whisper optionnel · badge fournisseur dans l\'UI' },
      { domain: 'Capture',       label: 'Dossier surveillé (inbox) + import corpus', note: 'dépôt par glisser-déposer, fichiers → neurones' },
      { domain: 'Capture',       label: 'Dossier surveillé — rapports d\'agents externes', note: '.md / .txt / .json → kind rapport, sécurisé' },
      { domain: 'Capture',       label: 'Détection garbage vidéo MSN', note: 'article_expired, video_content — raisons de fallback loguées' },
      { domain: 'Capture',       label: 'OCR image', note: 'partage d\'écran + caméra, Tesseract' },
      { domain: 'Recherche',     label: 'Recherche sémantique + mode Question (RAG)' },
      { domain: 'Recherche',     label: 'Veille simple, approfondie et multi-source avec recoupement', note: 'crosscheck de sources, relecture critique post-veille' },
      { domain: 'Recherche',     label: 'Niveaux de détail de veille', note: 'réglage fin propagé à tous les formulaires de veille' },
      { domain: 'Recherche',     label: 'Réponse web rapide + recherche web approfondie', note: 'DuckDuckGo, sans IA cloud' },
      { domain: 'Recherche',     label: 'Clarification automatique des questions ambiguës', note: 'JSON structuré, hors personnalité' },
      { domain: 'Recherche',     label: 'Mode conversation avec mémoire de préférences', note: 'table preference_facts' },
      { domain: 'Recherche',     label: 'Comparaison multi-modèles' },
      { domain: 'Recherche',     label: 'Encyclopédies hors-ligne Kiwix (ZIM)', note: 'navigation et lecture d\'archives déjà en place fiables' },
      { domain: 'Recherche',     label: 'Router intelligent local/cloud', note: 'qwen2.5:7b, 14b, Gemini, Groq, OpenRouter, Anthropic' },
      { domain: 'Production',    label: 'Module candidature', note: 'CV, analyse, réécriture, lettres de motivation, offres ciblées, mots-clés ATS, CV maître, import PDF — neurones marqués PRIV' },
      { domain: 'Production',    label: 'Générateur de prompts avec relecture croisée et envoi vers destinations' },
      { domain: 'Production',    label: 'Exemples de style pour les résumés', note: 'appliqués à la capture, la veille et le pipeline vidéo — filtrage privé corrigé (fuite de neurones privés vers le cloud, désormais bloquée)' },
      { domain: 'Production',    label: 'Mode lecture enrichi', note: 'ReadingView, table des matières, typographie confortable' },
      { domain: 'Production',    label: 'Export PDF' },
      { domain: 'Production',    label: 'Écran d\'accueil PWA' },
      { domain: 'Automatisation', label: 'Agents de veille automatique', note: 'synthèse de fond + actualité web avec sources' },
      { domain: 'Automatisation', label: 'Système d\'agents, compétences (skills) et liste de tâches' },
      { domain: 'Automatisation', label: 'Lecteur audio lo-fi', note: 'pistes locales + radios en ligne' },
      { domain: 'Interface',      label: 'Cortex 3D interactif' },
      { domain: 'Interface',      label: 'Personnalité de Docteur', note: 'calme, respectueux, tutoiement/vouvoiement configurable' },
      { domain: 'Interface',      label: 'Activation vocale "Hey Docteur"', note: 'Porcupine WASM 100% local, jamais de wake-word envoyé au cloud' },
      { domain: 'Interface',      label: 'Commandes console et vocales', note: '"lis", "ouvre", "capture", push-to-talk, VAD silence' },
      { domain: 'Interface',      label: 'Contrôle par gestes', note: 'comptage de doigts via caméra' },
      { domain: 'Interface',      label: 'Lecteur vidéo YouTube intégré', note: 'bouton ▶ inline dans les neurones' },
      { domain: 'Interface',      label: 'Raccourcis de sites personnalisés', note: 'console "ouvre <nom>"' },
      { domain: 'Interface',      label: 'Accès mobile PWA + icône écran d\'accueil', note: 'lecture, écriture, capture — PC allumé' },
      { domain: 'Interface',      label: 'Consultation hors-ligne complète', note: 'PC éteint — contenu complet en IndexedDB' },
      { domain: 'Confidentialité', label: 'Confidentialité stricte', note: 'sentinel PRIV, mode strictement local (large couverture), filtrage RAG, audit à l\'export' },
      { domain: 'Confidentialité', label: 'Verrou de sortie (export lock)' },
      { domain: 'Performance',    label: 'Chargement paresseux du cortex', note: '50 neurones au démarrage, contenu chargé à la demande' },
      { domain: 'Performance',    label: 'Registre centralisé des modales', note: 'useModalOpenTracking / useAnyModalOpen — corrige un bug de superposition récurrent (oublié 3 fois avant cette correction)' },
      { domain: 'Infrastructure', label: 'Lanceur unique + script de vérification + script de réinstallation' },
      { domain: 'Infrastructure', label: 'Projet suivi sur GitHub' },
      { domain: 'Infrastructure', label: 'Backup automatique quotidien + synapses', note: 'restauration testée' },
      { domain: 'Infrastructure', label: 'Audit sécurité appliqué', note: 'CORS, SSRF, dépendances, path traversal, symlinks' },
    ],
  },
  {
    status:   'progress',
    title:    'En cours / À consolider',
    emoji:    '⟳',
    color:    '#f59e0b',
    dimColor: 'rgba(245,158,11,0.07)',
    items: [
      { domain: 'Production', label: 'Module professeur', note: 'parcours d\'apprentissage, répétition espacée, registres, modèle dédié — code solidifié (Gemini/OpenRouter câblés, erreurs proprement gérées) mais jamais validé de bout en bout avec un modèle réel dans cette session' },
      { domain: 'Recherche',  label: 'Téléchargement depuis le catalogue Kiwix', note: 'l\'URL renvoyée pointe encore le fichier .zim.meta4 (métalien) et non l\'archive réelle — résolution à finaliser' },
      { domain: 'Performance', label: 'Performances au démarrage', note: '~2 100 neurones — chargement initial à surveiller' },
      { domain: 'Infrastructure', label: 'Nettoyage de la base', note: 'doublons, neurones expirés, ratio qualité' },
      { domain: 'Infrastructure', label: 'HTTPS hors-ligne complet', note: 'certificats mkcert PC + Android — partiellement en place' },
    ],
  },
  {
    status:   'future',
    title:    'Idées futures',
    emoji:    '◇',
    color:    '#7b8cf8',
    dimColor: 'rgba(123,140,248,0.06)',
    items: [
      { label: 'Digest quotidien / hebdo de la veille' },
      { label: 'Connexions automatiques suggérées', note: 'synapses IA entre neurones similaires' },
      { label: 'Synthèse vocale (Piper TTS)', note: 'fr_FR-upmc-medium, 120-140 wpm — réponses lues à voix haute, 100% local' },
      { label: 'Application externe de contrôle vocal', note: 'barre des tâches, indépendante du navigateur' },
      { label: 'Bot Discord en lecture seule', note: 'interroger le cortex depuis Discord' },
      { label: 'Agents externes via dossier surveillé', note: 'OpenWorker, OpenClaw' },
      { label: 'MCP / Docteur qui agit', note: 'naviguer, interagir avec des sites — vision long terme' },
      { label: 'Reconnaissance vocale du locuteur', note: 'pour le fun' },
      { label: 'Écran de veille façon Jarvis' },
      { label: 'Gestion adaptative des performances', note: 'adapter dynamiquement la charge réseau/CPU à la machine' },
    ],
  },
  {
    status:   'abandoned',
    title:    'Décisions écartées',
    emoji:    '✕',
    color:    '#6b7280',
    dimColor: 'rgba(107,114,128,0.06)',
    items: [
      { label: 'Choix du navigateur pour "ouvre"', note: 'navigateur système par défaut suffit — complexité inutile' },
      { label: 'Sherlock / OSINT intégré', note: 'hors périmètre — outil de connaissance, pas d\'investigation' },
      { label: 'Indexation projets Git', note: 'hors périmètre — outils dédiés (VS Code, GitHub) plus adaptés' },
      { label: 'Création de projets Git ou exécution de commandes depuis Docteur', note: 'risque de sécurité — hors périmètre' },
      { label: 'Scraping LinkedIn / Indeed', note: 'risque légal + APIs fragiles — candidature gérée manuellement' },
      { label: 'Envoi automatique de candidatures', note: 'viole les CGU des plateformes' },
      { label: 'Aspiration systématique de sites', note: 'scraping indiscriminé — hors périmètre' },
      { label: 'Décodeur ZIM natif en Node', note: 'fragile sous Windows — kiwix-serve retenu à la place' },
      { label: 'Envoi automatique de prompts vers Replit / Lovable', note: 'pas d\'API publique — assistance copier-coller uniquement' },
      { label: 'Passage en application native Electron / Tauri', note: 'perte de l\'accès mobile — risque trop élevé' },
      { label: 'Exposition internet de Docteur', note: 'outil personnel local — pas de serveur public prévu' },
    ],
  },
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
              Docteur v4.8 · état du projet
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
