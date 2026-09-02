import { Hono }    from 'hono';
import { PDFParse } from 'pdf-parse';

const MAX_PDF_SIZE  = 10 * 1024 * 1024; // 10 MB
const MIN_TEXT_CHARS_PER_PAGE = 40;      // below this → scanned/image PDF

// ── Text cleaning ─────────────────────────────────────────────────────────────

function cleanPdfText(raw) {
  return raw
    .replaceAll('\r\n', '\n')
    .replaceAll('\r',   '\n')
    // Fix broken hyphenation: "pro-\nfesseur" → "professeur"
    .replace(/(\w)-\n(\w)/g, '$1$2')
    // Remove lines that are just a page number (isolated digit(s))
    .replace(/^\s*\d{1,4}\s*$/gm, '')
    // Collapse 3+ blank lines into 2
    .replace(/\n{3,}/g, '\n\n')
    // Trim trailing spaces on each line
    .split('\n').map(l => l.trimEnd()).join('\n')
    .trim();
}

// ── Title heuristic ───────────────────────────────────────────────────────────
// Try to find a candidate title (likely the person's name) in the first few lines.

function guessTitle(text, fallback) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 6)) {
    // Name-like line: 2–5 words, mostly letters, no punctuation beyond spaces/hyphens
    if (/^[A-ZÀ-ÿa-z][A-Za-zÀ-ÿ '-]{2,40}$/.test(line) && line.split(/\s+/).length <= 5) {
      return line;
    }
  }
  return fallback;
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function createCvImportRoute({ logger } = {}) {
  const route = new Hono();

  // POST /api/cv/import-pdf
  // Accepts multipart/form-data with:
  //   file     — the PDF file (required)
  //   filename — original filename hint (optional, used for title fallback)
  //
  // Returns { title, text, pages_count }
  // Privacy: extracted text is NEVER logged. No temp files written.
  route.post('/cv/import-pdf', async (c) => {
    // ── Parse multipart ───────────────────────────────────────────────────────
    let formData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ error: 'Formulaire invalide' }, 400);
    }

    const file = formData.get('file');
    if (!file || typeof file === 'string') {
      return c.json({ error: 'Champ "file" manquant' }, 400);
    }

    // ── Type check ────────────────────────────────────────────────────────────
    const mime = (file.type ?? '').split(';')[0].trim().toLowerCase();
    if (mime !== 'application/pdf' && mime !== 'application/x-pdf') {
      return c.json({ error: 'Le fichier doit être un PDF (.pdf)' }, 415);
    }

    // ── Size check ────────────────────────────────────────────────────────────
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > MAX_PDF_SIZE) {
      return c.json({ error: `Fichier trop volumineux (max ${MAX_PDF_SIZE / 1024 / 1024} Mo)` }, 413);
    }

    // ── Magic bytes — must start with %PDF ────────────────────────────────────
    if (buf.slice(0, 4).toString('ascii') !== '%PDF') {
      return c.json({ error: 'Le fichier ne semble pas être un PDF valide' }, 415);
    }

    // ── Extract text (in-memory, no temp files) ───────────────────────────────
    let textResult;
    let pageCount = 1;
    try {
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      await parser.load();
      textResult = await parser.getText();
      pageCount  = textResult.total ?? 1;
      await parser.destroy();
    } catch (err) {
      const msg = String(err?.message ?? '').toLowerCase();
      if (msg.includes('password') || msg.includes('encrypted')) {
        return c.json({ error: 'Ce PDF est protégé par mot de passe. Retire la protection puis réessaie.' }, 422);
      }
      if (logger) logger.warn({ error: err.message, size: buf.length }, 'CV_PDF_PARSE_FAIL');
      return c.json({ error: `Impossible de lire ce PDF : ${err.message ?? 'erreur inconnue'}` }, 422);
    }

    // ── Scanned / image PDF detection ─────────────────────────────────────────
    // Built from textResult.pages, NOT textResult.text — pdf-parse v2's
    // concatenated .text field injects a literal "-- N of M --" separator
    // between every page, which would otherwise end up baked into the CV
    // content itself (and from there into every analyze/rewrite/ATS prompt).
    const rawText  = Array.isArray(textResult.pages)
      ? textResult.pages.map(p => p.text ?? '').join('\n\n')
      : (textResult.text ?? '');
    const minChars = MIN_TEXT_CHARS_PER_PAGE * pageCount;

    if (rawText.trim().length < minChars) {
      return c.json({
        error: 'Ce PDF ne contient pas de texte extractible (PDF scanné ou créé depuis une image). ' +
               'Copie-colle le texte de ton CV directement dans un neurone.',
      }, 422);
    }

    // ── Clean text ────────────────────────────────────────────────────────────
    const cleanedText = cleanPdfText(rawText);

    // ── Title heuristic ───────────────────────────────────────────────────────
    const filenameVal = formData.get('filename');
    const rawFilename = typeof filenameVal === 'string'
      ? filenameVal.replace(/\.pdf$/i, '').trim()
      : 'CV importé';
    const title = guessTitle(cleanedText, rawFilename || 'CV importé');

    // Log only metadata, never the extracted text
    if (logger) logger.info({ size: buf.length, pages: pageCount, chars: cleanedText.length }, 'CV_PDF_IMPORT');

    return c.json({ title, text: cleanedText, pages_count: pageCount });
  });

  return route;
}
