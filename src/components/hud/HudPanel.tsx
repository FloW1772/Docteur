// HUD generic panel surface — the shared visual shell (glass, border,
// radius, spacing) every HUD widget/rail/drawer builds on, so the design
// system stays consistent without each caller re-declaring the same CSS.
//
// Uses the "hud2-" CSS prefix deliberately: a pre-existing, unrelated
// ".hud-panel { position: fixed; z-index: 20 }" rule already exists in
// globals.css:122 (legacy/unused sci-fi-HUD scaffolding, no component
// currently renders it) — reusing the bare "hud-panel" name here collided
// with it (panels rendered on top of each other, intercepting each
// other's clicks). Rather than touch or remove that historical rule
// (unclear blast radius, out of this mission's scope), this whole new
// component family uses a distinct "hud2-" prefix.
import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  className?: string;
  title?: string;
  /** Compact reduces padding — used inside dense rails. */
  compact?: boolean;
  ariaLabel?: string;
}

export default function HudPanel({ children, className = '', title, compact = false, ariaLabel }: Props) {
  return (
    <section
      className={`hud2-panel glass${compact ? ' hud2-panel--compact' : ''} ${className}`.trim()}
      aria-label={ariaLabel ?? title}
    >
      {title && <h3 className="hud2-panel-title">{title}</h3>}
      {children}
    </section>
  );
}
