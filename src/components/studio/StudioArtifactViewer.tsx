// Shared text/code artifact viewer — replaces the ad hoc <details><pre>
// pattern duplicated in MetaGPT (PRD/Design/Tasks/code/diff) with a
// consistent collapsible block, monospace body, and an optional copy
// button. Uses native <details>/<summary> (not a custom toggle) so it stays
// compatible with existing Playwright assertions that locate artifacts by
// their <summary> text. Never executes or evaluates the content — display only.
import { useEffect, useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface Props {
  title: string;
  content: string | null | undefined;
  defaultOpen?: boolean;
  /** Optional short meta line next to the title (e.g. file size, operation). */
  meta?: string;
}

export default function StudioArtifactViewer({ title, content, defaultOpen = true, meta }: Props) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  if (content == null) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(content ?? '');
      setCopyError(false);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <details className="studio-artifact" open={defaultOpen}>
      <summary className="studio-artifact-summary">
        <span>{title}</span>
        {meta && <span className="studio-artifact-meta">{meta}</span>}
        <button
          type="button"
          className="studio-artifact-copy"
          onClick={e => { e.preventDefault(); void copy(); }}
          aria-label={`Copier ${title}`}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </summary>
      <pre className="studio-artifact-body">{content}</pre>
      {copyError && <p role="status">Copie indisponible. Sélectionnez le texte pour le copier manuellement.</p>}
    </details>
  );
}
