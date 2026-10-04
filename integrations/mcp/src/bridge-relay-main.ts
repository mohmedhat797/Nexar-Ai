import { runBridgeRelay } from './bridge-relay.js';

// The entry Desktop launches: configuration comes only from the environment. No top-level await:
// Desktop bundles this file as CommonJS.
void runBridgeRelay({ env: process.env }).then((code) => {
  process.exitCode = code;
});
