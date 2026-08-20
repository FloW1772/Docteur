import { chromium }          from 'playwright';
import { marked, Renderer }  from 'marked';
import fs                    from 'node:fs';
import path                  from 'node:path';
import { fileURLToPath }     from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..', '..');
const IMAGE_DIR  = path.join(ROOT, 'data', 'images');

// Strict image-id validator — same pattern as image.js
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif)$/i;

// ── HTML escape ───────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Image → base64 data URI (embedded directly in PDF, no HTTP needed) ───────

function imageDataUri(imageId) {
  if (!imageId || !ID_RE.test(imageId)) return null;
  try {
    const buf  = fs.readFileSync(path.join(IMAGE_DIR, imageId));
    const ext  = path.extname(imageId).slice(1).toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
               : ext === 'png'  ? 'image/png'
               : ext === 'webp' ? 'image/webp'
               : ext === 'gif'  ? 'image/gif' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

// ── Marked: custom renderer to turn ```mermaid fences into .mermaid divs ─────

const renderer = new Renderer();
renderer.code = ({ text, lang }) => {
  if (lang === 'mermaid') {
    return `<div class="mermaid">${esc(text)}</div>\n`;
  }
  return `<pre><code class="language-${esc(lang ?? '')}">${esc(text)}</code></pre>\n`;
};
marked.use({ renderer });

function mdToHtml(content) {
  if (!content) return '';
  return marked.parse(String(content));
}

// ── Blocks → HTML ─────────────────────────────────────────────────────────────

function blocksToHtml(blocks) {
  let html = '';
  for (const block of (blocks ?? [])) {
    const raw = block.content ?? '';
    switch (block.type) {
      case 'h1':
        html += `<h2>${esc(raw)}</h2>\n`;
        break;
      case 'h2':
        html += `<h3>${esc(raw)}</h3>\n`;
        break;
      case 'paragraph':
        html += `<p>${marked.parseInline(raw)}</p>\n`;
        break;
      case 'list':
        html += `<ul><li>${marked.parseInline(raw)}</li></ul>\n`;
        break;
      case 'todo': {
        const ch      = block.checked ? ' checked' : '';
        const strike  = block.checked ? ' style="text-decoration:line-through;color:#9ca3af"' : '';
        html += `<div class="todo-item"><input type="checkbox" disabled${ch}> <span${strike}>${marked.parseInline(raw)}</span></div>\n`;
        break;
      }
      case 'image': {
        const uri = imageDataUri(raw);
        if (uri) html += `<figure><img src="${uri}" alt="Image" class="neuron-img"></figure>\n`;
        break;
      }
      default:
        html += `<p>${marked.parseInline(raw)}</p>\n`;
    }
  }
  return html;
}

// ── CSS ───────────────────────────────────────────────────────────────────────
// System fonts only — no CDN dependency, reliable offline rendering.

const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  font-size: 11pt;
  line-height: 1.7;
  color: #1e1b4b;
  background: #fff;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

h1 { font-size: 22pt; font-weight: 700; color: #0f0c29; margin: 18pt 0 6pt; line-height: 1.2; }
h2 { font-size: 15pt; font-weight: 600; color: #1e1b4b; margin: 14pt 0 5pt; }
h3 { font-size: 12pt; font-weight: 600; color: #312e81; margin: 10pt 0 4pt; }
h4 { font-size: 11pt; font-weight: 600; color: #4338ca; margin: 8pt 0 3pt; }

p { margin: 0 0 7pt; }
ul, ol { margin: 3pt 0 7pt 18pt; }
li { margin: 2pt 0; }

a { color: #4f46e5; }

strong { font-weight: 600; color: #0f0c29; }
em { font-style: italic; }

code {
  font-family: Consolas, 'Courier New', monospace;
  font-size: 9pt;
  background: #f1f5f9;
  padding: 1pt 4pt;
  border-radius: 3pt;
  color: #be185d;
}

pre {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 5pt;
  padding: 9pt 12pt;
  margin: 7pt 0;
  white-space: pre-wrap;
  word-break: break-word;
}
pre code { background: none; padding: 0; font-size: 9pt; color: #1e293b; }

blockquote {
  border-left: 3pt solid #6366f1;
  padding: 5pt 10pt;
  margin: 7pt 0;
  background: #f5f3ff;
  color: #4338ca;
  border-radius: 0 3pt 3pt 0;
}

hr { border: none; border-top: 1px solid #e2e8f0; margin: 12pt 0; }

table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 10pt; }
th, td { border: 1px solid #e2e8f0; padding: 5pt 8pt; text-align: left; }
th { background: #f5f3ff; font-weight: 600; }

img { max-width: 100%; height: auto; }
.neuron-img {
  max-width: 100%; max-height: 280pt;
  object-fit: contain;
  border: 1px solid #e2e8f0; border-radius: 5pt;
  display: block; margin: 0 auto;
}
figure { margin: 10pt 0; text-align: center; }

.todo-item { display: flex; align-items: baseline; gap: 7pt; margin: 3pt 0; }
.todo-item input { flex-shrink: 0; }

.meta {
  font-size: 9pt; color: #94a3b8;
  display: flex; align-items: center; gap: 10pt; flex-wrap: wrap;
  margin: 4pt 0 14pt;
}
.meta a { color: #6366f1; }

.badge {
  display: inline-flex; align-items: center;
  background: #ede9fe; color: #6d28d9;
  padding: 2pt 7pt; border-radius: 20pt;
  font-size: 8pt; font-weight: 600;
}

/* Cover page */
.cover {
  min-height: 100vh;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  text-align: center; padding: 48pt;
  background: linear-gradient(135deg, #f5f3ff 0%, #ede9fe 100%);
  page-break-after: always;
}
.cover-brand { font-size: 9pt; letter-spacing: 6pt; color: #7c3aed; font-weight: 700; text-transform: uppercase; margin-bottom: 28pt; }
.cover-title { font-size: 26pt; font-weight: 700; color: #1e1b4b; line-height: 1.2; margin-bottom: 14pt; max-width: 400pt; }
.cover-sub   { font-size: 11pt; color: #6d28d9; margin-bottom: 6pt; }
.cover-src   { font-size: 9pt; color: #6366f1; margin-top: 10pt; }
.cover-date  { font-size: 9pt; color: #94a3b8; margin-top: 28pt; }

/* TOC */
.toc { page-break-after: always; }
.toc-kicker { font-size: 9pt; letter-spacing: 2pt; text-transform: uppercase; color: #94a3b8; margin-bottom: 12pt; }
.toc-list { list-style: none; padding: 0; margin: 0; }
.toc-item { padding: 4pt 0; border-bottom: 1px dotted #e2e8f0; display: flex; gap: 8pt; font-size: 10pt; color: #4338ca; }
.toc-num   { color: #94a3b8; font-size: 9pt; min-width: 18pt; }

/* Content sections */
.section { margin-bottom: 20pt; }
.section-hd { border-left: 3pt solid #6366f1; padding-left: 10pt; margin-bottom: 10pt; }

/* Intro box */
.intro-box {
  background: #f5f3ff; border: 1px solid #ddd6fe;
  border-radius: 7pt; padding: 14pt;
  font-style: italic; color: #4338ca; margin: 14pt 0;
}
.intro-label {
  font-style: normal; font-weight: 600; font-size: 8pt;
  letter-spacing: 2pt; text-transform: uppercase; color: #7c3aed; margin-bottom: 7pt;
}

/* Limit warning */
.warn { background: #fef3c7; border: 1px solid #fbbf24; border-radius: 5pt; padding: 9pt 12pt; font-size: 10pt; color: #92400e; margin-bottom: 14pt; }

/* Appendix */
.appendix-title { font-size: 10pt; font-weight: 600; color: #64748b; letter-spacing: 1pt; text-transform: uppercase; border-top: 1px solid #e2e8f0; padding-top: 14pt; margin-top: 20pt 0 7pt; }
.linked { display: flex; gap: 7pt; align-items: center; padding: 5pt 0; border-bottom: 1px solid #f1f5f9; font-size: 10pt; color: #4338ca; }

/* Sources */
.sources-hd { font-size: 9pt; letter-spacing: 2pt; text-transform: uppercase; color: #94a3b8; margin-bottom: 7pt; }
.source-item { font-size: 9pt; color: #64748b; padding: 2pt 0; }
.source-item a { color: #6366f1; }

/* Footer bar */
.page-footer { padding: 12pt 0; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; font-size: 9pt; color: #94a3b8; margin-top: 24pt; }

@media print {
  .cover { min-height: 100vh; }
  .no-break { page-break-inside: avoid; }
  figure { page-break-inside: avoid; }
  pre    { page-break-inside: avoid; }
}
`;

// ── Mermaid CDN snippet (only injected in complete mode) ──────────────────────

const MERMAID_SCRIPT = `
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script>
  window.addEventListener('load', function () {
    if (typeof mermaid !== 'undefined') {
      mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' });
      mermaid.run({ querySelector: '.mermaid' }).catch(function(){});
    }
  });
</script>`;

// ── Date helper ───────────────────────────────────────────────────────────────

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' });
}

const KIND_LABELS = {
  note:'Note', task:'Tâche', idea:'Idée', reference:'Référence', memory:'Mémoire',
  channel:'Channel', video:'Vidéo', link:'Lien', playlist:'Playlist',
  question:'Question', recherche:'Recherche',
};
function kindLabel(k) { return KIND_LABELS[k] ?? String(k); }

// ── HTML builders ─────────────────────────────────────────────────────────────

export function buildNeuronHtml(page, linkedPages = [], mode = 'basic') {
  const title    = esc(page.title || 'Sans titre');
  const kl       = kindLabel(page.kind);
  const date     = fmtDate(page.createdAt);
  const url      = String(page.metadata?.url ?? '');
  const srcHtml  = url ? `Source : <a href="${esc(url)}">${esc(url.length > 70 ? url.slice(0, 67) + '…' : url)}</a>` : '';
  const bodyHtml = blocksToHtml(page.blocks);
  const today    = new Date().toLocaleDateString('fr-FR');

  if (mode === 'basic') {
    return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>${title}</title>
<style>${CSS}</style></head>
<body style="padding:20pt 32pt">
  <h1>${title}</h1>
  <div class="meta">
    <span class="badge">${esc(kl)}</span>
    ${date ? `<span>${esc(date)}</span>` : ''}
    ${srcHtml ? `<span>${srcHtml}</span>` : ''}
  </div>
  <hr>
  <div class="content">${bodyHtml}</div>
  <div class="page-footer"><span>Exporté depuis Docteur</span><span>${today}</span></div>
</body></html>`;
  }

  // ── Complete mode ──────────────────────────────────────────────────────────
  const headings = (page.blocks ?? []).filter(b => b.type === 'h1' || b.type === 'h2');
  const hasToc   = headings.length >= 3;
  const tocHtml  = hasToc ? headings.map((b, i) =>
    `<li class="toc-item"><span class="toc-num">${i + 1}.</span>${esc(b.content ?? '')}</li>`
  ).join('\n') : '';

  const appendixHtml = linkedPages.length > 0 ? `
    <p class="appendix-title">Neurones liés (${linkedPages.length})</p>
    ${linkedPages.map(lp => `<div class="linked">
      <span class="badge" style="min-width:55pt;justify-content:center">${esc(kindLabel(lp.kind))}</span>
      <span>${esc(lp.title || 'Sans titre')}</span>
    </div>`).join('')}` : '';

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>${title}</title>
<style>${CSS}</style>${MERMAID_SCRIPT}</head>
<body>
  <div class="cover">
    <div class="cover-brand">Docteur</div>
    <div class="cover-title">${title}</div>
    <div class="cover-sub">${esc(kl)}</div>
    ${srcHtml ? `<div class="cover-src">${srcHtml}</div>` : ''}
    <div class="cover-date">Créé le ${date}${date ? ' · ' : ''}Exporté le ${today}</div>
  </div>

  ${hasToc ? `<div class="toc" style="padding:20pt 32pt">
    <p class="toc-kicker">Table des matières</p>
    <ul class="toc-list">${tocHtml}</ul>
  </div>` : ''}

  <div style="padding:20pt 32pt">
    <div class="content">${bodyHtml}</div>
    ${appendixHtml ? `<div>${appendixHtml}</div>` : ''}
    <div class="page-footer"><span>Docteur — Export PDF</span><span>${today}</span></div>
  </div>
</body></html>`;
}

export function buildSubjectHtml(subject, neurons, intro, mode = 'basic', truncated = false) {
  const escapedSub = esc(subject);
  const today      = new Date().toLocaleDateString('fr-FR');
  const count      = neurons.length;

  const warnHtml = truncated
    ? `<div class="warn">⚠️ Plus de 20 neurones trouvés — seuls les 20 plus pertinents sont inclus dans cette synthèse.</div>`
    : '';

  const sectionsHtml = neurons.map((n, i) => {
    const srcHtml = n.metadata?.url
      ? `<a href="${esc(String(n.metadata.url))}" style="font-size:9pt">${esc(String(n.metadata.url).slice(0, 60))}…</a>`
      : '';
    return `<div class="section no-break">
      <div class="section-hd">
        <h2 style="margin:0 0 3pt">${i + 1}. ${esc(n.title || 'Sans titre')}</h2>
        <div class="meta" style="margin:0"><span class="badge">${esc(kindLabel(n.kind))}</span>${srcHtml ? `<span>${srcHtml}</span>` : ''}</div>
      </div>
      <div>${mdToHtml(n.content)}</div>
    </div>`;
  }).join('<hr style="margin:18pt 0">');

  const sourceLinks = neurons
    .filter(n => n.metadata?.url)
    .map((n, i) => `<div class="source-item">[${i + 1}] ${esc(n.title || 'Sans titre')} — <a href="${esc(String(n.metadata.url))}">${esc(String(n.metadata.url))}</a></div>`)
    .join('');

  if (mode === 'basic') {
    return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>${escapedSub}</title>
<style>${CSS}</style></head>
<body style="padding:20pt 32pt">
  <h1>${escapedSub}</h1>
  <div class="meta">
    <span>${count} neurone${count > 1 ? 's' : ''} trouvé${count > 1 ? 's' : ''}</span>
    <span>${today}</span>
  </div>
  ${warnHtml}
  <hr>
  ${sectionsHtml}
  ${sourceLinks ? `<div style="margin-top:20pt;padding-top:14pt;border-top:1px solid #e2e8f0">
    <p class="sources-hd">Sources</p>${sourceLinks}
  </div>` : ''}
  <div class="page-footer"><span>Exporté depuis Docteur</span><span>${today}</span></div>
</body></html>`;
  }

  // ── Complete mode ──────────────────────────────────────────────────────────
  const tocHtml = neurons.map((n, i) =>
    `<li class="toc-item"><span class="toc-num">${i + 1}.</span>${esc(n.title || 'Sans titre')}</li>`
  ).join('\n');

  const introHtml = intro
    ? `<div class="intro-box"><div class="intro-label">Introduction</div>${mdToHtml(intro)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>${escapedSub}</title>
<style>${CSS}</style>${MERMAID_SCRIPT}</head>
<body>
  <div class="cover">
    <div class="cover-brand">Docteur</div>
    <div class="cover-title">${escapedSub}</div>
    <div class="cover-sub">Synthèse de ${count} neurone${count > 1 ? 's' : ''}</div>
    <div class="cover-date">Exporté le ${today}</div>
  </div>

  <div class="toc" style="padding:20pt 32pt">
    <p class="toc-kicker">Table des matières</p>
    <ul class="toc-list">${tocHtml}</ul>
  </div>

  <div style="padding:20pt 32pt">
    ${warnHtml}
    ${introHtml}
    ${introHtml ? '<hr style="margin:18pt 0">' : ''}
    ${sectionsHtml}
    ${sourceLinks ? `<div style="margin-top:20pt;padding-top:14pt;border-top:1px solid #e2e8f0">
      <p class="sources-hd">Sources</p>${sourceLinks}
    </div>` : ''}
    <div class="page-footer"><span>Docteur — Synthèse PDF</span><span>${today}</span></div>
  </div>
</body></html>`;
}

// ── PDF generation via Playwright ─────────────────────────────────────────────

export async function generatePdf(html, { mode = 'basic' } = {}) {
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const pg = await browser.newPage();

    // setContent with domcontentloaded — fast; external resources (Mermaid CDN)
    // load asynchronously. Then we wait briefly so Mermaid can render if CDN is reachable.
    await pg.setContent(html, { waitUntil: 'domcontentloaded', timeout: 10_000 });

    if (mode === 'complete') {
      // Give Mermaid up to 3s to render. If CDN is unreachable, diagrams appear
      // as raw code blocks — graceful degradation, never throws.
      await pg.waitForTimeout(3000);
    }

    const isComplete = mode === 'complete';
    const pdfData = await pg.pdf({
      format:              'A4',
      printBackground:     true,
      margin:              { top: '14mm', right: '14mm', bottom: isComplete ? '18mm' : '14mm', left: '14mm' },
      displayHeaderFooter: isComplete,
      headerTemplate:      isComplete
        ? '<div style="font-size:8px;color:#94a3b8;width:100%;text-align:center;font-family:Arial"><span class="title"></span></div>'
        : '<div></div>',
      footerTemplate:      isComplete
        ? '<div style="font-size:8px;color:#94a3b8;width:100%;display:flex;justify-content:space-between;padding:0 14mm;font-family:Arial"><span>Docteur</span><span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'
        : '<div></div>',
    });

    return Buffer.from(pdfData);
  } finally {
    await browser.close();
  }
}
