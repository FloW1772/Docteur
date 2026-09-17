// Shared paragraph-boundary text chunker — extracted from routes/corpus.js
// (Phase 5, MASTER mission) so routes/notebook.js can reuse the exact same
// splitting behavior instead of re-implementing it. Never splits mid-sentence
// when avoidable; a single oversized paragraph is hard-split as a last resort.
export function chunkText(text, maxChars) {
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length > 0 && current.length + para.length + 2 > maxChars) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${para}` : para;
    while (current.length > maxChars) {
      chunks.push(current.slice(0, maxChars));
      current = current.slice(maxChars);
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}
