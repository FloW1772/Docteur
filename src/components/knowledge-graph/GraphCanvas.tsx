// [Knowledge Graph V1] KG-6 — SVG graph canvas. Renders only what the view model holds
// (bounded), lays nothing out itself (pure model), and is fully keyboard-operable:
// arrows move between nodes, Enter/Space selects, E expands, C recentres, + / − zoom,
// 0 fits, Shift + arrows pan. Pointer: drag the background to pan, wheel to zoom.
import { useCallback, useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import type { GraphNode, GraphState, Transform, Direction } from '../../lib/kg/graph-model';
import { describeEdge, describeNode, nearestInDirection, zoomAt } from '../../lib/kg/graph-model';
import type { KgViewEdge } from '../../lib/cortex/client';

export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | null;

interface Props {
  graph: GraphState;
  transform: Transform;
  onTransform: (t: Transform) => void;
  selection: Selection;
  focusedId: string | null;
  onFocusNode: (id: string) => void;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onExpand: (id: string) => void;
  onRecenter: (id: string) => void;
  onFit: () => void;
  onSize?: (w: number, h: number) => void;
}

const TYPE_COLOR: Record<string, string> = {
  PERSON: '#8bdde7', ORGANIZATION: '#ffb547', LOCATION: '#3dffaa', PLACE: '#3dffaa', PRODUCT: '#ff8fd8', PROJECT: '#c9a6ff',
  DOCUMENT: '#e8d9ff', CONCEPT: '#9daebb', EVENT: '#ffd27a', COUNTRY: '#3dffaa',
};
const ARROWS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const PAN_STEP = 60;

function edgePath(e: KgViewEdge, a: GraphNode, b: GraphNode, offset: number): { d: string; mx: number; my: number } {
  const mx0 = (a.x + b.x) / 2;
  const my0 = (a.y + b.y) / 2;
  if (offset === 0) return { d: `M${a.x},${a.y} L${b.x},${b.y}`, mx: mx0, my: my0 };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const cx = mx0 - (dy / len) * offset;
  const cy = my0 + (dx / len) * offset;
  return { d: `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`, mx: (mx0 + cx) / 2, my: (my0 + cy) / 2 };
}

export default function GraphCanvas({ graph, transform, onTransform, selection, focusedId, onFocusNode, onSelectNode, onSelectEdge, onExpand, onRecenter, onFit, onSize }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const drag = useRef<{ x: number; y: number; t: Transform; id: number } | null>(null);
  const tRef = useRef(transform);
  tRef.current = transform;

  // wheel zoom (non-passive so the page does not scroll under the graph)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      onTransform(zoomAt(tRef.current, ev.deltaY < 0 ? 1.15 : 1 / 1.15, ev.clientX - r.left, ev.clientY - r.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onTransform]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !onSize || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(entries => { const r = entries[0].contentRect; onSize(r.width, r.height); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [onSize]);

  const focusNode = useCallback((id: string) => {
    onFocusNode(id);
    requestAnimationFrame(() => nodeRefs.current.get(id)?.focus());
  }, [onFocusNode]);

  const size = () => { const r = wrapRef.current?.getBoundingClientRect(); return { w: r?.width ?? 800, h: r?.height ?? 600 }; };

  const onNodeKey = (ev: KeyboardEvent<SVGGElement>, id: string) => {
    const dir = ARROWS[ev.key];
    if (dir && ev.shiftKey) {
      ev.preventDefault();
      const d = { up: [0, PAN_STEP], down: [0, -PAN_STEP], left: [PAN_STEP, 0], right: [-PAN_STEP, 0] }[dir];
      onTransform({ ...transform, x: transform.x + d[0], y: transform.y + d[1] });
      return;
    }
    if (dir) {
      ev.preventDefault();
      const next = nearestInDirection(graph, id, dir);
      if (next) focusNode(next);
      return;
    }
    const { w, h } = size();
    switch (ev.key) {
      case 'Enter':
      case ' ': ev.preventDefault(); onSelectNode(id); break;
      case 'e': case 'E': ev.preventDefault(); onExpand(id); break;
      case 'c': case 'C': ev.preventDefault(); onRecenter(id); break;
      case '+': case '=': ev.preventDefault(); onTransform(zoomAt(transform, 1.2, w / 2, h / 2)); break;
      case '-': case '_': ev.preventDefault(); onTransform(zoomAt(transform, 1 / 1.2, w / 2, h / 2)); break;
      case '0': ev.preventDefault(); onFit(); break;
      default: break;
    }
  };

  const onPointerDown = (ev: PointerEvent<SVGRectElement>) => {
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    drag.current = { x: ev.clientX, y: ev.clientY, t: transform, id: ev.pointerId };
  };
  const onPointerMove = (ev: PointerEvent<SVGRectElement>) => {
    const d = drag.current;
    if (!d || d.id !== ev.pointerId) return;
    onTransform({ ...d.t, x: d.t.x + ev.clientX - d.x, y: d.t.y + ev.clientY - d.y });
  };
  const onPointerUp = (ev: PointerEvent<SVGRectElement>) => {
    if (drag.current?.id === ev.pointerId) drag.current = null;
  };

  // parallel edges between the same pair are curved apart
  const pairCount = new Map<string, number>();
  const edges = [...graph.edges.values()].map(e => {
    const key = [e.source, e.target].sort().join('|');
    const i = pairCount.get(key) ?? 0;
    pairCount.set(key, i + 1);
    return { e, offset: i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 26 };
  });
  const showLabels = transform.k >= 0.7;
  const rovingId = focusedId && graph.nodes.has(focusedId) ? focusedId : graph.centerId;

  return (
    <div ref={wrapRef} className="kg-canvas" data-testid="kg-canvas">
      <svg className="kg-svg" role="application" aria-roledescription="graphe" aria-label="Graphe de connaissances. Flèches : changer de nœud ; Entrée : détails ; E : développer ; C : centrer ; + et − : zoom ; 0 : ajuster ; Maj + flèches : déplacer la vue." width="100%" height="100%">
        <rect className="kg-svg-bg" width="100%" height="100%" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
        <g className="kg-viewport" transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
          <g className="kg-edges">
            {edges.map(({ e, offset }) => {
              const a = graph.nodes.get(e.source);
              const b = graph.nodes.get(e.target);
              if (!a || !b) return null;
              const p = edgePath(e, a, b, offset);
              const selected = selection?.kind === 'edge' && selection.id === e.id;
              const cls = ['kg-edge', `kg-edge--${e.kind}`, `kg-edge--${e.status.toLowerCase()}`, e.contradiction ? 'kg-edge--conflict' : '', selected ? 'kg-edge--selected' : ''].filter(Boolean).join(' ');
              return (
                <g key={e.id} className={cls} data-edge-id={e.id} role="button" tabIndex={-1} aria-label={describeEdge(e, graph.nodes)} aria-pressed={selected}
                  onClick={() => onSelectEdge(e.id)} onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelectEdge(e.id); } }}>
                  <path className="kg-edge-hit" d={p.d} />
                  <path className="kg-edge-line" d={p.d} />
                  {(showLabels || selected) && <text className="kg-edge-label" x={p.mx} y={p.my - 4} textAnchor="middle">{e.contradiction ? '⚠ ' : ''}{e.label}</text>}
                </g>
              );
            })}
          </g>
          <g className="kg-nodes">
            {[...graph.nodes.values()].map(n => {
              const selected = selection?.kind === 'node' && selection.id === n.id;
              const center = n.id === graph.centerId;
              const r = center ? 24 : 18;
              const cls = ['kg-node', n.ambiguous ? 'kg-node--ambiguous' : '', center ? 'kg-node--center' : '', selected ? 'kg-node--selected' : ''].filter(Boolean).join(' ');
              return (
                <g key={n.id} ref={el => { if (el) nodeRefs.current.set(n.id, el); else nodeRefs.current.delete(n.id); }}
                  className={cls} data-node-id={n.id} transform={`translate(${n.x},${n.y})`} role="button" tabIndex={n.id === rovingId ? 0 : -1}
                  aria-label={describeNode(n)} aria-pressed={selected}
                  onClick={() => { onFocusNode(n.id); onSelectNode(n.id); }} onFocus={() => onFocusNode(n.id)} onKeyDown={ev => onNodeKey(ev, n.id)}>
                  <circle className="kg-node-ring" r={r + 5} />
                  <circle className="kg-node-dot" r={r} style={{ fill: TYPE_COLOR[n.type] ?? '#9daebb' }} />
                  {n.ambiguous && <text className="kg-node-badge kg-node-badge--ambiguous" y={5} textAnchor="middle" aria-hidden="true">?</text>}
                  {n.hiddenEdges > 0 && (
                    <g className="kg-node-more" transform={`translate(${r * 0.75},${-r * 0.75})`} aria-hidden="true">
                      <circle r={11} />
                      <text y={4} textAnchor="middle">+{n.hiddenEdges > 99 ? '99' : n.hiddenEdges}</text>
                    </g>
                  )}
                  <text className="kg-node-label" y={r + 16} textAnchor="middle">{n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label}</text>
                </g>
              );
            })}
          </g>
        </g>
      </svg>
    </div>
  );
}
