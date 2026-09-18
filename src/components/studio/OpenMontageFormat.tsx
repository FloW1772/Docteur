// HeroTitle currently renders at this fixed size and frame rate. The API's
// broader allowlist is not evidence that the renderer applies those options.
export const OPENMONTAGE_FORMAT = { resolution: '1920x1080', fps: 30 } as const;

export default function OpenMontageFormat() {
  return (
    <div className="studio-render-format">
      <label>Format<input className="studio-field" value="1920×1080 (16:9)" readOnly /></label>
      <label>FPS<input className="studio-field" value="30" readOnly /></label>
      <p>Format disponible : paysage Full HD, 30 images par seconde.</p>
    </div>
  );
}
