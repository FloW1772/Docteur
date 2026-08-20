/**
 * renderMd.tsx — Safe Markdown → React renderer
 *
 * Security: zero dangerouslySetInnerHTML. All output is React nodes.
 * Links: validated to http/https only, with target="_blank" + rel="noopener noreferrer".
 * YouTube: optional onPlayVideo callback for ▶ button on YouTube links.
 */

import React from 'react';

// ── URL helpers ───────────────────────────────────────────────────────────────

const SAFE_URL_INLINE = /https?:\/\/[\w\-.~:/?#[\]@!$&'()*+,;=%]+/g;

function stripTrail(url: string): string {
  return url.replace(/[.,;:!?)>\]'"]+$/, '');
}

function getYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0] || null;
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
    return null;
  } catch { return null; }
}

// ── Inline renderer ───────────────────────────────────────────────────────────
// Handles: **bold**, *italic*, `code`, [text](url), raw URLs.
// Order of alternation matters: ** before *, ``` patterns first.

const INLINE_RE = /(\*\*([^*\n]+?)\*\*)|(\*([^*\n]+?)\*)|(__|([^_\n]+?)__)|(_((?!_)[^_\n]+?)_)|(`([^`\n]+?)`)|(\[([^\]\n]+)\]\((https?:\/\/[^)\n]+)\))|(https?:\/\/[\w\-.~:/?#[\]@!$&'()*+,;=%]+)/g;

// Inline link styles (shared)
const LINK_STYLE: React.CSSProperties = {
  color: '#5ee7ff',
  textDecoration: 'underline',
  textDecorationStyle: 'dotted',
};

function InlineLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={LINK_STYLE}
      onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.textDecorationStyle = 'solid'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.textDecorationStyle = 'dotted'; }}
      onClick={e => e.stopPropagation()}
    >
      {children}
    </a>
  );
}

function YtButton({ ytId, onPlayVideo }: { ytId: string; onPlayVideo: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onPlayVideo(ytId); }}
      onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
      title="Lire dans Docteur"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        marginLeft: 5, verticalAlign: 'middle',
        width: 20, height: 20, borderRadius: '50%',
        border: 'none', background: '#ff0000', color: '#fff',
        fontSize: 9, cursor: 'pointer', flexShrink: 0, lineHeight: 1,
      }}
      onMouseEnter={e => { const b = e.currentTarget; b.style.background = '#cc0000'; b.style.transform = 'scale(1.15)'; }}
      onMouseLeave={e => { const b = e.currentTarget; b.style.background = '#ff0000'; b.style.transform = 'scale(1)'; }}
    >
      ▶
    </button>
  );
}

export function renderInline(
  text: string,
  onPlayVideo?: (id: string) => void,
  keyPrefix: string | number = 0,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let keyIdx = 0;
  INLINE_RE.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const k = `${keyPrefix}-${keyIdx++}`;

    if (m[1]) {
      // **bold**
      nodes.push(<strong key={k} style={{ fontWeight: 700, color: 'inherit' }}>{m[2]}</strong>);
    } else if (m[3]) {
      // *italic*
      nodes.push(<em key={k} style={{ fontStyle: 'italic', color: 'inherit' }}>{m[4]}</em>);
    } else if (m[5]) {
      // __bold__
      nodes.push(<strong key={k} style={{ fontWeight: 700, color: 'inherit' }}>{m[6]}</strong>);
    } else if (m[7]) {
      // _italic_
      nodes.push(<em key={k} style={{ fontStyle: 'italic', color: 'inherit' }}>{m[8]}</em>);
    } else if (m[9]) {
      // `code`
      nodes.push(
        <code key={k} style={{
          background: 'rgba(61,255,170,0.10)',
          color: '#3dffaa',
          padding: '1px 5px',
          borderRadius: 3,
          fontFamily: 'IBM Plex Mono, monospace',
          fontSize: '0.85em',
        }}>
          {m[10]}
        </code>,
      );
    } else if (m[11]) {
      // [text](url) — only http/https
      nodes.push(<InlineLink key={k} href={m[13]}>{m[12]}</InlineLink>);
    } else if (m[14]) {
      // raw URL
      const href = stripTrail(m[14]);
      const after = m[14].slice(href.length);
      const ytId = onPlayVideo ? getYouTubeId(href) : null;
      nodes.push(
        <span key={k}>
          <InlineLink href={href}>{href}</InlineLink>
          {ytId && onPlayVideo && <YtButton ytId={ytId} onPlayVideo={onPlayVideo} />}
          {after || null}
        </span>,
      );
    }
    last = m.index + m[0].length;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// ── Block-level tokenizer ────────────────────────────────────────────────────

type MdToken =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'blockquote'; lines: string[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'hr' }
  | { kind: 'para'; text: string };

export function tokenize(md: string): MdToken[] {
  const lines = md.split('\n');
  const tokens: MdToken[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Fenced code block
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      tokens.push({ kind: 'code', lang, text: codeLines.join('\n') });
      continue;
    }

    // ATX headings
    const hm = line.match(/^(#{1,3})\s+(.*)/);
    if (hm) {
      const lvl = hm[1].length as 1 | 2 | 3;
      tokens.push({ kind: 'heading', level: lvl > 3 ? 3 : lvl, text: hm[2].trim() });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(trimmed) && trimmed.length >= 3) {
      tokens.push({ kind: 'hr' });
      i++;
      continue;
    }

    // Blockquote — collect consecutive > lines
    if (line.startsWith('> ') || line === '>') {
      const bqLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        bqLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      tokens.push({ kind: 'blockquote', lines: bqLines });
      continue;
    }

    // Unordered list — collect consecutive - / * / + items (ignoring indentation for simplicity)
    if (/^(\s*)[-*+]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^(\s*)[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s/, ''));
        i++;
        // Allow one blank line between items (tight vs loose list)
        if (i < lines.length && lines[i].trim() === '' && i + 1 < lines.length && /^(\s*)[-*+]\s/.test(lines[i + 1])) {
          i++;
        }
      }
      tokens.push({ kind: 'ul', items });
      continue;
    }

    // Ordered list — collect consecutive N. items
    if (/^\s*\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s/, ''));
        i++;
        if (i < lines.length && lines[i].trim() === '' && i + 1 < lines.length && /^\s*\d+\.\s/.test(lines[i + 1])) {
          i++;
        }
      }
      tokens.push({ kind: 'ol', items });
      continue;
    }

    // Blank line → skip
    if (trimmed === '') {
      i++;
      continue;
    }

    // Paragraph: accumulate consecutive non-special lines
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (next.trim() === '') break;
      if (/^#{1,3}\s/.test(next)) break;
      if (/^\s*[-*+]\s/.test(next)) break;
      if (/^\s*\d+\.\s/.test(next)) break;
      if (next.startsWith('> ')) break;
      if (next.trim().startsWith('```')) break;
      if (/^[-*_]{3,}\s*$/.test(next.trim())) break;
      paraLines.push(next);
      i++;
    }
    tokens.push({ kind: 'para', text: paraLines.join('\n') });
  }

  return tokens;
}

// ── Block-level renderer ─────────────────────────────────────────────────────

export interface MdStyle {
  text:    React.CSSProperties;
  heading: Record<1 | 2 | 3, React.CSSProperties>;
  code:    React.CSSProperties;
  bq:      React.CSSProperties;
  li:      React.CSSProperties;
}

export const DEFAULT_STYLE: MdStyle = {
  text: { fontSize: '0.875rem', color: '#c8bcdf', lineHeight: 1.7 },
  heading: {
    1: { fontSize: '1.25rem', fontFamily: 'Space Grotesk, sans-serif', fontWeight: 600, color: '#f0eaff', margin: '12px 0 6px', lineHeight: 1.3 },
    2: { fontSize: '1.05rem', fontFamily: 'Space Grotesk, sans-serif', fontWeight: 600, color: '#e0d4ff', margin: '10px 0 4px', lineHeight: 1.35 },
    3: { fontSize: '0.95rem', fontFamily: 'Space Grotesk, sans-serif', fontWeight: 600, color: '#c8bcdf', margin: '8px 0 3px', lineHeight: 1.4 },
  },
  code: {
    display: 'block',
    background: 'rgba(61,255,170,0.05)',
    border: '1px solid rgba(61,255,170,0.12)',
    borderRadius: 6,
    padding: '10px 14px',
    fontFamily: 'IBM Plex Mono, monospace',
    fontSize: '0.8rem',
    color: '#3dffaa',
    whiteSpace: 'pre',
    overflowX: 'auto',
    margin: '6px 0',
  },
  bq: {
    borderLeft: '3px solid #5a4a7a',
    paddingLeft: 12,
    margin: '6px 0',
    color: '#9080c0',
    fontStyle: 'italic',
  },
  li: { marginBottom: 3 },
};

export function renderTokens(
  tokens: MdToken[],
  style: MdStyle,
  onPlayVideo?: (id: string) => void,
  headingId?: (level: number, text: string, index: number) => string | undefined,
): React.ReactNode[] {
  return tokens.map((t, idx) => {
    switch (t.kind) {
      case 'heading': {
        const Tag = `h${t.level}` as 'h1' | 'h2' | 'h3';
        const id  = headingId?.(t.level, t.text, idx);
        return (
          <Tag key={idx} id={id} style={style.heading[t.level]}>
            {renderInline(t.text, onPlayVideo, idx)}
          </Tag>
        );
      }
      case 'ul':
        return (
          <ul key={idx} style={{ margin: '4px 0 6px', paddingLeft: 22, listStyleType: 'disc' }}>
            {t.items.map((item, j) => (
              <li key={j} style={style.li}>
                <span style={style.text}>{renderInline(item, onPlayVideo, `${idx}-${j}`)}</span>
              </li>
            ))}
          </ul>
        );
      case 'ol':
        return (
          <ol key={idx} style={{ margin: '4px 0 6px', paddingLeft: 22 }}>
            {t.items.map((item, j) => (
              <li key={j} style={style.li}>
                <span style={style.text}>{renderInline(item, onPlayVideo, `${idx}-${j}`)}</span>
              </li>
            ))}
          </ol>
        );
      case 'blockquote':
        return (
          <blockquote key={idx} style={style.bq}>
            {t.lines.map((l, j) => (
              <div key={j}>{renderInline(l, onPlayVideo, `${idx}-${j}`)}</div>
            ))}
          </blockquote>
        );
      case 'code':
        return <pre key={idx} style={style.code}>{t.text}</pre>;
      case 'hr':
        return <hr key={idx} style={{ border: 'none', borderTop: '1px solid rgba(255,255,255,0.08)', margin: '10px 0' }} />;
      case 'para':
        return (
          <p key={idx} style={{ ...style.text, margin: '0 0 6px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {renderInline(t.text, onPlayVideo, idx)}
          </p>
        );
      default:
        return null;
    }
  });
}

// ── Public component ─────────────────────────────────────────────────────────

interface MarkdownContentProps {
  text:         string;
  textStyle?:   React.CSSProperties;
  onPlayVideo?: (id: string) => void;
  className?:   string;
}

export function MarkdownContent({ text, textStyle, onPlayVideo, className }: MarkdownContentProps) {
  const style: MdStyle = textStyle
    ? { ...DEFAULT_STYLE, text: { ...DEFAULT_STYLE.text, ...textStyle } }
    : DEFAULT_STYLE;

  const tokens = tokenize(text);
  const nodes  = renderTokens(tokens, style, onPlayVideo);

  return (
    <div
      className={className}
      style={{ minHeight: '1.7em', wordBreak: 'break-word' }}
      role="textbox"
      aria-label="Contenu du bloc"
      tabIndex={0}
    >
      {nodes}
    </div>
  );
}
