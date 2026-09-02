import { useState, useCallback, useRef } from 'react';

// All assets served locally from public/tesseract/ (see scripts/copy-tesseract-assets.mjs)
// — workerPath/corePath/langPath below are set explicitly so tesseract.js NEVER
// falls back to its default jsdelivr CDN. This is what makes OCR 100% offline.
const WORKER_PATH = '/tesseract/worker.min.js';
const CORE_PATH   = '/tesseract/tesseract-core-simd-lstm.wasm.js';
const LANG_PATH    = '/tesseract/lang-data';

export type OcrPhase = 'idle' | 'loading' | 'recognizing' | 'done' | 'error';

export function useScreenOcr() {
  const [phase, setPhase]       = useState<OcrPhase>('idle');
  const [progress, setProgress] = useState(0); // 0..1
  const [error, setError]       = useState<string | null>(null);
  const busyRef = useRef(false);

  const recognize = useCallback(async (imageDataUrl: string): Promise<string | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setError(null);
    setProgress(0);
    setPhase('loading');

    // Tesseract.js (and its ~7 MB WASM core + language data) is imported only
    // here, on first actual use — never at app startup, never while screen
    // sharing is merely active but nothing has been captured yet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Tesseract = await import('tesseract.js') as any;

    let worker: { recognize: (image: string) => Promise<{ data: { text: string } }>; terminate: () => Promise<void> } | null = null;
    try {
      worker = await Tesseract.createWorker(['fra', 'eng'], 1, {
        workerPath: WORKER_PATH,
        corePath:   CORE_PATH,
        langPath:   LANG_PATH,
        gzip:       true,
        // No content is ever logged — only a 0..1 progress fraction.
        logger: (m: { status: string; progress: number }) => {
          if (m.status === 'recognizing text') setProgress(m.progress);
        },
      });
      setPhase('recognizing');
      const result = await worker!.recognize(imageDataUrl);
      setPhase('done');
      return result.data.text;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur OCR');
      setPhase('error');
      return null;
    } finally {
      // Free the WASM instance right away — OCR is an occasional action, not
      // worth keeping several MB resident between uses.
      await worker?.terminate().catch(() => {});
      busyRef.current = false;
    }
  }, []);

  const reset = useCallback(() => { setPhase('idle'); setProgress(0); setError(null); }, []);

  return { phase, progress, error, recognize, reset };
}
