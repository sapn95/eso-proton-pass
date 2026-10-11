// Settings come from the environment, the way a Deployment hands them over.
// Everything has a default except the two secrets, and a bad value stops the
// process at start rather than at the first request.
import { isAbsolute } from 'node:path';

/** Reads an integer setting, falling back to `fallback` when it is unset. */
function intFrom(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return value;
}

/**
 * Builds the configuration from `env` (process.env in production).
 *
 * The personal access token is not part of the returned object on purpose:
 * only the login child process ever sees it, so it is read where that process
 * is started (see pass.mjs) and nowhere else.
 */
export function loadConfig(env = process.env) {
  const token = env.BRIDGE_TOKEN ?? '';
  // Short tokens are guessable over a network; 32 characters is a floor, not
  // a recommendation. `openssl rand -hex 32` gives 64.
  if (token.length < 32) throw new Error('BRIDGE_TOKEN must be set to at least 32 characters');
  if (!env.PROTON_PASS_PERSONAL_ACCESS_TOKEN) throw new Error('PROTON_PASS_PERSONAL_ACCESS_TOKEN must be set');
  // The bridge clears this directory before each login (see pass.mjs), so it
  // has to be one that belongs to the bridge and nothing else.
  const sessionDir = env.PROTON_PASS_SESSION_DIR ?? '';
  if (!isAbsolute(sessionDir)) throw new Error('PROTON_PASS_SESSION_DIR must be set to an absolute path the bridge owns');

  return {
    token,
    port: intFrom(env, 'PORT', 8080),
    host: env.HOST || '0.0.0.0',
    passCli: env.PASS_CLI || 'pass-cli',
    sessionDir,
    // Each namespace reads exactly one vault: `<prefix><namespace>`. That is
    // the whole isolation model, so the prefix is not optional.
    vaultPrefix: env.VAULT_PREFIX ?? 'k8s-',
    // The field read when an ExternalSecret names no `property`.
    defaultField: env.DEFAULT_FIELD || 'value',
    // ESO refreshes every hour by default; a minute of caching only spares
    // Proton the bursts of a resync, and it never outlives a rotation by much.
    cacheSeconds: intFrom(env, 'CACHE_SECONDS', 60),
    // Proton ends a PAT session after two hours. Logging in again a little
    // before that avoids the one failed request that would otherwise find out.
    sessionMinutes: intFrom(env, 'SESSION_MINUTES', 100),
    commandTimeoutMs: intFrom(env, 'COMMAND_TIMEOUT_MS', 30000),
  };
}
