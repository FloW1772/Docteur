import type { Page } from '../types';

export function pageToContent(page: Page): string {
  const lines: string[] = [];
  if (page.title) lines.push(page.title);
  for (const block of page.blocks) {
    const text = block.content.trim();
    if (!text) continue;
    if (block.type === 'todo') {
      lines.push(`[${block.checked ? 'x' : ' '}] ${text}`);
    } else {
      lines.push(text);
    }
  }
  if (page.tags?.length) lines.push(`Tags: ${page.tags.join(', ')}`);
  return lines.join('\n').trim();
}
