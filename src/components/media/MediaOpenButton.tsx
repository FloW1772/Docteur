import type { MouseEvent } from 'react';
import { KIND_LABEL, classifyMediaResource, type MediaKind } from '../../lib/media/media-resource';
import { docteurApiOrigin } from '../../lib/media/docteur-origin';

// The "open in Docteur" button shown next to a link (the link itself still opens the original source).
// YouTube keeps the historical red ▶ look; every other kind gets a discreet button with its own glyph.
const GLYPH: Record<MediaKind, string> = { youtube: '▶', video: '▶', audio: '♪', image: '▣', pdf: '▤', text: '≡', web: '◫', unknown: '?' };

export default function MediaOpenButton({ href, onOpen }: { href: string; onOpen: (url: string) => void }) {
  const descriptor = classifyMediaResource({ url: href }, { apiOrigin: docteurApiOrigin() });
  // non-http(s) / private / credentials / malformed: only the plain link stays (it was already filtered).
  // [Browser Media Bridge V1] an allowed link of unknown type still opens the reader's explicit fallback (download / source).
  if (descriptor.blocked) return null;
  const kind = descriptor.kind;
  const youtube = kind === 'youtube';
  const base = youtube ? '#ff0000' : 'rgba(167,139,250,0.22)';
  const hover = youtube ? '#cc0000' : 'rgba(167,139,250,0.4)';
  return (
    <button
      type="button"
      data-testid="open-in-docteur"
      data-media-kind={kind}
      onClick={(e: MouseEvent) => { e.stopPropagation(); onOpen(href); }}
      onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
      title={youtube ? 'Lire dans Docteur' : `Ouvrir dans Docteur (${KIND_LABEL[kind]})`}
      aria-label={youtube ? 'Lire dans Docteur' : `Ouvrir dans Docteur : ${KIND_LABEL[kind]}`}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        marginLeft: 5, verticalAlign: 'middle', width: 20, height: 20, borderRadius: '50%',
        border: youtube ? 'none' : '1px solid rgba(167,139,250,0.45)', background: base, color: youtube ? '#fff' : '#d8ccff',
        fontSize: youtube ? 9 : 10, cursor: 'pointer', flexShrink: 0, lineHeight: 1,
      }}
      onMouseEnter={e => { e.currentTarget.style.background = hover; e.currentTarget.style.transform = 'scale(1.15)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = base; e.currentTarget.style.transform = 'scale(1)'; }}
    >
      {GLYPH[kind]}
    </button>
  );
}
