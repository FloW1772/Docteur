import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
let download;
mock.module('./src/lib/whisper.js', { namedExports: {
  downloadAudio: (...args) => download(...args), ensureTmpDir() {},
  splitAudioFile() { throw Error('Must not transcribe after failure'); },
  getVideoDuration: async () => 60, transcribeAudioFileWithSegments() {},
} });
const { initSqlite, insertVideoJob, getVideoJobById } = await import('./src/lib/sqlite.js');
const { runVideoPipeline, requestCancel, removeJobDir } = await import('./src/lib/video-pipeline/pipeline.js');
const { createVideoSummaryRoute } = await import('./src/routes/video-summary.js');
initSqlite(':memory:');
test('download failure is persisted and returned as terminal API error', async () => {
  const id=crypto.randomUUID();const message='Le site refuse le téléchargement de cette vidéo.';
  insertVideoJob({id,url:'https://www.youtube.com/watch?v=test'});
  download=async()=>{throw Error(message);};
  try {
    await runVideoPipeline(id);
    assert.equal(getVideoJobById(id).status,'error');
    assert.equal(getVideoJobById(id).current_step,'Erreur');
    const response=await createVideoSummaryRoute().request(`/video-summary/jobs/${id}`);
    assert.equal(response.status,200);const detail=await response.json();
    assert.equal(detail.job.status,'error');assert.equal(detail.job.error_message,message);
  } finally {removeJobDir(id);}
});
test('cancellation aborts the download and remains cancelled in storage', async () => {
  const id=crypto.randomUUID();insertVideoJob({id,url:'https://www.youtube.com/watch?v=test'});
  download=async(url,output,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new DOMException('Annulé','AbortError')),{once:true});
    requestCancel(id);
  });
  try {await runVideoPipeline(id);assert.equal(getVideoJobById(id).status,'cancelled');}
  finally {removeJobDir(id);}
});
