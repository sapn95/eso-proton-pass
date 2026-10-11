#!/usr/bin/env node
// Entry point: read the settings, log in to Proton Pass, serve.
import { loadConfig } from '../src/config.mjs';
import { createPass } from '../src/pass.mjs';
import { startServer } from '../src/server.mjs';

/** Prints one timestamped line to stdout, which is where a pod's log goes. */
function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

/**
 * Logs in, and keeps trying with a growing pause if Proton is unreachable.
 * The server is already up meanwhile: /readyz answers 503 until this works,
 * so Kubernetes routes nothing here before there is a session.
 */
async function loginUntilReady(pass) {
  for (let delay = 2; ; delay = Math.min(delay * 2, 300)) {
    try {
      await pass.login();
      log('logged in to Proton Pass');
      return;
    } catch (err) {
      log(`${err.message}; next attempt in ${delay}s`);
      await new Promise(r => setTimeout(r, delay * 1000));
    }
  }
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
loginUntilReady(pass);

// Kubernetes sends SIGTERM and waits; finish what is in flight, then go.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
