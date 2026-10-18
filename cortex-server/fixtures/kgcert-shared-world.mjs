// KG-CERT fixture (temporary databases only): one LOGICAL document shared by two
// private notebooks (two technical refs), with aliases, claims, evidence and
// relations seen through each notebook's own ref, a logical-only relation, a
// public source and a private source. Markers let a sweep count leaks.
import assert from 'node:assert/strict';
import { resolveEntityMention } from '../src/lib/kg-resolution.js';
import { assertClaim } from '../src/lib/kg-claims.js';
import { ingestNotebookDocument } from '../src/lib/kg-adapters.js';

export const SHARED_MARKERS = Object.freeze({
  nbA: ['EVNBA', 'ALIASNBA', 'Rapport commun A', 'docA-', 'RELNBA'],
  nbB: ['EVNBB', 'ALIASNBB', 'Rapport SECRETB', 'docB-', 'RELNBB'],
  logical: ['RELLOGICAL'],
  privateSource: ['EVPRIV', 'ALIASPRIV', 'Carnet PRIVSRC'],
});

export function buildSharedWorld(store) {
  const manual = (name, privacy = 'STANDARD') => {
    const egress = privacy === 'PRIVATE' ? 'local_only' : 'cloud_allowed';
    const sourceId = store.upsertSource({ source_type: 'ARTICLE', name, logical_key: `cert:${name}`, privacy, egress_policy: egress }).id;
    const refId = store.upsertSourceRef({ source_id: sourceId, adapter: 'manual', source_ref: `cert:${name}`, privacy, egress_policy: egress }).id;
    return { sourceId, refId };
  };
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
  assert.equal(sharedA.sourceId, sharedB.sourceId, 'one logical source, two technical refs');

  const mention = (label, type, s, extra = {}) => resolveEntityMention(store, { label, type, sourceRefId: s.refId, ...extra }).entityId;
  const acme = mention('Acme', 'ORGANIZATION', pub, { identifiers: [{ scheme: 'domain', value: 'acme.example' }] });
  mention('Acme', 'ORGANIZATION', sharedA, { aliases: ['ALIASNBA'], identifiers: [{ scheme: 'domain', value: 'acme.example' }] });
  mention('Acme', 'ORGANIZATION', sharedB, { aliases: ['ALIASNBB'], identifiers: [{ scheme: 'domain', value: 'acme.example' }] });
  mention('Acme', 'ORGANIZATION', priv, { aliases: ['ALIASPRIV'], identifiers: [{ scheme: 'domain', value: 'acme.example' }] });
  const alice = mention('Alice Martin', 'PERSON', pub);
  const bob = mention('Bob Durand', 'PERSON', pub);
  const orion = mention('Orion', 'PROJECT', pub);
  const ev = (s, excerpt, extra = {}) => ({ sourceId: s.sourceId, sourceRefId: s.refId, excerpt, ...extra });
  const det = (subjectEntityId, predicate, obj, evidence) => assertClaim(store, {
    subjectEntityId, predicate, ...(typeof obj === 'string' ? { objectEntityId: obj } : { value: obj }), extractionMethod: 'DETERMINISTIC', evidence,
  }).claimId;
  const claims = {
    pub: det(acme, 'ceo', alice, [ev(pub, 'Alice Martin dirige Acme'), ev(sharedA, 'EVNBA-1 Alice dirige', { locatorKind: 'CHUNK', chunkId: 'chA1' }), ev(sharedB, 'EVNBB-1 Alice dirige', { locatorKind: 'CHUNK', chunkId: 'chB1' })]),
    nbA: det(acme, 'website', { type: 'url', value: 'https://widget-a.example' }, [ev(sharedA, 'EVNBA-2 produit Widget A', { locatorKind: 'CHUNK', chunkId: 'chA2' })]),
    nbB: det(acme, 'founder', bob, [ev(sharedB, 'EVNBB-2 fondateur Bob', { locatorKind: 'CHUNK', chunkId: 'chB2' })]),
    priv: det(acme, 'headquarters', mention('Lyon', 'LOCATION', pub), [ev(priv, 'EVPRIV-1 siège à Lyon')]),
  };
  const rel = (a, type, b, s, metadata, logicalOnly = false) => store.upsertRelationship({
    source_entity_id: a, target_entity_id: b, relationship_type: type, source_id: s.sourceId, ...(logicalOnly ? {} : { source_ref_id: s.refId }), metadata,
  }).id;
  const relations = {
    nbA: rel(orion, 'RELATED_TO', acme, sharedA, { note: 'RELNBA' }),
    nbB: rel(orion, 'LINKED_TO', acme, sharedB, { note: 'RELNBB' }),
    logical: rel(orion, 'ASSOCIATED_WITH', acme, sharedA, { note: 'RELLOGICAL' }, true),
    pub: rel(alice, 'MEMBER_OF', acme, pub),
  };
  const evidenceId = (prefix) => store.prepare('SELECT evidence_id FROM kg_evidence WHERE content LIKE ?').get(`${prefix}%`).evidence_id;
  return {
    sources: { pub, priv, sharedA, sharedB }, entities: { acme, alice, bob, orion }, claims, relations,
    evidence: { nbA: evidenceId('EVNBA-1'), nbB: evidenceId('EVNBB-1'), priv: evidenceId('EVPRIV-1'), pub: evidenceId('Alice Martin dirige') },
  };
}
