// [Knowledge Graph V1] KG-6 graph view model — pure functions, no DOM, no network.
//
// Deterministic radial layout (no physics loop: nothing can spin or freeze the UI),
// incremental on expansion (already placed nodes never move), bounded render size,
// keyboard navigation by direction, fit / recentre, ARIA descriptions, timeline
// scale. The server already bounds and filters every neighbourhood; these limits
// cap what accumulates in the view through manual expansions.

import type { KgNeighborhood, KgViewEdge, KgViewNode, KgClaimSummary } from '../cortex/client';

export const MAX_RENDERED_NODES = 250;
export const MAX_RENDERED_EDGES = 500;
export const RING = 170;
export const EXPANSION_RADIUS = 150;

/** `nextOffset`: where the next "expand" slice of this node's edges starts (high fan-out paging). */
export interface GraphNode extends KgViewNode { x: number; y: number; expanded: boolean; nextOffset: number }
export interface GraphState { centerId: string; nodes: Map<string, GraphNode>; edges: Map<string, KgViewEdge> }
export interface Transform { x: number; y: number; k: number }
export type Direction = 'up' | 'down' | 'left' | 'right';

const byLabel = (a: { label: string; id: string }, b: { label: string; id: string }) =>
  a.label.localeCompare(b.label, 'fr') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function adjacency(nodes: Map<string, unknown>, edges: Map<string, KgViewEdge>): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const id of nodes.keys()) adj.set(id, []);
  for (const e of edges.values()) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue;
    adj.get(e.source)!.push(e.target);
    adj.get(e.target)!.push(e.source);
  }
  return adj;
}

/** Radial layout around `centerId`: one ring per BFS distance, children ordered by their parent's angle then label. */
export function radialLayout(nodes: Map<string, KgViewNode | GraphNode>, edges: Map<string, KgViewEdge>, centerId: string): Map<string, { x: number; y: number }> {
  const adj = adjacency(nodes, edges);
  const pos = new Map<string, { x: number; y: number; angle: number }>();
  pos.set(centerId, { x: 0, y: 0, angle: 0 });
  let layer = [centerId];
  const seen = new Set(layer);
  for (let depth = 1; layer.length; depth++) {
    const next: { id: string; parentAngle: number }[] = [];
    for (const parent of layer) {
      const kids = (adj.get(parent) ?? []).filter(id => !seen.has(id))
        .map(id => nodes.get(id)!).sort(byLabel);
      for (const k of kids) {
        seen.add(k.id);
        next.push({ id: k.id, parentAngle: pos.get(parent)!.angle });
      }
    }
    next.sort((a, b) => a.parentAngle - b.parentAngle || byLabel(nodes.get(a.id)!, nodes.get(b.id)!));
    next.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, next.length) - Math.PI / 2;
      pos.set(n.id, { x: Math.round(Math.cos(angle) * RING * depth), y: Math.round(Math.sin(angle) * RING * depth), angle });
    });
    layer = next.map(n => n.id);
  }
  // disconnected leftovers (should not happen: every node comes with an edge) go on an outer ring
  const rest = [...nodes.values()].filter(n => !pos.has(n.id)).sort(byLabel);
  const maxDepth = Math.max(1, ...[...pos.values()].map(p => Math.round(Math.hypot(p.x, p.y) / RING)));
  rest.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, rest.length);
    pos.set(n.id, { x: Math.round(Math.cos(angle) * RING * (maxDepth + 1)), y: Math.round(Math.sin(angle) * RING * (maxDepth + 1)), angle });
  });
  return new Map([...pos.entries()].map(([id, p]) => [id, { x: p.x, y: p.y }]));
}

export function createGraph(nb: KgNeighborhood): GraphState {
  const nodes = new Map<string, GraphNode>();
  for (const n of nb.nodes.slice(0, MAX_RENDERED_NODES)) nodes.set(n.id, { ...n, x: 0, y: 0, expanded: n.id === nb.center, nextOffset: n.id === nb.center ? n.shownEdges : 0 });
  const edges = new Map<string, KgViewEdge>();
  for (const e of nb.edges) if (nodes.has(e.source) && nodes.has(e.target) && edges.size < MAX_RENDERED_EDGES) edges.set(e.id, e);
  const pos = radialLayout(nodes, edges, nb.center);
  for (const [id, p] of pos) Object.assign(nodes.get(id)!, p);
  return { centerId: nb.center, nodes, edges };
}

export interface MergeResult { state: GraphState; addedNodes: number; addedEdges: number; refused: 'NODE_LIMIT' | null }

/**
 * Adds a neighbourhood fetched around `anchorId`. Existing nodes keep their
 * place; new ones are fanned out around the anchor, away from the centre.
 * Refuses (nothing added) when the view would exceed MAX_RENDERED_NODES.
 */
export function mergeNeighborhood(state: GraphState, nb: KgNeighborhood, anchorId: string): MergeResult {
  const anchor = state.nodes.get(anchorId);
  const fresh = nb.nodes.filter(n => !state.nodes.has(n.id));
  if (state.nodes.size + fresh.length > MAX_RENDERED_NODES) return { state, addedNodes: 0, addedEdges: 0, refused: 'NODE_LIMIT' };
  const nodes = new Map(state.nodes);
  const edges = new Map(state.edges);
  const base = anchor ? Math.atan2(anchor.y, anchor.x) : 0;
  const away = anchor && (anchor.x !== 0 || anchor.y !== 0);
  const spread = away ? Math.min(Math.PI * 1.5, Math.max(Math.PI / 2, fresh.length * 0.25)) : 2 * Math.PI;
  fresh.sort(byLabel).forEach((n, i) => {
    const t = fresh.length === 1 ? 0.5 : i / (away ? fresh.length - 1 : fresh.length);
    const angle = away ? base - spread / 2 + spread * t : (2 * Math.PI * i) / Math.max(1, fresh.length);
    const r = EXPANSION_RADIUS + (fresh.length > 24 ? (i % 3) * 45 : 0);
    nodes.set(n.id, { ...n, x: Math.round((anchor?.x ?? 0) + Math.cos(angle) * r), y: Math.round((anchor?.y ?? 0) + Math.sin(angle) * r), expanded: false, nextOffset: 0 });
  });
  // refresh counts of nodes already shown (the new answer knows more)
  for (const n of nb.nodes) {
    const cur = nodes.get(n.id);
    if (cur && !fresh.includes(n)) nodes.set(n.id, { ...cur, hiddenEdges: n.id === anchorId ? n.hiddenEdges : cur.hiddenEdges, status: n.status, ambiguous: n.ambiguous });
  }
  const page = nb.nodes.find(n => n.id === anchorId);
  if (nodes.has(anchorId)) nodes.set(anchorId, { ...nodes.get(anchorId)!, expanded: true, nextOffset: (page?.offset ?? 0) + (page?.shownEdges ?? 0) });
  let addedEdges = 0;
  for (const e of nb.edges) {
    if (edges.has(e.id) || !nodes.has(e.source) || !nodes.has(e.target)) continue;
    if (edges.size >= MAX_RENDERED_EDGES) break;
    edges.set(e.id, e);
    addedEdges++;
  }
  return { state: { centerId: state.centerId, nodes, edges }, addedNodes: fresh.length, addedEdges, refused: null };
}

/** Re-layout around another node (positions recomputed, contents unchanged). */
export function recenter(state: GraphState, nodeId: string): GraphState {
  if (!state.nodes.has(nodeId)) return state;
  const pos = radialLayout(state.nodes, state.edges, nodeId);
  const nodes = new Map([...state.nodes.entries()].map(([id, n]) => [id, { ...n, ...(pos.get(id) ?? { x: n.x, y: n.y }) }]));
  return { centerId: nodeId, nodes, edges: state.edges };
}

/** Nearest node in a direction (cone of ±60°), for arrow-key navigation. */
export function nearestInDirection(state: GraphState, fromId: string, dir: Direction): string | null {
  const from = state.nodes.get(fromId);
  if (!from) return null;
  const want = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[dir];
  let best: { id: string; score: number } | null = null;
  for (const n of state.nodes.values()) {
    if (n.id === fromId) continue;
    const dx = n.x - from.x;
    const dy = n.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) continue;
    let delta = Math.abs(Math.atan2(dy, dx) - want);
    if (delta > Math.PI) delta = 2 * Math.PI - delta;
    if (delta > Math.PI / 3) continue;
    const score = dist * (1 + delta);
    if (!best || score < best.score || (score === best.score && n.id < best.id)) best = { id: n.id, score };
  }
  return best?.id ?? null;
}

export function boundsOf(state: GraphState): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = [...state.nodes.values()].map(n => n.x);
  const ys = [...state.nodes.values()].map(n => n.y);
  return { minX: Math.min(0, ...xs), minY: Math.min(0, ...ys), maxX: Math.max(0, ...xs), maxY: Math.max(0, ...ys) };
}

/** Transform that fits the whole view into a width × height viewport (margin included). */
export function fitTransform(state: GraphState, width: number, height: number, margin = 60): Transform {
  const b = boundsOf(state);
  const w = Math.max(1, b.maxX - b.minX + margin * 2);
  const h = Math.max(1, b.maxY - b.minY + margin * 2);
  const k = clampZoom(Math.min(width / w, height / h, 1.4));
  return { k, x: width / 2 - ((b.minX + b.maxX) / 2) * k, y: height / 2 - ((b.minY + b.maxY) / 2) * k };
}

export const clampZoom = (k: number) => Math.min(3, Math.max(0.2, k));

/** Zoom by `factor` keeping the screen point (px, py) fixed. */
export function zoomAt(t: Transform, factor: number, px: number, py: number): Transform {
  const k = clampZoom(t.k * factor);
  const f = k / t.k;
  return { k, x: px - (px - t.x) * f, y: py - (py - t.y) * f };
}

/** Transform that puts a node at the viewport centre. */
export function centerOn(t: Transform, node: { x: number; y: number }, width: number, height: number): Transform {
  return { k: t.k, x: width / 2 - node.x * t.k, y: height / 2 - node.y * t.k };
}

const TYPE_LABEL: Record<string, string> = {
  PERSON: 'personne', ORGANIZATION: 'organisation', LOCATION: 'lieu', PLACE: 'lieu', PRODUCT: 'produit', PROJECT: 'projet',
  DOCUMENT: 'document', CONCEPT: 'concept', EVENT: 'événement', COUNTRY: 'pays', SOFTWARE: 'logiciel', TECHNOLOGY: 'technologie',
};
export const typeLabel = (t: string) => TYPE_LABEL[t] ?? t.toLowerCase();

const STATUS_LABEL: Record<string, string> = {
  SUPPORTED: 'étayé', ASSERTED: 'affirmé (utilisateur)', DISPUTED: 'contesté', HYPOTHESIS: 'hypothèse (modèle)', SUPERSEDED: 'remplacé', INVALIDATED: 'invalidé', RELATION: 'relation',
};
export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s.toLowerCase();

export function describeNode(n: GraphNode): string {
  const parts = [n.label, typeLabel(n.type)];
  if (n.ambiguous) parts.push('entité ambiguë');
  parts.push(`${n.shownEdges} relation${n.shownEdges > 1 ? 's' : ''} affichée${n.shownEdges > 1 ? 's' : ''}`);
  if (n.hiddenEdges > 0) parts.push(`${n.hiddenEdges} non chargée${n.hiddenEdges > 1 ? 's' : ''} (développer)`);
  return parts.join(', ');
}

export function describeEdge(e: KgViewEdge, nodes: Map<string, GraphNode>): string {
  const from = nodes.get(e.source)?.label ?? e.source;
  const to = nodes.get(e.target)?.label ?? e.target;
  const dates = e.validFrom || e.validTo ? `, du ${e.validFrom ?? '…'} au ${e.validTo ?? '…'}` : '';
  return `${from} — ${e.label} — ${to}, ${statusLabel(e.status)}${dates}${e.contradiction ? ', contradiction ouverte' : ''}`;
}

// ── timeline ────────────────────────────────────────────────────────────────

export interface TimelineBar { claimId: string; x: number; width: number; lane: number; label: string; status: string; open: boolean }

const toDay = (d: string) => Date.parse(d.length === 10 ? `${d}T00:00:00Z` : d);

/** Bars for dated claims (open-ended ones run to `now`), packed into non-overlapping lanes. */
export function timelineBars(items: KgClaimSummary[], width: number, now: string, maxLanes = 8): { bars: TimelineBar[]; min: string | null; max: string | null; overflow: number } {
  const dated = items.filter(c => c.validFrom || c.validTo);
  if (!dated.length) return { bars: [], min: null, max: null, overflow: 0 };
  const starts = dated.map(c => c.validFrom ?? c.validTo!);
  const ends = dated.map(c => c.validTo ?? now);
  const min = starts.reduce((a, b) => (b < a ? b : a));
  const max = [...ends, ...starts].reduce((a, b) => (b > a ? b : a));
  const t0 = toDay(min);
  const span = Math.max(1, toDay(max) - t0);
  const laneEnds: number[] = [];
  const bars: TimelineBar[] = [];
  let overflow = 0;
  for (const c of [...dated].sort((a, b) => ((a.validFrom ?? a.validTo!) < (b.validFrom ?? b.validTo!) ? -1 : 1))) {
    const x = ((toDay(c.validFrom ?? c.validTo!) - t0) / span) * width;
    const x2 = ((toDay(c.validTo ?? now) - t0) / span) * width;
    let lane = laneEnds.findIndex(end => end <= x);
    if (lane === -1) {
      if (laneEnds.length >= maxLanes) { overflow++; continue; }
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = x2;
    const obj = c.object.kind === 'entity' ? c.object.label : c.object.kind === 'value' ? String(c.object.value.value) : c.object.text;
    bars.push({ claimId: c.claimId, x, width: Math.max(2, x2 - x), lane, label: `${c.predicate} : ${obj}`, status: c.status, open: !c.validTo });
  }
  return { bars, min, max, overflow };
}
