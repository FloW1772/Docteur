// [EETF V1] EETF-8 — browser harness: the REAL components of each surface, wired the way App.tsx wires them
// (App.tsx itself is a KG-staged file and is not touched by EETF-8):
//   ?view=imggen            ImageGeneratorModal (EETF tabs + integration panel + reader host)
//   ?view=studio[&import=]  MediaStudioModal (optionally a pending import from the reader, like App does)
//   ?view=neuron            a Neurone image block (Block, type image) + the Media Reader + Media Studio, App-style
//   ?view=reader&url=       the Media Reader alone on a URL
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import ImageGeneratorModal from '../src/components/modals/ImageGeneratorModal';
import MediaStudioModal from '../src/components/modals/MediaStudioModal';
import MediaReader from '../src/components/media/MediaReader';
import BlockComp from '../src/components/blocks/Block';
import { cortexClient } from '../src/lib/cortex/client';

window.__eetf8 = { closed: 0, blocks: [], studioOpened: 0 };
const params = new URLSearchParams(location.search);

function ImgGen() {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button type="button" id="open-imggen" onClick={() => setOpen(true)}>Ouvrir le générateur</button>
      {open && <ImageGeneratorModal strictLocalMode={false} onClose={() => { window.__eetf8.closed += 1; setOpen(false); }} />}
    </div>
  );
}

/** App-like neuron page: blocks state, onUploadImage = cortexClient.uploadImage, reader + studio overlays like App. */
function Neuron() {
  const [block, setBlock] = useState({ id: 'b1', type: 'image', content: params.get('image') ?? '' });
  const [reader, setReader] = useState(null);
  const [studio, setStudio] = useState(null);
  window.__eetf8.blocks = [block];
  let seq = 0;
  return (
    <div style={{ padding: 16, maxWidth: 760 }}>
      <h1 style={{ color: '#ddd', fontSize: 16 }}>Neurone de test</h1>
      <BlockComp
        block={block} focused={false} onFocus={() => {}} onEnter={() => {}} onDelete={() => setBlock(b => ({ ...b, content: '' }))}
        onChange={(u) => setBlock(b => ({ ...b, ...u }))}
        onUploadImage={async (file) => (await cortexClient.uploadImage(file)).id}
        onDeleteImage={() => {}}
        onOpenMedia={(url) => { seq += 1; setReader({ requestId: Date.now() + seq, url }); }}
      />
      {reader && <MediaReader key={reader.requestId} request={reader} onClose={() => setReader(null)}
        onSendToMediaStudio={({ url, title }) => { setReader(null); window.__eetf8.studioOpened += 1; setStudio({ requestId: Date.now(), url, title }); }} />}
      {studio && <MediaStudioModal pendingImport={studio} onClose={() => setStudio(null)} />}
    </div>
  );
}

function Studio() {
  const url = params.get('import');
  return <MediaStudioModal pendingImport={url ? { requestId: 1, url, title: params.get('title') } : null} onClose={() => { window.__eetf8.closed += 1; }} />;
}

function Reader() {
  const [studio, setStudio] = useState(null);
  const [req, setReq] = useState({ requestId: 1, url: params.get('url') ?? '', title: params.get('title'), mimeType: params.get('mime') });
  return (
    <div>
      <button type="button" id="reopen" onClick={() => setReq(r => ({ ...r, requestId: r.requestId + 1 }))}>Rouvrir</button>
      {req && <MediaReader key={req.requestId} request={req} onClose={() => setReq(null)}
        onSendToMediaStudio={({ url, title }) => { setReq(null); window.__eetf8.studioOpened += 1; setStudio({ requestId: Date.now(), url, title }); }} />}
      {studio && <MediaStudioModal pendingImport={studio} onClose={() => setStudio(null)} />}
    </div>
  );
}

export function mount() {
  const view = params.get('view');
  const El = view === 'studio' ? Studio : view === 'neuron' ? Neuron : view === 'reader' ? Reader : ImgGen;
  createRoot(document.getElementById('root')).render(<El />);
}
