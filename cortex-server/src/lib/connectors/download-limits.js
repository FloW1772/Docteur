// Shared streaming size-limit enforcement for connector file downloads
// (Batch C introduced this for OneDrive; Batch D extracts it here so Google
// Drive's connector — and any future one — gets the identical protection
// without a second hand-maintained copy).
//
// Enforces maxBytes two ways: (1) a fast pre-check against the Content-Length
// header when the server sends one, and (2) a running byte count as the
// stream is read, aborted the moment it crosses the limit — a response with
// no Content-Length (or a dishonest one) must not be able to buffer an
// unbounded amount of data in memory before check (1) would ever fire.
// There is no unbounded fallback path: a response with no streamable body
// is treated as an error rather than read via arrayBuffer(), which would
// have no size ceiling at all.
//
// Never includes a URL, header, or raw stack in a thrown error — only a
// fixed message shape plus byte counts, via the caller-supplied ErrorClass.

// Fetches downloadUrl and enforces maxBytes. `fetchOptions` is passed
// through to fetch() as-is (e.g. { signal, headers }) so callers can add
// their own Authorization header / abort signal without this helper needing
// to know about either. `buildXMessage(...)` callbacks let each connector
// keep its own wording while sharing the enforcement logic.
export async function downloadWithSizeLimit(downloadUrl, {
  maxBytes,
  ErrorClass = Error,
  fetchImpl = globalThis.fetch,
  fetchOptions = {},
  buildTooLargeMessage = ({ declaredSize, maxBytes: limit }) => `Fichier trop volumineux (${declaredSize} octets, limite ${limit})`,
  buildStreamingTooLargeMessage = ({ maxBytes: limit }) => `Fichier trop volumineux (dépassement en cours de lecture, > ${limit} octets)`,
  buildNetworkErrorMessage = () => 'Téléchargement échoué (réseau ou délai dépassé)',
  buildHttpErrorMessage = (status) => `Téléchargement échoué (${status})`,
  buildNoBodyErrorMessage = () => 'Téléchargement échoué (réponse sans corps exploitable)',
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Limite de téléchargement invalide');
  let res;
  try {
    fetchOptions.signal?.throwIfAborted();
    res = await fetchImpl(downloadUrl, fetchOptions);
  } catch {
    throw new Error(buildNetworkErrorMessage());
  }
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    throw new Error(buildHttpErrorMessage(res.status));
  }

  const rawContentLength = res.headers.get('content-length');
  // Number(null) is 0 (not NaN) — an explicit null check keeps a genuinely
  // absent header distinct from a server that literally sent "0".
  const declaredSize = rawContentLength === null ? null : Number(rawContentLength);
  if (declaredSize !== null && Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    // Drain/cancel the body instead of leaving the connection dangling.
    await res.body?.cancel().catch(() => {});
    throw new ErrorClass(
      buildTooLargeMessage({ declaredSize, maxBytes }),
      { declaredSize, receivedBytes: 0 },
    );
  }

  // No streamable body at all — never fall back to res.arrayBuffer() here,
  // since that path has no size ceiling whatsoever. A legitimate file
  // download always has a body; treat a missing one as a hard error.
  if (!res.body) throw new Error(buildNoBodyErrorMessage());

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  let sizeError;
  const abort = () => { void reader.cancel().catch(() => {}); };
  fetchOptions.signal?.addEventListener('abort', abort, { once: true });
  if (fetchOptions.signal?.aborted) abort();
  try {
    while (true) {
      fetchOptions.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      fetchOptions.signal?.throwIfAborted();
      if (done) break;
      received += value.length;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        sizeError = new ErrorClass(
          buildStreamingTooLargeMessage({ maxBytes }),
          { declaredSize: Number.isFinite(declaredSize) ? declaredSize : null, receivedBytes: received },
        );
        throw sizeError;
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error === sizeError) throw error;
    throw new Error(buildNetworkErrorMessage());
  } finally {
    fetchOptions.signal?.removeEventListener('abort', abort);
    try { reader.releaseLock(); } catch { /* already released on cancel/error */ }
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return merged.buffer;
}
