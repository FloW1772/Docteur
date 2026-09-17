// Preloaded only by the offline certification runner. Tests may install
// explicit fetch mocks; an accidental call to the default fetch fails shut.
process.env.DOCTEUR_TEST_MODE = '1';
globalThis.fetch = async () => { throw new Error('UNMOCKED_NETWORK_BLOCKED_IN_CERTIFICATION'); };
