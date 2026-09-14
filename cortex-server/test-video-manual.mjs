import { spawn, execFileSync } from 'node:child_process';
import { YTDLP_BIN } from './src/lib/ytdlp.js';
import { downloadAudio, redactDownloadLog } from './src/lib/video-audio-download.js';
import fs from 'node:fs';
import path from 'node:path';
const url = 'https://www.youtube.com/watch?v=B-tTquMDXRQ';
const folder = fs.mkdtempSync(path.resolve('cortex-server/data/tmp', 'video-repro-'));
if (process.argv.includes('--application')) {
  await downloadAudio(url, path.join(folder, 'application.%(ext)s'), {
    browser: '', timeoutMs:180000,
    logger: {
      debug: (data, event) => console.log(JSON.stringify({event, ...data, stdout: data.stdout?.split('\n').filter(l => !/\[download\]\s+[\d.]+%/.test(l)).join('\n')})),
      warn: (data, event) => console.log(JSON.stringify({event, ...data})),
    },
  });
  const audio = path.join(folder,'application.wav');
  console.log(JSON.stringify({bytes:fs.statSync(audio).size, duration:execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',audio],{encoding:'utf8'}).trim()}));
  process.exit(0);
}
const strategies = process.argv.includes('--hls') ? [
  ['node-web-formats', ['--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`, '--extractor-args', 'youtube:player_client=default,-android_vr', '-F']],
  ['hls-audio', ['--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`, '--extractor-args', 'youtube:player_client=default,-android_vr', '-f', 'bestaudio[protocol^=m3u8]/best[protocol^=m3u8]', '--download-sections', '*0-15']],
] : process.argv.includes('--compare') ? [
  ['original-control', []],
  ['node-full', ['--js-runtimes', `node:${process.execPath}`]],
] : process.argv.includes('--node') ? [
  ['node-default', ['--js-runtimes', `node:${process.execPath}`, '--test']],
  ['node-safari', ['--js-runtimes', `node:${process.execPath}`, '--extractor-args', 'youtube:player_client=web_safari', '--test']],
] : [
  ['metadata', ['--print', 'duration', '--skip-download']],
  ['original', []],
  ['audio', ['-f', 'bestaudio[ext=m4a]/bestaudio/best']],
  ['headers', ['-f', 'bestaudio/best', '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', '--referer', 'https://www.youtube.com/']],
  ['youtube-client', ['-f', 'bestaudio/best', '--extractor-args', 'youtube:player_client=web_safari']],
];
for (const [name, extra] of strategies) {
  const args = [url, '-x', '--audio-format','wav','--audio-quality','0','--no-playlist','--newline','-o',path.join(folder,`${name}.%(ext)s`), ...extra];
  const start = Date.now();
  await new Promise(resolve => {
    const proc = spawn(YTDLP_BIN,args,{timeout:process.argv.includes('--compare') ? 180000 : 45000,windowsHide:true}); let out='';
    proc.stdout.on('data',d=>out=(out+d).slice(-12000)); proc.stderr.on('data',d=>out=(out+d).slice(-12000));
    proc.on('error',err=>console.log(JSON.stringify({name,error:err.code})));
    proc.on('close',(code,signal)=> { console.log(JSON.stringify({name,code,signal,durationMs:Date.now()-start,args:args.map(a=>redactDownloadLog(a)),output:redactDownloadLog(out)}));resolve(); });
  });
}
