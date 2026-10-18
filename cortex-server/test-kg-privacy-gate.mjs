// Knowledge Graph V1 — KG-7 privacy pre-gate (temporary databases only).
//
// The single read stack (POST /search, /retrieve, /view/*) is swept with every
// id of a world that mixes a public source, a private source and two notebooks
// sharing ONE logical document (two technical refs). In each visibility
// context, the bodies must not contain any marker the context may not see:
// private alias / evidence / claim / name, or the other notebook's data. The
// removed KG-2 / KG-3 raw routes answer the same 410 whatever the id; "absent"
// and "not visible" answer the same 404; a private alias searched gives the
// same answer as a nonsense query.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { KnowledgeGraphStore } from './src/lib/kg-store.js';
import { resolveEntityMention } from './src/lib/kg-resolution.js';
import { assertClaim } from './src/lib/kg-claims.js';
import { ingestNotebookDocument } from './src/lib/kg-adapters.js';
import { createKnowledgeGraphRoute, KG_REMOVED_ROUTES } from './src/routes/kg.js';

let store;
let app;
let w;
const leaks = {};

const MARKERS = {
  privateAlias: ['ALIASPRIV', 'NOMPRIVE', 'privid.example'],
  privateEvidence: ['EVPRIV'],
  privateClaim: ['lieupriv.example', 'PROJETPRIV'],
  privateSource: ['PRIVSRC'],
  nbA: ['EVNBA', 'ALIASNBA', 'Rapport commun A', 'NBADOC', 'ENTNBA', 'docA-'],
  nbB: ['EVNBB', 'ALIASNBB', 'SECRETB', 'NBBDOC', 'ENTNBB', 'docB-'],
};
const PRIVATE = [...MARKERS.privateAlias, ...MARKERS.privateEvidence, ...MARKERS.privateClaim, ...MARKERS.privateSource];

const post = async (p, body) => {
  const res = await app.request(p, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return { status: res.status, text: await res.text() };
};

async function buildWorld() {
  const manual = (name, privacy = 'STANDARD') => {
    const egress = privacy === 'PRIVATE' ? 'local_only' : 'cloud_allowed';
    const sourceId = store.upsertSource({ source_type: 'ARTICLE', name, logical_key: `gate:${name}`, privacy, egress_policy: egress }).id;
    const refId = store.upsertSourceRef({ source_id: sourceId, adapter: 'manual', source_ref: `gate:${name}`, privacy, egress_policy: egress }).id;
    return { sourceId, refId };
  };
  // Notebook documents through the real adapter (frozen getDocument() shape); notebooks are local_only
  const nbDoc = (notebookId, documentId, title, hash) => {
    const r = ingestNotebookDocument(store, {
      document: { documentId, notebookId, title, hash, currentVersionId: `${documentId}-v1`, origin: 'upload', status: 'READY', trustLevel: 'USER', retention: 'KEEP' },
      notebook: { notebookId, privacy: true, egress_policy: 'local_only' },
    });
    return { sourceId: r.sourceId, refId: r.sourceRefId };
  };
  const pub = manual('Gazette publique');
  const priv = manual('Carnet PRIVSRC', 'PRIVATE');
  const sharedB = nbDoc('nbB', 'docB-shared', 'Rapport SECRETB', 'hash-shared'); // B first: the logical name is B's title
  const sharedA = nbDoc('nbA', 'docA-shared', 'Rapport commun A', 'hash-shared');
  const onlyA = nbDoc('nbA', 'docA-only', 'Note NBADOC', 'hash-a');
  const onlyB = nbDoc('nbB', 'docB-only', 'Note NBBDOC', 'hash-b');
  assert.equal(sharedA.sourceId, sharedB.sourceId, 'one logical source, two technical refs');

  const mention = (label, type, s, extra = {}) => resolveEntityMention(store, { label, type, sourceRefId: s.refId, ...extra }).entityId;
  const acme = mention('Acme', 'ORGANIZATION', pub, { identifiers: [{ scheme: 'domain', value: 'acme.example' }] });
  assert.equal(mention('Acme', 'ORGANIZATION', priv, { aliases: ['ALIASPRIV'], identifiers: [{ scheme: 'domain', value: 'acme.example' }, { scheme: 'domain', value: 'privid.example' }] }), acme);
  assert.equal(mention('Acme', 'ORGANIZATION', sharedB, { aliases: ['ALIASNBB'], identifiers: [{ scheme: 'domain', value: 'acme.example' }] }), acme);
  assert.equal(mention('Acme', 'ORGANIZATION', sharedA, { aliases: ['ALIASNBA'], identifiers: [{ scheme: 'domain', value: 'acme.example' }] }), acme);
  const alice = mention('Alice Martin', 'PERSON', pub);
  const bob = mention('Bob Durand', 'PERSON', pub);
  // an entity first named by a private source, later known publicly under another alias
  const beta = mention('NOMPRIVE Corp', 'ORGANIZATION', priv);
  store.upsertAlias({ entity_id: beta, alias: 'Beta Corp', source_id: pub.sourceId, source_ref_id: pub.refId, status: 'CONFIRMED' });
  const shadow = mention('PROJETPRIV', 'PROJECT', priv);
  const entNbA = mention('ENTNBA', 'PROJECT', onlyA);
  const entNbB = mention('ENTNBB', 'PROJECT', onlyB);

  const ev = (s, excerpt, extra = {}) => ({ sourceId: s.sourceId, sourceRefId: s.refId, excerpt, ...extra });
  const det = (subjectEntityId, predicate, obj, evidence) => assertClaim(store, {
    subjectEntityId, predicate, ...(typeof obj === 'string' ? { objectEntityId: obj } : { value: obj }), extractionMethod: 'DETERMINISTIC', evidence,
  }).claimId;
  const claims = {
    pub: det(acme, 'ceo', alice, [ev(pub, 'Alice Martin dirige Acme'), ev(priv, 'EVPRIV-1 Alice dirige'), ev(sharedB, 'EVNBB-1 Alice dirige', { chunkId: 'chB1' }),
      ev(sharedA, 'EVNBA-1 Alice dirige', { locatorKind: 'CHUNK', chunkId: 'chA1', page: 2, charStart: 10, charEnd: 40 })]),
    privOnly: det(acme, 'website', { type: 'url', value: 'https://lieupriv.example' }, [ev(priv, 'EVPRIV-2 site lieupriv.example')]),
    nbBOnly: det(acme, 'founder', bob, [ev(sharedB, 'EVNBB-2 fondateur Bob')]),
    nbAOnly: det(acme, 'website', { type: 'url', value: 'https://widget-a.example' }, [ev(sharedA, 'EVNBA-2 produit Widget A', { chunkId: 'chA2' })]),
    shadow: det(shadow, 'status', { type: 'string', value: 'PROJETPRIV actif' }, [ev(priv, 'EVPRIV-3 statut')]),
    entNbA: det(entNbA, 'status', { type: 'string', value: 'ENTNBA actif' }, [ev(onlyA, 'EVNBA-3 statut')]),
    entNbB: det(entNbB, 'status', { type: 'string', value: 'ENTNBB actif' }, [ev(onlyB, 'EVNBB-3 statut')]),
    beta: det(beta, 'ceo', bob, [ev(pub, 'Bob Durand dirige Beta Corp')]),
  };
  store.upsertRelationship({ source_entity_id: shadow, target_entity_id: acme, relationship_type: 'PART_OF', source_id: priv.sourceId });
  store.upsertRelationship({ source_entity_id: entNbB, target_entity_id: acme, relationship_type: 'RELATED_TO', source_id: onlyB.sourceId });
  store.upsertRelationship({ source_entity_id: alice, target_entity_id: bob, relationship_type: 'RELATED_TO', source_id: pub.sourceId });
  const evidenceId = (text) => store.prepare('SELECT evidence_id FROM kg_evidence WHERE content LIKE ?').get(`${text}%`).evidence_id;
  return {
    sources: { pub, priv, sharedA, sharedB, onlyA, onlyB }, entities: { acme, alice, bob, beta, shadow, entNbA, entNbB }, claims,
    evidence: { pub: evidenceId('Alice Martin dirige'), priv1: evidenceId('EVPRIV-1'), nbB1: evidenceId('EVNBB-1'), nbA1: evidenceId('EVNBA-1') },
  };
}

before(async () => {
  store = await KnowledgeGraphStore.createTempStore();
  w = await buildWorld();
  app = createKnowledgeGraphRoute(store);
});
after(() => {
  store?.close();
  if (process.env.KG7_GATE_OUT) fs.writeFileSync(process.env.KG7_GATE_OUT, JSON.stringify(leaks, null, 2));
});

/** Every id of the world through every read route of the single stack → concatenated 200 bodies. */
async function sweep(vis) {
  const all = (sql) => store.prepare(sql).all().map(r => Object.values(r)[0]);
  const calls = [];
  for (const id of all('SELECT entity_id FROM kg_entities')) {
    calls.push(['/view/entity', { entityId: id }], ['/view/neighborhood', { entityId: id, depth: 2 }], ['/view/timeline', { entityId: id }]);
  }
  for (const id of all('SELECT claim_id FROM kg_claims')) calls.push(['/view/claim', { claimId: id }]);
  for (const id of all('SELECT relationship_id FROM kg_relationships')) calls.push(['/view/relation', { relationshipId: id }]);
  for (const id of all('SELECT source_id FROM kg_sources')) calls.push(['/view/source', { sourceId: id }]);
  for (const id of all('SELECT evidence_id FROM kg_evidence')) calls.push(['/view/citation', { evidenceId: id }]);
  const queries = ['Acme', 'Alice Martin', 'Bob Durand', 'Beta Corp', 'acme.example', 'Rapport', 'Widget', 'dirige', 'statut', ...Object.values(MARKERS).flat()];
  for (const q of queries) calls.push(['/search', { query: q }], ['/retrieve', { query: q }]);
  let text = '';
  const statuses = new Map();
  for (const [p, body] of calls) {
    const r = await post(p, { ...body, ...vis, now: '2026-10-08' });
    statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
    // a search answer echoes the query (data the caller sent): only its results and context count
    if (r.status === 200) text += p === '/search' || p === '/retrieve' ? JSON.stringify((({ results, context }) => ({ results, context }))(JSON.parse(r.text))) : r.text;
    else assert.ok([404].includes(r.status), `${p} ${JSON.stringify(body)} → ${r.status} ${r.text}`);
  }
  return { text, calls: calls.length, statuses: Object.fromEntries(statuses) };
}
const count = (text, markers) => markers.reduce((n, m) => n + text.split(m).length - 1, 0);
const idsIn = (text, ids) => ids.filter(id => text.includes(id));

test('removed raw routes: 410 KG_ROUTE_REMOVED, identical for existing and absent ids, any method', async () => {
  const fill = (p, real) => p.replace(':entityId', real ? w.entities.acme : 'ent_nope').replace(':sourceId', real ? w.sources.priv.sourceId : 'src_nope')
    .replace(':claimId', real ? w.claims.privOnly : 'clm_nope').replace(':id', real ? w.evidence.priv1 : 'x_nope').replace(':scheme', 'domain').replace(':value', real ? 'privid.example' : 'none.example');
  let n = 0;
  for (const [p] of KG_REMOVED_ROUTES) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const a = await app.request(fill(p, true), { method });
      const b = await app.request(fill(p, false), { method });
      assert.equal(a.status, 410, `${method} ${p}`);
      const [ta, tb] = [await a.text(), await b.text()];
      assert.equal(ta, tb, `${method} ${p}: same answer whatever the id`);
      assert.ok(!ta.includes('PRIV') && !ta.includes('EV'), 'no data in a 410');
      n++;
    }
  }
  leaks.removedRoutes = { paths: KG_REMOVED_ROUTES.length, requests: n * 2, status410: n * 2 };
});

test('no includePrivate (default / cloud / notebook scope without opt-in): nothing private, no notebook data', async () => {
  const forbidden = [...PRIVATE, ...MARKERS.nbA, ...MARKERS.nbB];
  const hiddenIds = [w.claims.privOnly, w.claims.nbBOnly, w.claims.nbAOnly, w.claims.shadow, w.claims.entNbA, w.claims.entNbB, w.entities.shadow, w.entities.entNbA, w.entities.entNbB, w.evidence.priv1, w.evidence.nbA1, w.evidence.nbB1];
  for (const [name, vis] of [['default', {}], ['cloud', { provider: 'cloud' }], ['nbA-no-optin', { scope: { notebookId: 'nbA' } }]]) {
    const s = await sweep(vis);
    leaks[name] = { requests: s.calls, statuses: s.statuses, markerLeaks: count(s.text, forbidden), idLeaks: idsIn(s.text, hiddenIds).length };
    assert.equal(count(s.text, forbidden), 0, `${name}: ${forbidden.filter(m => s.text.includes(m))}`);
    assert.deepEqual(idsIn(s.text, hiddenIds), [], name);
  }
  // public source / entity visible but private evidence / alias / name
  const claim = JSON.parse((await post('/view/claim', { claimId: w.claims.pub })).text);
  assert.deepEqual(claim.evidence.map(e => e.preview ?? e.excerpt ?? e.content).length, 1, 'only the public evidence');
  assert.equal((await post('/view/source', { sourceId: w.sources.pub.sourceId })).status, 200);
  assert.equal((await post('/view/source', { sourceId: w.sources.priv.sourceId })).status, 404);
  const beta = JSON.parse((await post('/view/entity', { entityId: w.entities.beta })).text);
  assert.equal(beta.entity.label, 'Beta Corp', 'a name first seen in a private source is replaced by an allowed alias');
});

test('includePrivate needs an explicit scope, and never for a cloud provider', async () => {
  for (const [p, body] of [['/search', { query: 'Acme' }], ['/retrieve', { query: 'Acme' }], ['/view/entity', { entityId: w.entities.acme }], ['/view/citation', { evidenceId: w.evidence.priv1 }]]) {
    const missing = await post(p, { ...body, includePrivate: true });
    assert.equal(missing.status, 400, p);
    assert.equal(JSON.parse(missing.text).error, 'KG_SCOPE_REQUIRED');
    const cloud = await post(p, { ...body, includePrivate: true, scope: { all: true }, provider: 'cloud' });
    assert.equal(JSON.parse(cloud.text).error, 'KG_PRIVATE_NOT_FOR_CLOUD', p);
    assert.equal((await post(p, { ...body, includePrivate: true, scope: { everything: true } })).status, 400, 'unknown scope refused');
  }
});

test('notebook scope: right notebook sees its own data only — never the other notebook, even through a shared logical source', async () => {
  for (const [nb, own, other, otherIds] of [
    ['nbA', MARKERS.nbA, MARKERS.nbB, [w.claims.nbBOnly, w.claims.entNbB, w.entities.entNbB, w.evidence.nbB1]],
    ['nbB', MARKERS.nbB, MARKERS.nbA, [w.claims.nbAOnly, w.claims.entNbA, w.entities.entNbA, w.evidence.nbA1]],
  ]) {
    const s = await sweep({ includePrivate: true, scope: { notebookId: nb } });
    const ownSeen = own.filter(m => s.text.includes(m));
    leaks[`${nb}-scoped`] = { requests: s.calls, statuses: s.statuses, crossNotebookMarkers: count(s.text, other), crossNotebookIds: idsIn(s.text, otherIds).length, privateMarkers: count(s.text, PRIVATE), ownMarkersSeen: ownSeen.length };
    assert.equal(count(s.text, other), 0, `${nb}: ${other.filter(m => s.text.includes(m))}`);
    assert.deepEqual(idsIn(s.text, otherIds), [], nb);
    assert.equal(count(s.text, PRIVATE), 0, `${nb}: private (non-notebook) source must stay out of a notebook scope`);
    assert.ok(ownSeen.length >= 4, `${nb} sees its own data (${ownSeen})`);
  }
  const A = { includePrivate: true, scope: { notebookId: 'nbA' } };
  const claim = JSON.parse((await post('/view/claim', { claimId: w.claims.pub, ...A })).text);
  assert.equal(claim.evidence.length, 1, 'only the evidence of THIS notebook');
  assert.equal(claim.evidence[0].source.name, 'Rapport commun A', 'the title known by this notebook, not the logical name');
  assert.equal((await post('/view/claim', { claimId: w.claims.nbBOnly, ...A })).status, 404, 'a claim only supported through the other notebook ref');
  const src = JSON.parse((await post('/view/source', { sourceId: w.sources.sharedA.sourceId, ...A })).text);
  assert.deepEqual(src.refs.map(r => r.ref), ['docA-shared']);
  const cite = JSON.parse((await post('/view/citation', { evidenceId: w.evidence.nbA1, ...A })).text);
  assert.deepEqual(cite.open, { kind: 'notebook_document', notebookId: 'nbA', documentId: 'docA-shared', versionId: 'docA-shared-v1', origin: 'upload', chunkId: 'chA1', page: 2, charStart: 10, charEnd: 40, messageId: null });
  assert.equal((await post('/view/citation', { evidenceId: w.evidence.nbB1, ...A })).status, 404);
  const entity = JSON.parse((await post('/view/entity', { entityId: w.entities.acme, ...A })).text);
  assert.deepEqual(entity.aliases.map(a => a.alias).filter(a => a.startsWith('ALIAS')), ['ALIASNBA']);
});

test('wrong notebook / other sources scope: nothing private', async () => {
  const forbidden = [...PRIVATE, ...MARKERS.nbA, ...MARKERS.nbB];
  for (const [name, vis] of [['nbZ-wrong', { includePrivate: true, scope: { notebookId: 'nbZ' } }], ['sourceIds-public', { includePrivate: true, scope: { sourceIds: [w.sources.pub.sourceId] } }]]) {
    const s = await sweep(vis);
    leaks[name] = { requests: s.calls, statuses: s.statuses, markerLeaks: count(s.text, forbidden) };
    assert.equal(count(s.text, forbidden), 0, `${name}: ${forbidden.filter(m => s.text.includes(m))}`);
  }
});

test('explicit local opt-in on the whole KG sees private data (the gate filters, it does not just hide everything)', async () => {
  const s = await sweep({ includePrivate: true, scope: { all: true } });
  const seen = [...PRIVATE, ...MARKERS.nbA, ...MARKERS.nbB].filter(m => s.text.includes(m));
  leaks.allScoped = { requests: s.calls, statuses: s.statuses, markersSeen: seen.length };
  for (const m of ['EVPRIV', 'ALIASPRIV', 'lieupriv.example', 'EVNBA', 'EVNBB']) assert.ok(s.text.includes(m), m);
});

test('enumeration: absent and not visible answer the same; a private alias searched = a nonsense query', async () => {
  const pairs = [
    ['/view/entity', { entityId: w.entities.shadow }, { entityId: 'ent_absent' }],
    ['/view/neighborhood', { entityId: w.entities.entNbB }, { entityId: 'ent_absent' }],
    ['/view/timeline', { entityId: w.entities.shadow }, { entityId: 'ent_absent' }],
    ['/view/claim', { claimId: w.claims.privOnly }, { claimId: 'clm_absent' }],
    ['/view/source', { sourceId: w.sources.priv.sourceId }, { sourceId: 'src_absent' }],
    ['/view/citation', { evidenceId: w.evidence.priv1 }, { evidenceId: 'evd_absent' }],
  ];
  let checked = 0;
  for (const vis of [{}, { includePrivate: true, scope: { notebookId: 'nbA' } }]) {
    for (const [p, hidden, absent] of pairs) {
      const [a, b] = [await post(p, { ...hidden, ...vis }), await post(p, { ...absent, ...vis })];
      assert.equal(a.status, 404, `${p} hidden`);
      assert.deepEqual([a.status, a.text], [b.status, b.text], p);
      checked++;
    }
  }
  const A = { includePrivate: true, scope: { notebookId: 'nbA' } };
  for (const [q, vis] of [['ALIASPRIV', {}], ['NOMPRIVE', {}], ['privid.example', {}], ['ALIASNBB', A], ['SECRETB', A]]) {
    const r = JSON.parse((await post('/search', { query: q, ...vis })).text);
    const n = JSON.parse((await post('/search', { query: 'zzqx nonsense', ...vis })).text);
    assert.deepEqual(r.results, n.results, `search "${q}" reveals nothing`);
    checked++;
  }
  leaks.enumeration = { checks: checked, differences: 0 };
});
