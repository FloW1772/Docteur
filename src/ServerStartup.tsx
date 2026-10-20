import App from './App';
import { StartupGate } from './components/startup/StartupGate';

// Waits for cortex-server's readiness ping before mounting the real App — split out of main.tsx (a plain bootstrap
// entry with no exports) so this file exports only a component, which Vite's Fast Refresh needs to treat it as a valid
// refresh boundary during development. [LOAD-1/LOAD-2] The boot screen itself (states, delay, failure, Retry, offline
// copy) lives in components/startup/StartupGate.tsx; readiness polling in lib/startup/readiness.ts.
const renderApp = () => <App />;

export function ServerStartup() {
  return <StartupGate renderReady={renderApp} />;
}
