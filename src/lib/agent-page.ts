import type { Page, PageKind } from './types';
import { generateId } from './generateId';

export function agentPageData(output: { title: string; content: string; kind: string; run_id?: string }): Partial<Page> & { title: string } {
  return {
    title: output.title,
    kind: (output.kind as PageKind) ?? 'recherche',
    blocks: output.content.split('\n\n').filter(s => s.trim()).map(content => ({
      id: generateId(), type: 'paragraph' as const, content: content.trim(),
    })),
    metadata: { source: 'agent', ...(output.run_id ? { run_id: output.run_id } : {}) },
  };
}
