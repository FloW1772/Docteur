// [ARCADE-SAFE-WATCHDOG 2026-10-23] Passive idle target for ONE check of the launcher's time limit. No computation.
// It must run under the supervised launcher, which is expected to stop it at HARD_LIMIT_MS (10 s, exit code 3):
//   node scripts/filament-safe-run.mjs scripts/test-filament-watchdog-idle.mjs
// Status when written: NOT RUN.
//
// What it does: prints one line, arms ONE Node timer of IDLE_MS (12 s, longer than the 10 s limit) and returns. The
// process then sleeps in the event loop: no loop, no recursion, no allocation, no file, no network, no process, no
// physics, no lab import. If the timer ever fires, the watchdog did NOT stop it in time: the script prints one line and
// exits WATCHDOG_MISSED (40), which can never be mistaken for the launcher's time-limit code or for a pass.
// Started without the launcher's session nonce it exits NOT_SUPERVISED (41) at once, before arming anything.

export const IDLE_MS = 12_000;
const CODE = Object.freeze({ WATCHDOG_MISSED: 40, NOT_SUPERVISED: 41 });
const say = (event, details = {}) => process.stdout.write(`${JSON.stringify({ idle: 'filament-watchdog', event, pid: process.pid, ...details })}\n`);

if (!/^[0-9a-f]{64}$/.test(process.env.FILAMENT_LAB_SESSION ?? '')) {
  say('NOT_SUPERVISED');
  process.exitCode = CODE.NOT_SUPERVISED;
} else {
  say('IDLE_ARMED', { idleMs: IDLE_MS });
  setTimeout(() => {
    say('WATCHDOG_MISSED', { idleMs: IDLE_MS });
    process.exitCode = CODE.WATCHDOG_MISSED;
  }, IDLE_MS);
}
