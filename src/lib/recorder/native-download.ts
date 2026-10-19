// [REC-DL-1] Hands a download URL to the browser's own download manager (an <a> click inside the user's click
// handler). The renderer never fetches the body: no fetch().blob(), no arrayBuffer(), no FileReader, no object URL —
// the video streams from Docteur to the download folder the BROWSER manages (no FILES.USER_SELECTED_WRITE).
export function startNativeDownload(url: string, doc: Pick<Document, 'createElement' | 'body'> = document): void {
  const a = doc.createElement('a');
  a.href = url;
  a.download = ''; // the server's Content-Disposition names the file
  a.rel = 'noopener';
  a.style.display = 'none';
  doc.body.appendChild(a);
  try { a.click(); } finally { a.remove(); }
}
