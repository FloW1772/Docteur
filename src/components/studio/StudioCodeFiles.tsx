import { useState } from 'react';
import type { Artifacts } from '../../lib/metagpt-studio';
import StudioArtifactViewer from './StudioArtifactViewer';

export default function StudioCodeFiles({ files }: { files: Artifacts['codegen'] }) {
  const [path, setPath] = useState(files[0]?.path);
  const index = Math.max(0, files.findIndex(file => file.path === path));
  const file = files[index];
  if (!file) return null;
  return (
    <div>
      <label>Fichier généré
        <select aria-label="Fichier généré" className="studio-field" value={file.path} onChange={e => setPath(e.target.value)}>
          {files.map(f => <option key={f.path} value={f.path}>{f.path}</option>)}
        </select>
      </label>
      <div className="studio-filter-row">
        <button className="studio-button" type="button" disabled={index === 0} onClick={() => setPath(files[index - 1].path)}>Fichier précédent</button>
        <span>{index + 1} / {files.length}</span>
        <button className="studio-button" type="button" disabled={index === files.length - 1} onClick={() => setPath(files[index + 1].path)}>Fichier suivant</button>
      </div>
      <StudioArtifactViewer key={file.path} title={`Code — ${file.path}`} content={file.content}
        meta={file.content == null ? 'Contenu indisponible' : `${new TextEncoder().encode(file.content).length} octets`} />
      {file.content == null && <p>Contenu indisponible pour ce fichier.</p>}
    </div>
  );
}
