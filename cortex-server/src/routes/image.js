import { Hono } from 'hono';
import { validateImageId, getImagePath, saveImageBuffer, downloadImageFromUrl, IMAGE_DIR, ALLOWED_MIME, MAX_SIZE, deleteImageFile } from '../lib/image.js';
import fs from 'node:fs';

export function createImageRoute({ logger } = {}) {
  const route = new Hono();

  // POST /api/image — upload (multipart) or download from URL ({ url })
  route.post('/image', async (c) => {
    const contentType = c.req.header('content-type') ?? '';

    if (contentType.includes('multipart/form-data')) {
      // Multipart upload
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

      const mimeType = file.type?.split(';')[0].trim().toLowerCase() ?? '';
      if (!ALLOWED_MIME.includes(mimeType)) {
        return c.json({ error: `Type non supporté: ${mimeType}` }, 415);
      }

      const buf = Buffer.from(await file.arrayBuffer());
      if (buf.length > MAX_SIZE) {
        return c.json({ error: 'Image trop grande (max 5 Mo)' }, 413);
      }

      try {
        const id = saveImageBuffer(buf, mimeType);
        if (logger) logger.info({ id, size: buf.length }, 'IMAGE_UPLOAD');
        return c.json({ id });
      } catch (err) {
        return c.json({ error: err.message }, 500);
      }

    } else {
      // JSON body with { url }
      const body = await c.req.json().catch(() => null);
      const url  = typeof body?.url === 'string' ? body.url.trim() : '';
      if (!url) return c.json({ error: 'Champ "url" manquant' }, 400);

      try {
        const id = await downloadImageFromUrl(url, { signal: AbortSignal.timeout(30_000) });
        if (logger) logger.info({ id, url }, 'IMAGE_FROM_URL');
        return c.json({ id });
      } catch (err) {
        const status = err.message?.includes('SSRF') || err.message?.includes('non autorisé') ? 403 : 500;
        return c.json({ error: err.message }, status);
      }
    }
  });

  // GET /api/image/:id — serve image file
  route.get('/image/:id', async (c) => {
    const id = c.req.param('id');
    if (!validateImageId(id)) return c.json({ error: 'ID invalide' }, 400);

    let filePath;
    try { filePath = getImagePath(id); } catch { return c.json({ error: 'ID invalide' }, 400); }

    if (!fs.existsSync(filePath)) return c.json({ error: 'Image introuvable' }, 404);

    const ext      = id.split('.').pop().toLowerCase();
    const mimeMap  = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
    const mime     = mimeMap[ext] ?? 'application/octet-stream';
    const buf      = fs.readFileSync(filePath);

    return new Response(buf, {
      headers: {
        'Content-Type':  mime,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': String(buf.length),
      },
    });
  });

  // GET /api/image/stats — total count + size
  route.get('/image/stats', (c) => {
    try {
      let count = 0;
      let totalBytes = 0;
      if (fs.existsSync(IMAGE_DIR)) {
        for (const f of fs.readdirSync(IMAGE_DIR)) {
          try {
            const stat = fs.statSync(`${IMAGE_DIR}/${f}`);
            if (stat.isFile()) { count++; totalBytes += stat.size; }
          } catch { /* skip */ }
        }
      }
      return c.json({ count, totalBytes, totalMb: Math.round(totalBytes / 1024 / 1024 * 10) / 10 });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // DELETE /api/image/:id
  route.delete('/image/:id', (c) => {
    const id = c.req.param('id');
    if (!validateImageId(id)) return c.json({ error: 'ID invalide' }, 400);
    try {
      deleteImageFile(id, logger);
      if (logger) logger.info({ id }, 'IMAGE_DELETE');
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
