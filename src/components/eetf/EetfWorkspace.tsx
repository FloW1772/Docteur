// EETF V1 — EETF-7 workspace shown inside ImageGeneratorModal (Textures / Environments tabs).
// Mounted only when an EETF tab is open, so the historical Image tab never calls EETF.
import EetfTexturesTab from './EetfTexturesTab';
import EetfEnvironmentsTab from './EetfEnvironmentsTab';
import { useEetfData } from './useEetfData';

export default function EetfWorkspace({ surface }: { surface: 'texture' | 'environment' }) {
  const data = useEetfData();
  if (data.loading) return <p className="eetf-muted" role="status" aria-busy="true">Chargement d’EETF…</p>;
  return surface === 'texture' ? <EetfTexturesTab data={data} /> : <EetfEnvironmentsTab data={data} />;
}
