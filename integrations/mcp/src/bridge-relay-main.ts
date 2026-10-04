import { runBridgeRelay } from './bridge-relay.js';

// The entry Desktop launches: configuration comes only from the environment.
process.exitCode = await runBridgeRelay({ env: process.env });
