import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  parseOriginalFile, readWorkbookSummary, isAllowedFileName, ALLOWED_FILE_EXTENSIONS,
} from './src/lib/files.js';

async function buildXlsxFixture() {
  const wb = new ExcelJS.Workbook();
  const ws1 = wb.addWorksheet('Data');
  ws1.addRow(['name', 'age', 'joined']);
  ws1.addRow(['Alice', 30, new Date('2024-01-01')]);
  ws1.addRow(['Bob', 25, new Date('2024-02-01')]);
  const ws2 = wb.addWorksheet('Notes');
  ws2.addRow(['comment']);
  ws2.addRow(['hello world']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('.xls is no longer in the allowed extension set (unpatched xlsx/SheetJS vuln removed)', () => {
  assert.equal(ALLOWED_FILE_EXTENSIONS.has('.xls'), false);
  assert.equal(ALLOWED_FILE_EXTENSIONS.has('.xlsx'), true);
  assert.equal(isAllowedFileName('report.xls'), false);
  assert.equal(isAllowedFileName('report.xlsx'), true);
});

test('parseOriginalFile: rejects .xls with a clear error instead of parsing it', async () => {
  await assert.rejects(
    parseOriginalFile(Buffer.from('anything'), 'legacy.xls'),
    /non supporté/i,
  );
});

test('readWorkbookSummary: parses a small valid .xlsx fixture — multiple sheets, text/number/date cells', async () => {
  const buffer = await buildXlsxFixture();
  const summary = await readWorkbookSummary(buffer, '.xlsx');
  assert.equal(summary.sheetCount, 2);
  const data = summary.sheets.find((s) => s.name === 'Data');
  assert.ok(data);
  assert.deepEqual(data.columns, ['name', 'age', 'joined']);
  assert.equal(data.rowCount, 3); // header + 2 rows
  assert.equal(data.sampleRows[0][0], 'Alice');
  assert.equal(data.sampleRows[0][1], '30');
});

test('parseOriginalFile: end-to-end via the real route path for a valid .xlsx buffer', async () => {
  const buffer = await buildXlsxFixture();
  const parsed = await parseOriginalFile(buffer, 'small.xlsx');
  assert.equal(parsed.kind, 'spreadsheet');
  assert.equal(parsed.summary.sheetCount, 2);
});

test('parseOriginalFile: an invalid/corrupted .xlsx buffer throws cleanly, never crashes the process', async () => {
  await assert.rejects(parseOriginalFile(Buffer.from('not a real xlsx file at all'), 'corrupt.xlsx'));
});

test('parseOriginalFile: a CSV buffer parses via exceljs csv reader, not xlsx.load', async () => {
  const csv = 'name,age\nAlice,30\nBob,25\n';
  const parsed = await parseOriginalFile(Buffer.from(csv), 'people.csv');
  assert.equal(parsed.kind, 'spreadsheet');
  assert.equal(parsed.summary.sheetCount, 1);
  assert.deepEqual(parsed.summary.sheets[0].columns, ['name', 'age']);
});

test('parseOriginalFile: rejects a file whose real extension is unsupported, even with a spoofed-looking name', async () => {
  await assert.rejects(parseOriginalFile(Buffer.from('x'), 'malicious.exe'), /non supporté/i);
});
