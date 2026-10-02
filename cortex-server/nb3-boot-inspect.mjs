// NB-3 helper — inspects a Notebook SQLite + LanceDB pair (read-only) for the
// server restart proof of SESSION_ONLY retention. Usage:
//   node nb3-boot-inspect.mjs <sqlitePath> <lancePath> <documentId>...
import Database from 'better-sqlite3';
import { connect } from '@lancedb/lancedb';

const [sqlitePath, lancePath, ...ids] = process.argv.slice(2);
const db = new Database(sqlitePath, { readonly: true });
const out = {};
const lance = await connect(lancePath);
let table = null;
try { table = await lance.openTable('notebook_chunks'); } catch { /* table absent = 0 vectors */ }
for (const id of ids) {
  const chunkIds = db.prepare('SELECT chunk_id FROM nb_chunks WHERE document_id = ?').all(id).map(r => r.chunk_id);
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  out[id] = {
    document: n('SELECT COUNT(*) n FROM nb_documents WHERE document_id = ?', id),
    versions: n('SELECT COUNT(*) n FROM nb_document_versions WHERE document_id = ?', id),
    chunks: chunkIds.length,
    fts: n('SELECT COUNT(*) n FROM nb_chunks_fts WHERE document_id = ?', id),
    embeddingMeta: n('SELECT COUNT(*) n FROM nb_chunk_embeddings WHERE chunk_id LIKE ?', `${id}%`),
    vectors: table ? (await table.query().where(`source_id = '${id}'`).toArray()).length : 0,
    notebookSourceRows: n('SELECT COUNT(*) n FROM notebook_sources WHERE source_id = ?', id),
  };
}
console.log(JSON.stringify(out));
