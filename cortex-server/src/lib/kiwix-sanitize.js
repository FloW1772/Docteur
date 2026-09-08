import { JSDOM } from 'jsdom';

const ALLOWED_TAGS = new Set([
  'A', 'P', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'BR', 'HR',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'THEAD',
  'TBODY', 'TR', 'TD', 'TH', 'IMG', 'BLOCKQUOTE', 'CODE', 'PRE', 'SUP',
  'SUB', 'SMALL', 'FIGURE', 'FIGCAPTION', 'CAPTION', 'DL', 'DT', 'DD',
]);

// Nettoie le HTML d'un article ZIM pour un rendu à l'intérieur de Docteur :
// - retire scripts/styles/liens externes dangereux
// - réécrit les liens internes ZIM (../A/Article) en routes internes navigables
// - réécrit les images pour passer par le proxy cortex-server (jamais kiwix-serve direct)
export function sanitizeZimHtml(html, bookName) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  doc.querySelectorAll('script, style, link[rel="stylesheet"], noscript, iframe').forEach(el => el.remove());

  // Liens internes ZIM ressemblent à ../A/Some_Article ou A/Some_Article — on les
  // transforme en zim://<book>/<path> pour que le frontend les intercepte et
  // charge l'article correspondant sans navigation de page.
  doc.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href) || href.startsWith('mailto:')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      return;
    }
    if (href.startsWith('#')) return;
    const normalized = href.replace(/^(\.\.\/)+/, '').replace(/^\//, '');
    a.setAttribute('href', `zim://${bookName}/${normalized}`);
    a.setAttribute('data-zim-link', normalized);
  });

  doc.querySelectorAll('img[src]').forEach(img => {
    const src = img.getAttribute('src') ?? '';
    if (/^data:/i.test(src)) return;
    const normalized = src.replace(/^(\.\.\/)+/, '').replace(/^\//, '');
    img.setAttribute('src', `/api/kiwix/raw/${encodeURIComponent(bookName)}/${normalized}`);
    img.removeAttribute('srcset');
  });

  // Retire les attributs on* (onerror, onclick…) et style inline potentiellement gênants
  doc.querySelectorAll('*').forEach(el => {
    [...el.attributes].forEach(attr => {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    });
  });

  const bodyEl = doc.querySelector('#mw-content-text') || doc.querySelector('article') || doc.body;
  const cleanedHtml = bodyEl ? bodyEl.innerHTML : doc.body.innerHTML;
  const title = doc.querySelector('title')?.textContent?.trim() || doc.querySelector('h1')?.textContent?.trim() || '';
  const text = (bodyEl?.textContent ?? '').replace(/\s+/g, ' ').trim();

  return { html: cleanedHtml, title, text };
}
