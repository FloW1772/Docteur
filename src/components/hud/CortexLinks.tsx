// Thin visual link between each corner module widget and the central
// Cortex core (mission requirement 5 — "relier visuellement les widgets au
// Cortex... évoquer des modules connectés au cerveau central, pas un
// circuit électronique illisible"). Pure inline SVG, no canvas, no RAF loop,
// no new dependency — a handful of static <line>/<circle> elements plus one
// optional CSS animation per active line (covered by the global
// prefers-reduced-motion kill-switch like every other CSS animation here,
// so no JS-side reduced-motion branching is needed).

interface Corner {
  key: string;
  x: number; // percentage, 0-100
  y: number;
}

// Anchor points roughly at each corner widget's inner edge (closest to the
// core), in viewport percentage — matches .hud2-corner--{tl,tr,bl,br}.
const CORNERS: Corner[] = [
  { key: 'metagpt', x: 15, y: 12 },
  { key: 'sherlock', x: 85, y: 12 },
  { key: 'investment', x: 15, y: 88 },
  { key: 'video', x: 85, y: 88 },
];

interface Props {
  activeKeys: string[];
}

export default function CortexLinks({ activeKeys }: Props) {
  return (
    <svg
      className="hud2-cortex-links"
      aria-hidden="true"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      {CORNERS.map(corner => {
        const active = activeKeys.includes(corner.key);
        return (
          <g key={corner.key}>
            <line
              x1={corner.x} y1={corner.y} x2={50} y2={50}
              className={`hud2-cortex-link${active ? ' hud2-cortex-link--active' : ''}`}
              vectorEffect="non-scaling-stroke"
            />
            {active && (
              <circle cx={corner.x} cy={corner.y} r="0.6" className="hud2-cortex-link-dot" />
            )}
          </g>
        );
      })}
    </svg>
  );
}
