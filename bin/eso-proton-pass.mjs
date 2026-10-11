#!/usr/bin/env node
// Entry point: read the settings, keep a Proton session, serve.
import { loadConfig } from '../src/config.mjs';
import { createPass } from '../src/pass.mjs';
import { startServer } from '../src/server.mjs';
import { keepLoggedIn } from '../src/keepalive.mjs';

/** Prints one timestamped line to stdout, which is where a pod's log goes. */
function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const pass = createPass(config);
const server = await startServer({ config, pass, log });
log(`listening on ${config.host}:${config.port}, vaults "${config.vaultPrefix}<namespace>"`);

// The server is up before the first login: /readyz answers 503 until there
// is a session, so Kubernetes routes nothing here before then.
const stop = new AbortController();
keepLoggedIn(pass, { log, signal: stop.signal });

// Kubernetes sends SIGTERM and waits; finish what is in flight, then go.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`${signal}, shutting down`);
    stop.abort();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
