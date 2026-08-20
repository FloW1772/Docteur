import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ALLOWED_FILE_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv', '.txt', '.md', '.json']);
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

export function getFilesRoot(rootDir) {
  return path.resolve(rootDir, 'data/fichiers');
}

export function getOriginalsDir(rootDir) {
  return path.join(getFilesRoot(rootDir), 'originaux');
}

export function getResultsDir(rootDir) {
  return path.join(getFilesRoot(rootDir), 'resultats');
}

export function ensureFileDirectories(rootDir) {
  fs.mkdirSync(getOriginalsDir(rootDir), { recursive: true });
  fs.mkdirSync(getResultsDir(rootDir), { recursive: true });
}

export function formatFileStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + '_' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('-');
}

export function normalizeUnsafeName(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\\/]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/_+/g, '_')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/g, '');
}

export function sanitizeBaseName(name) {
  const cleaned = normalizeUnsafeName(name).replace(/\.[^.]+$/, '');
  return cleaned || 'fichier';
}

export function sanitizeExtension(ext) {
  const cleaned = String(ext ?? '').trim().toLowerCase();
  return cleaned.startsWith('.') ? cleaned : `.${cleaned}`;
}

export function validateFileName(name) {
  const cleaned = normalizeUnsafeName(name);
  if (!cleaned || cleaned.includes('..') || cleaned.includes('/') || cleaned.includes('\\')) {
    throw new Error('Nom de fichier invalide');
  }
  return cleaned;
}

export function isAllowedFileName(name) {
  const ext = sanitizeExtension(path.extname(String(name ?? '')));
  return ALLOWED_FILE_EXTENSIONS.has(ext);
}

export function buildOriginalStoredName(originalName, id) {
  const validated = validateFileName(originalName);
  const extension = sanitizeExtension(path.extname(validated));
  const baseName = sanitizeBaseName(validated);
  return `${id}_${baseName}${extension}`;
}

export function buildResultStoredName(originalName, competence, id, date = new Date()) {
  const validated = validateFileName(originalName);
  const extension = sanitizeExtension(path.extname(validated));
  const baseName = sanitizeBaseName(validated);
  const competencePart = normalizeUnsafeName(competence).replace(/\s+/g, '_').toLowerCase() || 'traitement';
  return `${baseName}_${competencePart}_${formatFileStamp(date)}_${id}${extension}`;
}

export function mimeForExtension(extension) {
  const ext = sanitizeExtension(extension);
  return {
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.csv': 'text/csv; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  }[ext] ?? 'application/octet-stream';
}

export function checksumBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function readPreviewText(buffer) {
  return buffer.toString('utf8');
}

export async function readWorkbookSummary(buffer) {
  const xlsxImport = await import('xlsx');
  const XLSX = xlsxImport.default ?? xlsxImport;
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: false, cellHTML: false, sheetStubs: false });

  return {
    sheetCount: workbook.SheetNames.length,
    sheets: workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
      const columns = (rows[0] ?? []).map((value) => String(value ?? '').trim()).filter(Boolean);
      const sampleRows = rows.slice(1, 6).map((row) => row.map((value) => String(value ?? '')));
      return {
        name: sheetName,
        rowCount: rows.length,
        columnCount: columns.length,
        columns,
        sampleRows,
      };
    }),
  };
}

export async function parseOriginalFile(buffer, fileName) {
  const extension = sanitizeExtension(path.extname(fileName));
  if (!ALLOWED_FILE_EXTENSIONS.has(extension)) {
    throw new Error(`Format non supporté : ${extension || 'inconnu'}`);
  }

  if (extension === '.json') {
    const text = readPreviewText(buffer);
    JSON.parse(text);
    return { kind: 'json', text, mimeType: mimeForExtension(extension) };
  }

  if (extension === '.xlsx' || extension === '.xls' || extension === '.csv') {
    const summary = await readWorkbookSummary(buffer);
    return { kind: 'spreadsheet', summary, mimeType: mimeForExtension(extension) };
  }

  const text = readPreviewText(buffer);
  return { kind: 'text', text, mimeType: mimeForExtension(extension) };
}

export function buildMarkdownPreview(original, parsed) {
  const lines = [
    `# ${original.original_name}`,
    '',
    `- Format: ${original.extension}`,
    `- Taille: ${original.size_bytes} octets`,
    `- Traitements: ${original.treatments_count ?? 0}`,
    `- Vérification: ${parsed.kind}`,
    '',
  ];

  if (parsed.kind === 'spreadsheet') {
    lines.push(`## Feuilles (${parsed.summary.sheetCount})`);
    for (const sheet of parsed.summary.sheets) {
      lines.push(`### ${sheet.name}`);
      lines.push(`- Lignes: ${sheet.rowCount}`);
      lines.push(`- Colonnes: ${sheet.columnCount}`);
      if (sheet.columns.length > 0) {
        lines.push(`- En-têtes: ${sheet.columns.join(' | ')}`);
      }
      if (sheet.sampleRows.length > 0) {
        lines.push('');
        if (sheet.columns.length > 0) {
          lines.push(`| ${sheet.columns.join(' | ')} |`);
          lines.push(`| ${sheet.columns.map(() => '---').join(' | ')} |`);
        }
        for (const row of sheet.sampleRows) {
          lines.push(`| ${row.join(' | ')} |`);
        }
      }
      lines.push('');
    }
    return `${lines.join('\n').trim()}\n`;
  }

  lines.push('```');
  lines.push(String(parsed.text ?? '').trim());
  lines.push('```');
  return `${lines.join('\n').trim()}\n`;
}
