// Shared text/code artifact viewer — replaces the ad hoc <details><pre>
// pattern duplicated in MetaGPT (PRD/Design/Tasks/code/diff) with a
// consistent collapsible block, monospace body, and an optional copy
// button. Uses native <details>/<summary> (not a custom toggle) so it stays
// compatible with existing Playwright assertions that locate artifacts by
// their <summary> text. Never executes or evaluates the content — display only.
import { useState } from 'react';
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

  if (!content) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(content ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied by the browser — non-fatal, no UI needed.
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
    </details>
  );
}
