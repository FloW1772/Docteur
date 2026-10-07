// [Document Toolbox PDF V1] Local PDF workshop. Every action produces a NEW
// document in a temporary in-memory workspace; the user's original files are
// never modified. 100% local (pdf-parse/pdfjs + pdf-lib on cortex-server, OCR
// with the local tesseract.js assets). No cloud, no AI.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Upload, Download, Trash2, ArrowUp, ArrowDown, RotateCw } from 'lucide-react';
import StudioShell from '../studio/StudioShell';
import StudioEmptyState from '../studio/StudioEmptyState';
import OperationStatusLine from '../loading/OperationStatusLine';
import LoadingSpinner from '../loading/LoadingSpinner';
import { useLongOperation } from '../../hooks/useLongOperation';
import { useScreenOcr } from '../../hooks/useScreenOcr';
import { cortexClient } from '../../lib/cortex/client';
import type { ToolboxDoc, ToolboxOperation, ToolboxOperationResult } from '../../lib/cortex/client';

interface Props {
  onClose: () => void;
  /** [Browser Media Bridge V1] document already imported (e.g. a PDF sent from the Media Reader) */
  initialDocId?: string | null;
}

const OP_LABEL: Record<string, string> = {
  upload: 'importé', merge: 'fusion', split: 'séparation', extract: 'extraction', reorder: 'réordonné', rotate: 'rotation',
  delete: 'pages supprimées', duplicate: 'pages dupliquées', metadata: 'métadonnées', watermark: 'filigrane',
  images_to_pdf: 'images → PDF', pdf_to_images: 'PDF → image', compress: 'optimisé',
};
const size = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

export default function DocumentToolboxModal({ onClose, initialDocId = null }: Props) {
  const [docs, setDocs] = useState<ToolboxDoc[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [current, setCurrent] = useState<ToolboxDoc | null>(null);
  const [picked, setPicked] = useState<string[]>([]);          // documents ticked (merge, images → PDF)
  const [selected, setSelected] = useState<number[]>([]);      // pages ticked in the current PDF
  const [order, setOrder] = useState<number[]>([]);            // draft order of the current PDF
  const [fresh, setFresh] = useState<string[]>([]);            // outputs of the last action
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<'none' | 'split' | 'metadata' | 'watermark' | 'text'>('none');
  const [ranges, setRanges] = useState('');
  const [meta, setMeta] = useState({ title: '', author: '', subject: '', keywords: '' });
  const [wmText, setWmText] = useState('CONFIDENTIEL');
  const [wmOpacity, setWmOpacity] = useState(0.2);
  const [text, setText] = useState<Array<{ page: number; text: string }> | null>(null);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const op = useLongOperation('documentToolbox');
  const ocr = useScreenOcr();
  const lastAction = useRef<(() => Promise<void>) | null>(null);

  const refresh = useCallback(async () => {
    try { setDocs((await cortexClient.toolboxList()).docs); } catch { /* shown by the next action */ }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (initialDocId) { setCurrentId(initialDocId); setFresh([initialDocId]); } }, [initialDocId]);

  useEffect(() => {
    if (!currentId) { setCurrent(null); return; }
    let alive = true;
    cortexClient.toolboxInfo(currentId).then(r => {
      if (!alive) return;
      setCurrent(r.doc);
      setSelected([]);
      setOrder(range(r.doc.info?.pageCount ?? 0));
      setText(null); setOcrText(null);
      setMeta({ title: r.doc.info?.metadata.title ?? '', author: r.doc.info?.metadata.author ?? '', subject: r.doc.info?.metadata.subject ?? '', keywords: r.doc.info?.metadata.keywords ?? '' });
    }).catch(err => { if (alive) setNotice((err as Error).message); });
    return () => { alive = false; };
  }, [currentId]);

  const isPdf = current?.kind === 'pdf';
  const reordered = useMemo(() => order.some((p, i) => p !== i + 1), [order]);

  async function run(label: string, body: ToolboxOperation) {
    const action = async () => {
      setNotice(null);
      const result = await op.run(label, () => cortexClient.toolboxOperation(body)) as ToolboxOperationResult | undefined;
      if (!result?.outputs) return;
      setFresh(result.outputs.map(o => o.id));
      await refresh();
      if (result.compression) {
        const { before, after } = result.compression;
        setNotice(`COMPRESSION_LIMITED — optimisation de structure seulement (pdf-lib ne recompresse ni les images ni les polices) : ${size(before)} → ${size(after)}.`);
      } else {
        setNotice(`${result.outputs.length} nouveau(x) document(s) créé(s). Les originaux ne sont pas modifiés.`);
      }
      if (result.outputs.length === 1 && result.outputs[0].kind === 'pdf') setCurrentId(result.outputs[0].id);
    };
    lastAction.current = action;
    await action();
  }

  async function addFiles(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    const action = async () => {
      setNotice(null);
      const uploaded = await op.run(`Import de ${list.length} fichier(s)`, async ({ setStep, setProgress }) => {
        const out: ToolboxDoc[] = [];
        for (const [i, f] of list.entries()) {
          setStep(`Lecture de « ${f.name} »…`);
          setProgress({ current: i, total: list.length, unit: 'fichiers' });
          out.push((await cortexClient.toolboxUpload(f)).doc);
        }
        setProgress({ current: list.length, total: list.length, unit: 'fichiers' });
        return out;
      });
      if (!uploaded) return;
      setFresh(uploaded.map(d => d.id));
      await refresh();
      const firstPdf = uploaded.find(d => d.kind === 'pdf');
      if (firstPdf) setCurrentId(firstPdf.id);
    };
    lastAction.current = action;
    await action();
  }

  const togglePage = (p: number) => setSelected(s => (s.includes(p) ? s.filter(x => x !== p) : [...s, p].sort((a, b) => a - b)));
  const togglePick = (id: string) => setPicked(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]));
  const move = (index: number, delta: number) => setOrder(o => {
    const j = index + delta;
    if (j < 0 || j >= o.length) return o;
    const next = [...o]; [next[index], next[j]] = [next[j], next[index]];
    return next;
  });
  const pickedPdfs = docs.filter(d => picked.includes(d.id) && d.kind === 'pdf');
  const pickedImages = docs.filter(d => picked.includes(d.id) && d.kind !== 'pdf');
  const busy = op.running;
  const needPages = selected.length === 0;

  async function showText() {
    if (!current) return;
    setPanel('text');
    const r = await op.run('Extraction du texte', () => cortexClient.toolboxText(current.id));
    if (r) setText(r.pages);
  }
  async function runOcr() {
    if (!current || selected.length !== 1) return;
    setPanel('text');
    // Local OCR (public/tesseract assets): the page is rendered by cortex-server and read in this browser.
    const result = await ocr.recognize(cortexClient.toolboxPageImageUrl(current.id, selected[0], 2));
    setOcrText(result ?? '');
  }

  return (
    <StudioShell
      icon={<FileText size={18} />}
      title="Atelier PDF"
      onClose={onClose}
      subtitle={<>100 % local. Chaque action crée un nouveau document : vos fichiers d’origine ne sont jamais modifiés. Atelier temporaire en mémoire — téléchargez vos résultats.</>}
    >
      <div className="tb-layout">
        <aside className="tb-side" aria-label="Documents de l’atelier">
          <div
            className={`tb-drop${dragOver ? ' is-over' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); void addFiles(e.dataTransfer.files); }}
          >
            <button type="button" className="tb-btn tb-btn--primary" onClick={() => fileRef.current?.click()} disabled={busy}><Upload size={13} aria-hidden="true" /> Ajouter PDF ou images</button>
            <span className="tb-hint">ou glissez-les ici · PDF, PNG, JPEG, WebP, GIF · 50 Mo max</span>
            <input ref={fileRef} type="file" multiple accept="application/pdf,image/png,image/jpeg,image/webp,image/gif" hidden onChange={e => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} aria-label="Fichiers à ajouter" />
          </div>
          <div className="tb-actions">
            <button type="button" className="tb-btn" disabled={busy || pickedPdfs.length < 2} onClick={() => { void run('Fusion', { op: 'merge', docIds: pickedPdfs.map(d => d.id) }); }}>Fusionner ({pickedPdfs.length})</button>
            <button type="button" className="tb-btn" disabled={busy || pickedImages.length < 1} onClick={() => { void run('Images → PDF', { op: 'images_to_pdf', docIds: pickedImages.map(d => d.id) }); }}>Images → PDF ({pickedImages.length})</button>
          </div>
          <ul className="tb-docs">
            {docs.map(d => (
              <li key={d.id} className={`tb-doc${d.id === currentId ? ' is-current' : ''}${fresh.includes(d.id) ? ' is-fresh' : ''}`} data-doc={d.name}>
                <label className="tb-pick"><input type="checkbox" checked={picked.includes(d.id)} onChange={() => togglePick(d.id)} aria-label={`Sélectionner ${d.name}`} /></label>
                <button type="button" className="tb-doc-main" onClick={() => setCurrentId(d.id)} aria-current={d.id === currentId ? 'true' : undefined} disabled={d.kind !== 'pdf'}>
                  <span className="tb-doc-name">{d.name}</span>
                  <span className="tb-doc-meta">{d.kind.toUpperCase()}{d.pageCount ? ` · ${d.pageCount} p.` : ''} · {size(d.size)}{d.origin ? ` · ${OP_LABEL[d.origin.op] ?? d.origin.op}` : ''}{fresh.includes(d.id) ? ' · nouveau' : ''}</span>
                </button>
                <a className="tb-icon" href={cortexClient.toolboxDownloadUrl(d.id)} download={d.name} aria-label={`Télécharger ${d.name}`}><Download size={13} aria-hidden="true" /></a>
                <button type="button" className="tb-icon" aria-label={`Retirer ${d.name} de l’atelier`} onClick={() => { void cortexClient.toolboxRemove(d.id).then(() => { if (d.id === currentId) setCurrentId(null); setPicked(p => p.filter(x => x !== d.id)); return refresh(); }); }}><Trash2 size={13} aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="tb-main" aria-label="Document sélectionné">
          <OperationStatusLine operation={op} onRetry={() => { void lastAction.current?.(); }} />
          {notice && <p className="tb-notice" role="status">{notice}</p>}
          {!current || !isPdf ? (
            <StudioEmptyState message="Ajoutez un PDF (ou des images à convertir) pour commencer." />
          ) : (
            <>
              <header className="tb-head">
                <h3>{current.name}</h3>
                <span>{current.info?.pageCount} pages · {size(current.size)}{current.info?.metadata.title ? ` · titre : ${current.info.metadata.title}` : ''}</span>
              </header>
              <div className="tb-toolbar" role="toolbar" aria-label="Actions sur les pages">
                <span className="tb-count">{selected.length} page(s) sélectionnée(s)</span>
                <button type="button" className="tb-btn" onClick={() => setSelected(selected.length === order.length ? [] : range(order.length))}>{selected.length === order.length ? 'Tout désélectionner' : 'Tout sélectionner'}</button>
                <button type="button" className="tb-btn" disabled={busy || needPages} onClick={() => { void run('Extraction des pages', { op: 'extract', docId: current.id, pages: selected }); }}>Extraire</button>
                <button type="button" className="tb-btn" disabled={busy || needPages} onClick={() => { void run('Suppression des pages', { op: 'delete', docId: current.id, pages: selected }); }}>Supprimer</button>
                <button type="button" className="tb-btn" disabled={busy || needPages} onClick={() => { void run('Duplication des pages', { op: 'duplicate', docId: current.id, pages: selected }); }}>Dupliquer</button>
                {([90, 180, 270] as const).map(a => (
                  <button key={a} type="button" className="tb-btn" disabled={busy || needPages} onClick={() => { void run(`Rotation ${a}°`, { op: 'rotate', docId: current.id, pages: selected, angle: a }); }}><RotateCw size={12} aria-hidden="true" /> {a}°</button>
                ))}
                <button type="button" className="tb-btn" disabled={busy || needPages} onClick={() => { void run('PDF → images', { op: 'pdf_to_images', docId: current.id, pages: selected, scale: 2 }); }}>En images</button>
                <button type="button" className="tb-btn" disabled={busy || !reordered} onClick={() => { void run('Nouvel ordre des pages', { op: 'reorder', docId: current.id, order }); }}>Appliquer le nouvel ordre</button>
              </div>
              <div className="tb-toolbar" role="toolbar" aria-label="Actions sur le document">
                <button type="button" className="tb-btn" aria-expanded={panel === 'split'} onClick={() => setPanel(panel === 'split' ? 'none' : 'split')}>Séparer…</button>
                <button type="button" className="tb-btn" aria-expanded={panel === 'metadata'} onClick={() => setPanel(panel === 'metadata' ? 'none' : 'metadata')}>Métadonnées…</button>
                <button type="button" className="tb-btn" aria-expanded={panel === 'watermark'} onClick={() => setPanel(panel === 'watermark' ? 'none' : 'watermark')}>Filigrane…</button>
                <button type="button" className="tb-btn" disabled={busy} onClick={() => { void showText(); }}>Texte</button>
                <button type="button" className="tb-btn" disabled={busy || selected.length !== 1 || ocr.phase === 'loading' || ocr.phase === 'recognizing'} onClick={() => { void runOcr(); }} title="Une page sélectionnée">OCR (local)</button>
                <button type="button" className="tb-btn" disabled={busy} onClick={() => { void run('Optimisation', { op: 'compress', docId: current.id }); }}>Optimiser (limité)</button>
              </div>

              {panel === 'split' && (
                <form className="tb-panel" onSubmit={e => { e.preventDefault(); void run('Séparation', { op: 'split', docId: current.id, ranges }); }}>
                  <label htmlFor="tb-ranges">Plages de pages</label>
                  <input id="tb-ranges" value={ranges} onChange={e => setRanges(e.target.value)} placeholder="1-3, 4, 5-8" />
                  <button type="submit" className="tb-btn" disabled={busy || !ranges.trim()}>Séparer selon les plages</button>
                  <button type="button" className="tb-btn" disabled={busy} onClick={() => { void run('Séparation page par page', { op: 'split', docId: current.id, every: 1 }); }}>Une page par fichier</button>
                </form>
              )}
              {panel === 'metadata' && (
                <form className="tb-panel" onSubmit={e => { e.preventDefault(); void run('Métadonnées', { op: 'metadata', docId: current.id, metadata: meta }); }}>
                  {(['title', 'author', 'subject', 'keywords'] as const).map(k => (
                    <span key={k} className="tb-field">
                      <label htmlFor={`tb-meta-${k}`}>{{ title: 'Titre', author: 'Auteur', subject: 'Sujet', keywords: 'Mots-clés' }[k]}</label>
                      <input id={`tb-meta-${k}`} value={meta[k]} onChange={e => setMeta(m => ({ ...m, [k]: e.target.value }))} />
                    </span>
                  ))}
                  <button type="submit" className="tb-btn" disabled={busy}>Créer une copie avec ces métadonnées</button>
                </form>
              )}
              {panel === 'watermark' && (
                <form className="tb-panel" onSubmit={e => { e.preventDefault(); void run('Filigrane', { op: 'watermark', docId: current.id, watermark: { text: wmText, opacity: wmOpacity, ...(selected.length ? { pages: selected } : {}) } }); }}>
                  <label htmlFor="tb-wm-text">Texte du filigrane</label>
                  <input id="tb-wm-text" value={wmText} maxLength={120} onChange={e => setWmText(e.target.value)} />
                  <label htmlFor="tb-wm-opacity">Opacité</label>
                  <input id="tb-wm-opacity" type="range" min={0.05} max={1} step={0.05} value={wmOpacity} onChange={e => setWmOpacity(Number(e.target.value))} />
                  <button type="submit" className="tb-btn" disabled={busy || !wmText.trim()}>Appliquer {selected.length ? `aux ${selected.length} page(s)` : 'à toutes les pages'}</button>
                </form>
              )}
              {panel === 'text' && (
                <section className="tb-panel tb-text" aria-label="Texte du document">
                  {ocr.phase === 'loading' || ocr.phase === 'recognizing' ? <LoadingSpinner label={`OCR local… ${Math.round(ocr.progress * 100)} %`} /> : null}
                  {ocr.error && <p className="tb-error" role="alert">OCR : {ocr.error}</p>}
                  {ocrText !== null && <><h4>OCR — page {selected[0]}</h4><pre>{ocrText || '(aucun texte reconnu)'}</pre></>}
                  {text && (text.every(p => !p.text.trim())
                    ? <p>Aucun texte extractible : document probablement scanné. Sélectionnez une page et utilisez « OCR (local) ».</p>
                    : text.map(p => <div key={p.page}><h4>Page {p.page}</h4><pre>{p.text}</pre></div>))}
                </section>
              )}

              <ol className="tb-pages" aria-label="Pages (ordre de travail)">
                {order.map((p, i) => (
                  <li key={`${p}-${i}`} className={`tb-page${selected.includes(p) ? ' is-selected' : ''}`} data-page={p}>
                    <label className="tb-page-pick">
                      <input type="checkbox" checked={selected.includes(p)} onChange={() => togglePage(p)} aria-label={`Sélectionner la page ${p}`} />
                      <img src={cortexClient.toolboxPageImageUrl(current.id, p, 0.25)} alt={`Page ${p}`} loading="lazy" />
                    </label>
                    <span className="tb-page-num">Page {p}{current.info?.pages[p - 1]?.rotation ? ` · ${current.info.pages[p - 1].rotation}°` : ''}</span>
                    <span className="tb-page-move">
                      <button type="button" className="tb-icon" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Monter la page ${p}`}><ArrowUp size={12} aria-hidden="true" /></button>
                      <button type="button" className="tb-icon" onClick={() => move(i, 1)} disabled={i === order.length - 1} aria-label={`Descendre la page ${p}`}><ArrowDown size={12} aria-hidden="true" /></button>
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      </div>
    </StudioShell>
  );
}
