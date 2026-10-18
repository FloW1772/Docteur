// KG-6 synthetic graph (test fixture, temporary databases only): small cluster with
// a dated succession, a contradiction, an ambiguous entity, private sources, a
// cycle, a high fan-out hub, a 1 200-node network and a dense timeline.
import { assertClaim } from '../src/lib/kg-claims.js';
import { resolveEntityMention } from '../src/lib/kg-resolution.js';

export async function buildGraphWorld(store, { networkSize = 1200, hubSpokes = 800, timelineClaims = 150 } = {}) {
  const src = (name, privacy = 'STANDARD') => {
    const egress = privacy === 'PRIVATE' ? 'local_only' : 'cloud_allowed';
    const sourceId = store.upsertSource({ source_type: 'ARTICLE', name, logical_key: `kg6:${name}`, privacy, egress_policy: egress }).id;
    const refId = store.upsertSourceRef({ source_id: sourceId, adapter: 'manual', source_ref: `kg6:${name}`, privacy, egress_policy: egress }).id;
    return { sourceId, refId, name };
  };
  const pub = src('Journal économique');
  const pub2 = src('Registre des sociétés');
  const priv = src('Carnet confidentiel', 'PRIVATE');
  const mention = (label, type, s = pub, extra = {}) => resolveEntityMention(store, { label, type, sourceRefId: s.refId, ...extra }).entityId;
  const ev = (s, excerpt, extra = {}) => ({ sourceId: s.sourceId, sourceRefId: s.refId, excerpt, ...extra });
  const det = (subjectEntityId, predicate, obj, evidence, extra = {}) => assertClaim(store, {
    subjectEntityId, predicate, ...(typeof obj === 'string' ? { objectEntityId: obj } : { value: obj }), extractionMethod: 'DETERMINISTIC', evidence, ...extra,
  }).claimId;

  // small cluster
  const acme = mention('Acme Industries', 'ORGANIZATION', pub, { identifiers: [{ scheme: 'domain', value: 'acme.example' }] });
  resolveEntityMention(store, { label: 'Acme Industries', type: 'ORGANIZATION', aliases: ['Code Noir'], identifiers: [{ scheme: 'domain', value: 'acme.example' }], sourceRefId: priv.refId });
  const alice = mention('Alice Martin', 'PERSON');
  const bob = mention('Bob Durand', 'PERSON');
  const widget = mention('Widget X', 'PRODUCT');
  const nantes = mention('Nantes', 'LOCATION');
  const claims = {};
  claims.aliceCeo = det(acme, 'ceo', alice, [ev(pub, 'Alice Martin dirige Acme de 2010 à 2015', { locatorKind: 'PAGE', page: 3 })], { validFrom: '2010-01-01', validTo: '2015-07-01' });
  claims.bobCeo = det(acme, 'ceo', bob, [ev(pub2, 'Bob Durand dirige Acme depuis juillet 2015'), ev(priv, 'Note interne : Bob Durand, PDG')], { validFrom: '2015-07-01' });
  claims.hq = det(acme, 'headquarters', nantes, [ev(pub2, 'Siège social : Nantes')]);
  claims.price = det(widget, 'price', { type: 'number', value: 99, unit: 'EUR' }, [ev(pub, 'Widget X : 99 €')]);
  const widgetMaker = store.upsertRelationship({ source_entity_id: widget, target_entity_id: acme, relationship_type: 'CREATED_BY', source_id: pub.sourceId }).id;

  // contradiction (undated, single-valued)
  const globex = mention('Globex', 'ORGANIZATION', pub2, { identifiers: [{ scheme: 'domain', value: 'globex.example' }] });
  const chloe = mention('Chloé Petit', 'PERSON', pub2);
  const david = mention('David Roux', 'PERSON', pub);
  claims.chloeCeo = det(globex, 'ceo', chloe, [ev(pub2, 'Chloé Petit est directrice générale de Globex')]);
  claims.davidCeo = det(globex, 'ceo', david, [ev(pub, 'David Roux est directeur général de Globex')]);
  store.upsertRelationship({ source_entity_id: globex, target_entity_id: acme, relationship_type: 'RELATED_TO', source_id: pub.sourceId });

  // ambiguity
  const appleInc = mention('Apple', 'ORGANIZATION', pub, { identifiers: [{ scheme: 'domain', value: 'apple.example' }] });
  const appleRec = mention('Apple', 'ORGANIZATION', pub2, { identifiers: [{ scheme: 'domain', value: 'applerecords.example' }] });
  const appleAmb = resolveEntityMention(store, { label: 'Apple', type: 'ORGANIZATION', sourceRefId: src('Forum').refId }).entityId;

  // private-only entity + private claim on a public entity
  const shadow = mention('Projet Ombre', 'PROJECT', priv);
  claims.shadow = det(shadow, 'status', { type: 'string', value: 'secret' }, [ev(priv, 'Projet Ombre : statut secret')]);
  store.upsertRelationship({ source_entity_id: shadow, target_entity_id: acme, relationship_type: 'PART_OF', source_id: priv.sourceId });

  // cycle
  const [ca, cb, cc] = ['Cycle A', 'Cycle B', 'Cycle C'].map(n => store.upsertEntity({ entity_type: 'CONCEPT', name: n }).id);
  for (const [x, y] of [[ca, cb], [cb, cc], [cc, ca]]) store.upsertRelationship({ source_entity_id: x, target_entity_id: y, relationship_type: 'RELATED_TO', source_id: pub.sourceId });

  // high fan-out hub + large network (bulk, one transaction each)
  const hub = store.upsertEntity({ entity_type: 'ORGANIZATION', name: 'Hub Central' }).id;
  store.transaction(() => {
    for (let i = 0; i < hubSpokes; i++) {
      const s = store.upsertEntity({ entity_type: 'CONCEPT', name: `Rayon ${i}` }).id;
      store.upsertRelationship({ source_entity_id: hub, target_entity_id: s, relationship_type: 'RELATED_TO', source_id: pub.sourceId });
    }
  });
  const network = [];
  store.transaction(() => {
    for (let i = 0; i < networkSize; i++) network.push(store.upsertEntity({ entity_type: i % 3 === 0 ? 'PERSON' : 'CONCEPT', name: `Nœud ${i}` }).id);
    for (let i = 0; i < networkSize; i++) {
      store.upsertRelationship({ source_entity_id: network[i], target_entity_id: network[(i + 1) % networkSize], relationship_type: 'RELATED_TO', source_id: pub.sourceId });
      store.upsertRelationship({ source_entity_id: network[i], target_entity_id: network[(i * 7 + 3) % networkSize], relationship_type: 'LINKED_TO', source_id: pub2.sourceId });
    }
  });

  // dense timeline: one project, many dated statuses (consecutive, never overlapping)
  const chronos = mention('Projet Chronos', 'PROJECT', pub);
  const phases = ['étude', 'prototype', 'pilote', 'production', 'maintenance'];
  for (let i = 0; i < timelineClaims; i++) {
    const y = 1900 + i;
    det(chronos, 'status', { type: 'string', value: `${phases[i % 5]} ${i}` }, [ev(pub, `Chronos ${y} : ${phases[i % 5]} ${i}`)], { validFrom: `${y}-01-01`, validTo: `${y + 1}-01-01` });
  }
  det(chronos, 'status', { type: 'string', value: 'archivé' }, [ev(pub2, 'Chronos archivé')], { validFrom: `${1900 + timelineClaims}-01-01` });

  return {
    sources: { pub, pub2, priv },
    entities: { acme, alice, bob, widget, nantes, globex, chloe, david, appleInc, appleRec, appleAmb, shadow, ca, cb, cc, hub, chronos, network0: network[0] },
    claims, relations: { widgetMaker },
    network,
  };
}
