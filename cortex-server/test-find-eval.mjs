// Inject eval/Function interceptors BEFORE page code runs, then reproduce the bug
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false, devtools: false });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const evalCalls = [];

// Inject interceptors via addInitScript — runs before any page JS
await ctx.addInitScript(() => {
  // Patch eval
  const _eval = globalThis.eval;
  globalThis.eval = function patchedEval(code) {
    if (typeof code === 'string' && code.includes('https://')) {
      const err = new Error('eval intercepted with URL content');
      console.error('[EVAL-INTERCEPT]', JSON.stringify({
        preview: code.slice(0, 200),
        stack: err.stack,
      }));
    }
    return _eval.call(this, code);
  };

  // Patch Function constructor
  const _Function = Function;
  window.Function = new Proxy(_Function, {
    construct(target, args) {
      const lastArg = args[args.length - 1];
      if (typeof lastArg === 'string' && lastArg.includes('https://')) {
        const err = new Error('new Function intercepted with URL content');
        console.error('[FUNCTION-INTERCEPT]', JSON.stringify({
          preview: lastArg.slice(0, 200),
          stack: err.stack,
        }));
      }
      return new target(...args);
    },
    apply(target, thisArg, args) {
      const lastArg = args[args.length - 1];
      if (typeof lastArg === 'string' && lastArg.includes('https://')) {
        const err = new Error('Function() intercepted with URL content');
        console.error('[FUNCTION-APPLY-INTERCEPT]', JSON.stringify({
          preview: lastArg.slice(0, 200),
          stack: err.stack,
        }));
      }
      return target.apply(thisArg, args);
    },
  });

  // Patch setTimeout/setInterval with string args
  const _setTimeout = window.setTimeout;
  window.setTimeout = function patchedTimeout(fn, delay, ...args) {
    if (typeof fn === 'string' && fn.includes('https://')) {
      const err = new Error('setTimeout intercepted with URL string');
      console.error('[SETTIMEOUT-INTERCEPT]', JSON.stringify({
        preview: fn.slice(0, 200),
        stack: err.stack,
      }));
    }
    return _setTimeout.call(this, fn, delay, ...args);
  };
});

// Capture console errors
page.on('console', msg => {
  if (msg.type() === 'error') {
    console.log(`\n[BROWSER CONSOLE ERROR] ${msg.text()}`);
  }
});

page.on('pageerror', err => {
  console.log('\n=== PAGE ERROR ===');
  console.log(err.message);
  console.log(err.stack);
});

// CDP to capture ALL exceptions (including from VM scripts)
const cdp = await ctx.newCDPSession(page);
await cdp.send('Runtime.enable');
cdp.on('Runtime.exceptionThrown', (params) => {
  const ex = params.exceptionDetails;
  if (ex.text?.includes('Label') || ex.text?.includes('https')) {
    console.log('\n=== CDP EXCEPTION (TARGET) ===');
    console.log('Text:', ex.text);
    console.log('URL:', ex.url);
    console.log('Line:', ex.lineNumber);
    if (ex.stackTrace?.callFrames) {
      console.log('Stack:');
      ex.stackTrace.callFrames.forEach(f => {
        console.log(`  ${f.functionName || '<anon>'} @ ${f.url}:${f.lineNumber}:${f.columnNumber}`);
      });
    }
    if (ex.exception?.description) {
      console.log('Description:', ex.exception.description.slice(0, 500));
    }
  } else {
    // Log all other exceptions too
    console.log(`\n[CDP exception] ${ex.text} @ ${ex.url}:${ex.lineNumber}`);
  }
});

// Enable script parsing events to see VM scripts being created
await cdp.send('Debugger.enable');
cdp.on('Debugger.scriptParsed', (params) => {
  // Only log VM scripts (no URL or data: URL)
  if (!params.url || params.url.startsWith('data:') || params.url.startsWith('blob:')) {
    console.log(`[VM SCRIPT] id=${params.scriptId} url="${params.url}" len=${params.length || '?'}`);
  }
});

console.log('Loading app...');
await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 20000 });
console.log('App loaded.');

// Open capture modal
await page.keyboard.press('Control+n');
await page.waitForTimeout(600);

const textarea = page.locator('textarea').first();
const visible = await textarea.isVisible({ timeout: 3000 }).catch(() => false);

if (!visible) {
  console.log('ERROR: capture modal did not open');
  await browser.close();
  process.exit(1);
}

// Paste 5 URLs exactly like the user would
const input = [
  'info https://www.clubic.com/article/test-gpu-1',
  'https://www.clubic.com/article/test-gpu-2',
  'https://www.clubic.com/article/test-gpu-3',
  'https://www.clubic.com/article/test-gpu-4',
  'https://www.clubic.com/article/test-gpu-5',
].join('\n');

console.log('\nInserting 5-URL batch...');
await textarea.fill(input);
await page.waitForTimeout(500);

console.log('Submitting (Ctrl+Enter)...');
await page.keyboard.press('Control+Enter');

// Wait for something to happen
await page.waitForTimeout(5000);

console.log('\nDone observing. Closing...');
await browser.close();
process.exit(0);
