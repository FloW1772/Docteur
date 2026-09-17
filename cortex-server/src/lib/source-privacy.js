// Privacy travels with the source even if the page is absent or its
// user-editable flag has been cleared. Connector provenance is local-only.
export function isLocalOnlySource(source) {
  if (!source) return false;
  const metadata = source.metadata ?? {};
  return source.private === true || source.privacy === true ||
    ['cv', 'candidature'].includes(source.kind) ||
    source.egress_policy === 'local_only' || source.egressPolicy === 'local_only' ||
    metadata.private === true || metadata.privacy === true || metadata.egress_policy === 'local_only' ||
    (typeof metadata.source === 'string' && metadata.source.endsWith('_private'));
}
