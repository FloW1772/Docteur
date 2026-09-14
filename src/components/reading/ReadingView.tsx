/**
 * ReadingView — Mode lecture enrichi pour les neurones longs.
 * Affichage uniquement : le contenu n'est jamais modifié ni sauvegardé.
 * Calculé une seule fois via useMemo dès l'activation.
 */
import { useMemo, useState, memo } from 'react';
import type { ReactNode } from 'react';
import type { Block } from '../../lib/types';
import { tokenize, renderTokens, renderInline } from '../../lib/renderMd';
import type { MdStyle } from '../../lib/renderMd';
import { getImageUrl } from '../../lib/cortex/client';

// ── Reading-mode styles — typographie plus confortable ───────────────────────

const READING_STYLE: MdStyle = {
  text: {
    fontSize:   '1.0625rem',
    color:      '#ddd5f5',
    lineHeight: 1.9,
  },
  heading: {
    1: {
      fontSize:   '1.75rem',
      fontFamily: 'Space Grotesk, sans-serif',
      fontWeight: 700,
      color:      '#f0eaff',
      marginTop:  '2.5rem',
      marginBottom: '1rem',
      lineHeight: 1.2,
      paddingTop: '0.5rem',
      borderTop:  '1px solid rgba(61,255,170,0.08)',
    },
    2: {
      fontSize:   '1.3rem',
      fontFamily: 'Space Grotesk, sans-serif',
      fontWeight: 600,
      color:      '#e0d4ff',
      marginTop:  '2rem',
      marginBottom: '0.75rem',
      lineHeight: 1.3,
    },
    3: {
      fontSize:   '1.05rem',
      fontFamily: 'Space Grotesk, sans-serif',
      fontWeight: 600,
      color:      '#c8bcdf',
      marginTop:  '1.5rem',
      marginBottom: '0.5rem',
      lineHeight: 1.4,
    },
  },
  code: {
    display:     'block',
    background:  'rgba(61,255,170,0.035)',
    border:      '1px solid rgba(61,255,170,0.12)',
    borderLeft:  '3px solid rgba(61,255,170,0.3)',
    borderRadius: 8,
    padding:     '16px 20px',
    fontFamily:  'IBM Plex Mono, monospace',
    fontSize:    '0.875rem',
    color:       '#3dffaa',
    whiteSpace:  'pre',
    overflowX:   'auto',
    margin:      '1.25rem 0',
    lineHeight:  1.65,
  },
  bq: {
    borderLeft:      '4px solid rgba(94,231,255,0.35)',
    background:      'rgba(94,231,255,0.03)',
    paddingLeft:     20,
    paddingRight:    16,
    paddingTop:      10,
    paddingBottom:   10,
    margin:          '1.25rem 0',
    color:           '#9fa0c0',
    fontStyle:       'italic',
    borderRadius:    '0 8px 8px 0',
    lineHeight:      1.75,
  },
  li: { marginBottom: 8, lineHeight: 1.75 },
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface TocEntry {
  level:  1 | 2;
  text:   string;
  id:     string;
}

// ── Stable IDs based on block id — no counter sync needed ────────────────────

function blockHeadingId(blockId: string): string {
  return `rh-${blockId}`;
}

function paraHeadingId(blockId: string, localIdx: number): string {
  return `rh-${blockId}-${localIdx}`;
}

// ── Extract TOC from blocks ───────────────────────────────────────────────────

function extractToc(blocks: Block[]): TocEntry[] {
  const toc: TocEntry[] = [];

  for (const block of blocks) {
    if ((block.type === 'h1' || block.type === 'h2') && block.content.trim()) {
      toc.push({
        level: block.type === 'h1' ? 1 : 2,
        text:  block.content.trim(),
        id:    blockHeadingId(block.id),
      });
    } else if (block.type === 'paragraph' && block.content) {
      let localIdx = 0;
      for (const line of block.content.split('\n')) {
        const m = line.match(/^(#{1,2})\s+(.*)/);
        if (m) {
          toc.push({
            level: m[1].length as 1 | 2,
            text:  m[2].trim(),
            id:    paraHeadingId(block.id, localIdx),
          });
          localIdx++;
        }
      }
    }
  }
  return toc;
}

// ── Read-only image block ─────────────────────────────────────────────────────

function ReadingImage({ content }: { content: string }) {
  const [lightbox, setLightbox] = useState(false);
  if (!content) return null;
  return (
    <>
      <img
        src={getImageUrl(content)}
        alt=""
        onClick={() => setLightbox(true)}
        style={{
          maxWidth:    '100%',
          maxHeight:   480,
          borderRadius: 10,
          cursor:      'zoom-in',
          display:     'block',
          objectFit:   'contain',
          margin:      '1.5rem auto',
        }}
        onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
      />
      {lightbox && (
        <div
          onClick={() => setLightbox(false)}
          style={{
            position:   'fixed', inset: 0,
            background: 'rgba(0,0,0,0.88)',
            display:    'flex', alignItems: 'center', justifyContent: 'center',
            zIndex:     9999, cursor: 'zoom-out',
          }}
        >
          <img
            src={getImageUrl(content)}
            alt=""
            style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: 8 }}
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  blocks:       Block[];
  onPlayVideo?: (videoId: string) => void;
  alwaysOn:     boolean;
  onToggleAlwaysOn: () => void;
  onClose?:      () => void;
}

function ReadingViewInner({ blocks, onPlayVideo, alwaysOn, onToggleAlwaysOn, onClose }: Props) {
  // Compute TOC and rendered content — once per [blocks] identity change.
  const { toc, content } = useMemo(() => {
    const tocEntries = extractToc(blocks);
    const nodes: ReactNode[] = [];

    for (const block of blocks) {
      const key = block.id;

      if (block.type === 'image') {
        nodes.push(<ReadingImage key={key} content={block.content} />);
        continue;
      }

      if (block.type === 'h1' || block.type === 'h2') {
        const Tag = block.type === 'h1' ? 'h1' : 'h2';
        const st  = block.type === 'h1' ? READING_STYLE.heading[1] : READING_STYLE.heading[2];
        nodes.push(
          <Tag key={key} id={blockHeadingId(key)} style={st}>
            {renderInline(block.content, onPlayVideo, key)}
          </Tag>,
        );
        continue;
      }

      if (block.type === 'todo') {
        nodes.push(
          <div key={key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, margin: '0.4rem 0', lineHeight: 1.75 }}>
            <span style={{ flexShrink: 0, marginTop: 3, fontSize: 14, color: block.checked ? '#3dffaa' : '#5a4a7a' }}>
              {block.checked ? '☑' : '☐'}
            </span>
            <span style={{
              ...READING_STYLE.text,
              color:          block.checked ? '#7060a0' : (READING_STYLE.text.color as string),
              textDecoration: block.checked ? 'line-through' : 'none',
              margin:         0,
            }}>
              {renderInline(block.content, onPlayVideo, key)}
            </span>
          </div>,
        );
        continue;
      }

      if (block.type === 'list') {
        nodes.push(
          <div key={key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, margin: '0.25rem 0' }}>
            <span style={{ flexShrink: 0, color: '#5ee7ff', fontSize: 14, marginTop: 4, lineHeight: 1 }}>▸</span>
            <span style={{ ...READING_STYLE.text, margin: 0 }}>
              {renderInline(block.content, onPlayVideo, key)}
            </span>
          </div>,
        );
        continue;
      }

      // paragraph — tokenize markdown, render with reading styles
      // headingId uses stable block-based IDs (no counter sync issue)
      if (block.content) {
        let localHeadingIdx = 0;
        const tokens   = tokenize(block.content);
        const rendered = renderTokens(
          tokens,
          READING_STYLE,
          onPlayVideo,
          (level, _text, _idx) => {
            // Only h1/h2 get TOC anchors; h3 still gets an id but won't be in TOC
            if (level <= 2) return paraHeadingId(key, localHeadingIdx++);
            return undefined;
          },
        );
        nodes.push(
          <div key={key} style={{ margin: '0 0 0.75rem' }}>
            {rendered}
          </div>,
        );
      }
    }

    return { toc: tocEntries, content: nodes };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, onPlayVideo]);

  const showToc = toc.length >= 3;

  return (
    <div className="reading-view-root">
      {/* Table of contents */}
      {showToc && (
        <nav className="reading-toc" aria-label="Sommaire">
          <p className="reading-toc-title">Sommaire</p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {toc.map((entry) => (
              <li key={entry.id} style={{ paddingLeft: entry.level === 2 ? 14 : 0 }}>
                <a
                  href={`#${entry.id}`}
                  className="reading-toc-link"
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(entry.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  {entry.level === 2 && <span style={{ marginRight: 6, opacity: 0.4 }}>·</span>}
                  {entry.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}

      {/* Content */}
      <div className="reading-content">
        {content}
      </div>

      {/* Footer option */}
      <div className="reading-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={alwaysOn}
            onChange={onToggleAlwaysOn}
            style={{ accentColor: '#3dffaa', width: 12, height: 12 }}
          />
          <span>Toujours ouvrir en mode lecture</span>
        </label>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Fermer (Echap)"
            aria-label="Fermer"
            className="flex items-center justify-center w-7 h-7 rounded transition-colors"
            style={{ 
              color: '#5a4a7a', 
              background: 'rgba(90,74,122,0.12)',
              border: '1px solid rgba(90,74,122,0.2)'
            }}
            onMouseEnter={e => { 
              e.currentTarget.style.color = '#e8d9ff';
              e.currentTarget.style.background = 'rgba(94,231,255,0.12)';
              e.currentTarget.style.borderColor = 'rgba(94,231,255,0.3)';
            }}
            onMouseLeave={e => { 
              e.currentTarget.style.color = '#5a4a7a';
              e.currentTarget.style.background = 'rgba(90,74,122,0.12)';
              e.currentTarget.style.borderColor = 'rgba(90,74,122,0.2)';
            }}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

export default memo(ReadingViewInner);

