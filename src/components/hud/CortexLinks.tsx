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
// Customizable Dashboard V1: keyed by corner SLOT (the user chooses which card sits in each corner).
const CORNERS: Corner[] = [
  { key: 'tl', x: 15, y: 12 },
  { key: 'tr', x: 85, y: 12 },
  { key: 'bl', x: 15, y: 88 },
  { key: 'br', x: 85, y: 88 },
];

interface Props {
  /** corner slots that currently hold a card (an empty corner gets no line) */
  occupiedSlots: string[];
  /** occupied slots whose card reports real activity */
  activeSlots: string[];
}

export default function CortexLinks({ occupiedSlots, activeSlots }: Props) {
  return (
    <svg
      className="hud2-cortex-links"
      aria-hidden="true"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      {CORNERS.filter(corner => occupiedSlots.includes(corner.key)).map(corner => {
        const active = activeSlots.includes(corner.key);
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
