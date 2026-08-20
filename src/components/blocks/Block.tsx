import React, { useEffect, useRef, useState, memo } from 'react';
import type { Block, BlockType } from '../../lib/types';
import { BLOCK_PLACEHOLDERS } from '../../lib/types';
import { MarkdownContent } from '../../lib/renderMd';
import { getImageUrl } from '../../lib/cortex/client';

// ── Secure link renderer ──────────────────────────────────────────────────────
// Only http/https URLs are made clickable. Trailing punctuation is stripped.
// Every anchor carries target="_blank" + rel="noopener noreferrer".

// Matches http/https URLs. Using explicit char class avoids backtracking on long strings.
const SAFE_URL_RE = /https?:\/\/[\w\-.~:/?#[\]@!$&'()*+,;=%]+/g;

function stripTrailingPunct(url: string): string {
  return url.replace(/[.,;:!?)>\]'"]+$/, '');
}

// ── YouTube helpers ───────────────────────────────────────────────────────────

function getYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0] || null;
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
    return null;
  } catch {
    return null;
  }
}


function renderWithLinks(
  text: string,
  textStyle: React.CSSProperties,
  onFocus: () => void,
  placeholder?: string,
  onPlayVideo?: (id: string) => void,
): React.ReactNode {
  if (!text) {
    return (
      <div
        role="textbox"
        aria-label={placeholder ?? 'Bloc vide'}
        tabIndex={0}
        className="cursor-text"
        style={{ ...textStyle, opacity: 0.2, minHeight: '1.7em', whiteSpace: 'pre-wrap' }}
        onClick={onFocus}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onFocus(); }}
      >
        {placeholder ?? ''}
      </div>
    );
  }

  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  SAFE_URL_RE.lastIndex = 0;

  while ((m = SAFE_URL_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const href = stripTrailingPunct(m[0]);
    // Put back any stripped chars as plain text
    const after = m[0].slice(href.length);
    const ytId = onPlayVideo ? getYouTubeId(href) : null;
    parts.push(
      <span key={m.index} style={{ display: 'inline' }}>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          onFocus={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
          style={{ color: '#5ee7ff', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
          onMouseEnter={e => { e.currentTarget.style.textDecorationStyle = 'solid'; }}
          onMouseLeave={e => { e.currentTarget.style.textDecorationStyle = 'dotted'; }}
        >
          {href}
        </a>
        {ytId && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onPlayVideo!(ytId); }}
            onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
            title="Lire dans Docteur"
            style={{
              display:        'inline-flex',
              alignItems:     'center',
              justifyContent: 'center',
              marginLeft:     5,
              verticalAlign:  'middle',
              width:          20,
              height:         20,
              borderRadius:   '50%',
              border:         'none',
              background:     '#ff0000',
              color:          '#fff',
              fontSize:       9,
              cursor:         'pointer',
              flexShrink:     0,
              lineHeight:     1,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#cc0000'; e.currentTarget.style.transform = 'scale(1.15)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#ff0000'; e.currentTarget.style.transform = 'scale(1)'; }}
          >
            ▶
          </button>
        )}
      </span>,
    );
    if (after) parts.push(after);
    last = m.index + m[0].length;
  }

  if (last < text.length) parts.push(text.slice(last));

  return (
    <div
      role="textbox"
      aria-label="Contenu du bloc"
      tabIndex={0}
      className="cursor-text"
      style={{ ...textStyle, minHeight: '1.7em', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.7 }}
      onClick={onFocus}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onFocus(); }}
    >
      {parts}
    </div>
  );
}

// ─── Block type selector ───────────────────────────────────────────────────────

const TYPES: { type: BlockType; icon: string; label: string }[] = [
  { type: 'paragraph', icon: '¶',  label: 'Paragraphe' },
  { type: 'h1',        icon: 'H1', label: 'Titre 1'    },
  { type: 'h2',        icon: 'H2', label: 'Titre 2'    },
  { type: 'todo',      icon: '☐',  label: 'Tâche'      },
  { type: 'list',      icon: '•',  label: 'Liste'      },
  { type: 'image',     icon: '⬜', label: 'Image'      },
];

// ─── Textarea with auto-resize ─────────────────────────────────────────────────

function AutoTextarea({
  value,
  placeholder,
  className,
  style,
  onChange,
  onKeyDown,
  onFocus,
  autoFocus,
}: {
  value:       string;
  placeholder: string;
  className?:  string;
  style?:      React.CSSProperties;
  onChange:    (v: string) => void;
  onKeyDown:   (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus?:    () => void;
  autoFocus?:  boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function resize() {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  useEffect(() => {
    resize();
  }, [value]);

  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus();
      const len = ref.current.value.length;
      ref.current.setSelectionRange(len, len);
    }
  }, [autoFocus]);

  return (
    <textarea
      ref={ref}
      className={`block-textarea ${className ?? ''}`}
      style={{ minHeight: '1.7em', ...style }}
      value={value}
      placeholder={placeholder}
      rows={1}
      onChange={e => { onChange(e.target.value); resize(); }}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    />
  );
}

// ─── Block component ───────────────────────────────────────────────────────────

interface Props {
  block:            Block;
  focused:          boolean;
  onFocus:          () => void;
  onChange:         (updates: Partial<Block>) => void;
  onEnter:          () => void;
  onDelete:         () => void;
  onPlayVideo?:          (videoId: string) => void;
  onUploadImage?:        (file: File) => Promise<string>;
  onDownloadImageUrl?:   (url: string) => Promise<string>;
  onDeleteImage?:        (imageId: string) => void;
  transferImages?:       boolean;
}

// ── Image block ───────────────────────────────────────────────────────────────

const IS_REMOTE = typeof window !== 'undefined'
  && window.location.hostname !== 'localhost'
  && window.location.hostname !== '127.0.0.1';

function ImageBlock({
  block,
  onChange,
  onDelete,
  onUploadImage,
  onDownloadImageUrl,
  onDeleteImage,
  transferImages = false,
}: {
  block:                Block;
  onChange:             (updates: Partial<Block>) => void;
  onDelete:             () => void;
  onUploadImage?:       (file: File) => Promise<string>;
  onDownloadImageUrl?:  (url: string) => Promise<string>;
  onDeleteImage?:       (imageId: string) => void;
  transferImages?:      boolean;
}) {
  const [urlInput,   setUrlInput]   = useState('');
  const [showUrl,    setShowUrl]    = useState(false);
  const [uploading,  setUploading]  = useState(false);
  const [error,      setError]      = useState('');
  const [lightbox,   setLightbox]   = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const hasImage = !!block.content;

  async function handleFile(file: File) {
    if (!onUploadImage) return;
    setUploading(true);
    setError('');
    try {
      const id = await onUploadImage(file);
      onChange({ content: id });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erreur upload');
    } finally {
      setUploading(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file?.type.startsWith('image/')) void handleFile(file);
  }

  function handleDeleteImage() {
    if (block.content && onDeleteImage) onDeleteImage(block.content);
    onDelete();
  }

  // On remote (mobile) with transferImages=false, show a placeholder instead of loading
  const showPlaceholder = hasImage && IS_REMOTE && !transferImages;

  if (hasImage) {
    if (showPlaceholder) {
      return (
        <div
          style={{
            display:      'flex',
            alignItems:   'center',
            gap:          10,
            padding:      '10px 14px',
            borderRadius: 6,
            border:       '1px dashed #3d2d5a',
            background:   'rgba(61,45,90,0.12)',
            cursor:       'pointer',
          }}
          onClick={() => setLightbox(true)}
          title="Charger l'image depuis le PC"
        >
          <span style={{ fontSize: 18 }}>🖼️</span>
          <span style={{ fontSize: 11, color: '#7a6c9a', fontFamily: 'IBM Plex Mono, monospace' }}>
            Image disponible sur le PC · Appuyer pour charger
          </span>
          {lightbox && (
            <div
              onClick={e => { e.stopPropagation(); setLightbox(false); }}
              style={{
                position:   'fixed',
                inset:      0,
                background: 'rgba(0,0,0,0.85)',
                display:    'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex:     9999,
                cursor:     'zoom-out',
              }}
            >
              <img
                src={getImageUrl(block.content)}
                alt=""
                style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: 8 }}
                onClick={e => e.stopPropagation()}
                onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            </div>
          )}
        </div>
      );
    }

    return (
      <>
        <div
          style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}
          onDragOver={e => e.preventDefault()}
        >
          <img
            src={getImageUrl(block.content)}
            alt=""
            onClick={() => setLightbox(true)}
            style={{
              maxWidth:    '100%',
              maxHeight:   360,
              borderRadius: 6,
              cursor:      'zoom-in',
              display:     'block',
              objectFit:   'contain',
            }}
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
          <button
            type="button"
            title="Supprimer l'image"
            onClick={handleDeleteImage}
            style={{
              position:   'absolute',
              top:        4,
              right:      4,
              width:      22,
              height:     22,
              borderRadius: '50%',
              border:     'none',
              background: 'rgba(20,10,40,0.85)',
              color:      '#ff4d58',
              fontSize:   14,
              lineHeight: 1,
              cursor:     'pointer',
              display:    'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ×
          </button>
        </div>
        {lightbox && (
          <div
            onClick={() => setLightbox(false)}
            style={{
              position:   'fixed',
              inset:      0,
              background: 'rgba(0,0,0,0.85)',
              display:    'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex:     9999,
              cursor:     'zoom-out',
            }}
          >
            <img
              src={getImageUrl(block.content)}
              alt=""
              style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: 8 }}
              onClick={e => e.stopPropagation()}
            />
          </div>
        )}
      </>
    );
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={e => e.preventDefault()}
      style={{
        border:       '2px dashed #3d2d5a',
        borderRadius: 8,
        padding:      '12px 16px',
        display:      'flex',
        flexDirection: 'column',
        gap:          8,
        background:   'rgba(61,45,90,0.12)',
      }}
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          style={{
            fontSize:     11,
            padding:      '4px 10px',
            borderRadius: 6,
            border:       '1px solid #4d3d6a',
            background:   'rgba(61,255,170,0.07)',
            color:        '#3dffaa',
            cursor:       'pointer',
          }}
        >
          {uploading ? '⏳ Upload…' : '📁 Choisir un fichier'}
        </button>
        <button
          type="button"
          onClick={() => setShowUrl(v => !v)}
          style={{
            fontSize:     11,
            padding:      '4px 10px',
            borderRadius: 6,
            border:       '1px solid #4d3d6a',
            background:   'transparent',
            color:        '#8b7ab0',
            cursor:       'pointer',
          }}
        >
          🔗 Depuis une URL
        </button>
        <button
          type="button"
          onClick={onDelete}
          style={{
            fontSize:     11,
            padding:      '4px 8px',
            borderRadius: 6,
            border:       'none',
            background:   'transparent',
            color:        '#5a4a7a',
            cursor:       'pointer',
          }}
        >
          ✕
        </button>
      </div>
      {showUrl && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="url"
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            placeholder="https://exemple.com/image.png"
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleUrlSubmit(); } }}
            style={{
              flex:         1,
              fontSize:     11,
              padding:      '4px 8px',
              borderRadius: 5,
              border:       '1px solid #3d2d5a',
              background:   '#110a24',
              color:        '#e0d8ff',
              outline:      'none',
            }}
          />
          <button
            type="button"
            disabled={uploading || !urlInput.trim()}
            onClick={() => void handleUrlSubmit()}
            style={{
              fontSize:     11,
              padding:      '4px 10px',
              borderRadius: 5,
              border:       'none',
              background:   '#3dffaa22',
              color:        '#3dffaa',
              cursor:       'pointer',
            }}
          >
            OK
          </button>
        </div>
      )}
      {error && <span style={{ fontSize: 11, color: '#ff4d58' }}>{error}</span>}
      <span style={{ fontSize: 10, color: '#5a4a7a' }}>Glissez-déposez une image ici · PNG, JPG, WebP, GIF · max 5 Mo</span>
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
    </div>
  );

  async function handleUrlSubmit() {
    const u = urlInput.trim();
    if (!u || !onDownloadImageUrl) return;
    setUploading(true);
    setError('');
    try {
      const id = await onDownloadImageUrl(u);
      onChange({ content: id });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erreur téléchargement');
    } finally {
      setUploading(false);
    }
  }
}

function BlockComp({ block, focused, onFocus, onChange, onEnter, onDelete, onPlayVideo, onUploadImage, onDownloadImageUrl, onDeleteImage, transferImages = false }: Props) {
  const [showMenu, setShowMenu] = useState(false);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onEnter();
    }
    if (e.key === 'Backspace' && block.content === '') {
      e.preventDefault();
      onDelete();
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  const typeInfo = TYPES.find(t => t.type === block.type) ?? TYPES[0];

  // Font styles per type
  const textStyle: React.CSSProperties = (() => {
    switch (block.type) {
      case 'h1': return {
        fontSize:   '1.65rem',
        fontFamily: 'Space Grotesk, sans-serif',
        fontWeight: 600,
        color:      '#f0eaff',
        lineHeight: 1.3,
      };
      case 'h2': return {
        fontSize:   '1.2rem',
        fontFamily: 'Space Grotesk, sans-serif',
        fontWeight: 500,
        color:      '#d8ccf0',
        lineHeight: 1.4,
      };
      case 'todo': return {
        fontSize:   '0.875rem',
        color:      block.checked ? '#7060a0' : '#e8e0ff',
        textDecoration: block.checked ? 'line-through' : 'none',
      };
      default: return {
        fontSize: '0.875rem',
        color:    '#c8bcdf',
      };
    }
  })();

  return (
    <div
      className="group relative flex items-start gap-2 py-1 block-shell"
      onFocus={onFocus}
    >
      <div className="block-shell-indicator" />

      {/* Type indicator */}
      <div className="relative flex-shrink-0 mt-0.5" style={{ width: 24 }}>
        <button
          tabIndex={-1}
          className="block-type-button w-5 h-5 flex items-center justify-center rounded transition-all opacity-0 group-hover:opacity-100"
          style={{
            fontSize:   11,
            color:      '#7a6c9a',
            background: showMenu ? '#1e1535' : 'transparent',
            fontFamily: 'IBM Plex Mono, monospace',
          }}
          onMouseEnter={e => (e.currentTarget.style.color = '#3dffaa')}
          onMouseLeave={e => {
            if (!showMenu) e.currentTarget.style.color = '#3d3060';
          }}
          onClick={() => setShowMenu(v => !v)}
        >
          {typeInfo.icon}
        </button>

        {/* Type menu */}
        {showMenu && (
          <div
            className="block-menu absolute left-6 top-0 overflow-hidden z-50 shadow-xl"
          >
            {TYPES.map(t => (
              <button
                key={t.type}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors"
                style={{
                  fontSize:   11,
                  fontFamily: 'IBM Plex Mono, monospace',
                  color:      block.type === t.type ? '#3dffaa' : '#c0b0e0',
                  background: block.type === t.type ? 'rgba(61,255,170,0.08)' : 'transparent',
                }}
                onMouseEnter={e => {
                  if (block.type !== t.type) e.currentTarget.style.background = 'rgba(61,255,170,0.05)';
                }}
                onMouseLeave={e => {
                  if (block.type !== t.type) e.currentTarget.style.background = 'transparent';
                }}
                onClick={() => { onChange({ type: t.type }); setShowMenu(false); }}
              >
                <span style={{ width: 14, textAlign: 'center' }}>{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Block content */}
      <div className="flex-1 min-w-0">
        {block.type === 'image' ? (
          <ImageBlock
            block={block}
            onChange={onChange}
            onDelete={onDelete}
            onUploadImage={onUploadImage}
            onDownloadImageUrl={onDownloadImageUrl}
            onDeleteImage={onDeleteImage}
            transferImages={transferImages}
          />
        ) : block.type === 'todo' ? (
          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={block.checked ?? false}
              onChange={e => onChange({ checked: e.target.checked })}
              className="mt-1 flex-shrink-0 cursor-pointer"
              style={{ accentColor: '#3dffaa', width: 14, height: 14 }}
            />
            {focused ? (
              <AutoTextarea
                value={block.content}
                placeholder={BLOCK_PLACEHOLDERS.todo}
                style={textStyle}
                onChange={content => onChange({ content })}
                onKeyDown={handleKeyDown}
                onFocus={onFocus}
                autoFocus={block.content === ''}
              />
            ) : renderWithLinks(block.content, textStyle, onFocus, BLOCK_PLACEHOLDERS.todo, onPlayVideo)}
          </div>
        ) : block.type === 'list' ? (
          <div className="flex items-start gap-2">
            <span
              className="mt-1 flex-shrink-0 select-none"
              style={{ color: '#5ee7ff', fontSize: 14 }}
            >
              ▸
            </span>
            {focused ? (
              <AutoTextarea
                value={block.content}
                placeholder={BLOCK_PLACEHOLDERS.list}
                style={textStyle}
                onChange={content => onChange({ content })}
                onKeyDown={handleKeyDown}
                onFocus={onFocus}
                autoFocus={block.content === ''}
              />
            ) : renderWithLinks(block.content, textStyle, onFocus, BLOCK_PLACEHOLDERS.list, onPlayVideo)}
          </div>
        ) : focused ? (
          <AutoTextarea
            value={block.content}
            placeholder={BLOCK_PLACEHOLDERS[block.type]}
            style={textStyle}
            onChange={content => onChange({ content })}
            onKeyDown={handleKeyDown}
            onFocus={onFocus}
            autoFocus={block.content === ''}
          />
        ) : block.type === 'paragraph' && block.content ? (
          <div
            className="cursor-text"
            onClick={onFocus}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onFocus(); }}
          >
            <MarkdownContent
              text={block.content}
              textStyle={textStyle}
              onPlayVideo={onPlayVideo}
            />
          </div>
        ) : (
          renderWithLinks(block.content, textStyle, onFocus, BLOCK_PLACEHOLDERS[block.type], onPlayVideo)
        )}
      </div>
    </div>
  );
}

export default memo(BlockComp, (prev, next) => {
  // Avoid re-rendering block components unless the block object or focus changes.
  // Parent keeps object identity for unchanged blocks, so shallow equality is sufficient.
  return prev.block === next.block && prev.focused === next.focused;
});
