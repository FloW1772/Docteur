// Extraction-only audit: no Ollama, no SQLite write, no LanceDB write.
import { closeDeepCaptureBrowserForTests, extractContent } from './src/lib/deep-capture.js';

const urls = process.argv.slice(2);
if (urls.length === 0) {
  urls.push(
    'https://www.20minutes.fr/monde/italie/4242099-20260904-recette-gouvernement-giorgia-meloni-devient-plus-long-italie-apres-guerre',
    'https://www.20minutes.fr/monde/4239952-20260819-portugal-interdit-port-voile-integral',
  );
}

const results = [];
try {
  for (const url of urls) {
    const started = Date.now();
    const result = await extractContent(url);
    results.push({
      url,
      elapsedMs: Date.now() - started,
      fallback: result.fallback,
      reason: result.reason ?? null,
      title: result.title ?? '',
      wordCount: result.word_count ?? result.partial?.word_count ?? 0,
      images: result.imageUrls?.length ?? result.partial?.imageUrls?.length ?? 0,
      extraction: result.extraction ?? null,
      timings: result.timings ?? null,
    });
  }
} finally {
  await closeDeepCaptureBrowserForTests();
}

console.log(JSON.stringify(results, null, 2));
