import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// .xls (legacy binary/BIFF format) is intentionally NOT supported: the xlsx
// (SheetJS) library that could parse it has an unpatched high-severity
// vulnerability (prototype pollution + ReDoS, GHSA-4r6h-8v6p-xvw6 /
// GHSA-5pgg-2g8v-p4x9). Modern .xlsx is parsed via exceljs (maintained, no
// equivalent unpatched issue). Users with a legacy .xls file can re-save it
// as .xlsx in Excel/LibreOffice (File > Save As) — a one-click conversion.
export const ALLOWED_FILE_EXTENSIONS = new Set(['.xlsx', '.csv', '.txt', '.md', '.json']);
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

function sheetToSummary(worksheet) {
  const rows = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const values = row.values.slice(1); // exceljs row.values is 1-indexed, index 0 is always empty
    rows.push(values.map((cell) => {
      if (cell === null || cell === undefined) return '';
      if (typeof cell === 'object' && 'text' in cell) return String(cell.text ?? ''); // rich text
      if (typeof cell === 'object' && 'result' in cell) return String(cell.result ?? ''); // formula result only, never the formula itself
      return String(cell);
    }));
  });
  const columns = (rows[0] ?? []).map((value) => value.trim()).filter(Boolean);
  const sampleRows = rows.slice(1, 6);
  return {
    name: worksheet.name,
    rowCount: rows.length,
    columnCount: columns.length,
    columns,
    sampleRows,
  };
}

export async function readWorkbookSummary(buffer, extension) {
  const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'));
  const workbook = new ExcelJS.Workbook();

  if (extension === '.csv') {
    const { Readable } = await import('node:stream');
    await workbook.csv.read(Readable.from(buffer));
  } else {
    await workbook.xlsx.load(buffer);
  }

  const sheets = [];
  workbook.eachSheet((worksheet) => sheets.push(sheetToSummary(worksheet)));

  return { sheetCount: sheets.length, sheets };
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

  if (extension === '.xlsx' || extension === '.csv') {
    const summary = await readWorkbookSummary(buffer, extension);
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
