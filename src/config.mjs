// Settings come from the environment, the way a Deployment hands them over.
// Everything has a default except the two secrets, and a bad value stops the
// process at start rather than at the first request.
//
// Both secrets can come from a file (…_FILE), which is how the Deployment
// mounts them: a file is not visible in /proc/<pid>/environ, an environment
// variable is.
import { isAbsolute } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

/** Reads an integer setting, falling back to `fallback` when it is unset. */
function intFrom(env, name, fallback, min = 0) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be an integer of at least ${min}, got "${raw}"`);
  return value;
}

/** A secret from `<name>_FILE` if that is set, else from `<name>`; trimmed. */
function secret(env, name) {
  const file = env[`${name}_FILE`];
  if (file) {
    if (!existsSync(file)) throw new Error(`${name}_FILE points at ${file}, which does not exist`);
    return readFileSync(file, 'utf8').trim();
  }
  return (env[name] ?? '').trim();
}

/**
 * Builds the configuration from `env` (process.env in production).
 *
 * The personal access token is checked here but not kept: only the login
 * child process ever gets it, read where that process is started (pass.mjs).
 */
export function loadConfig(env = process.env) {
  const token = secret(env, 'BRIDGE_TOKEN');
  // Short tokens are guessable over a network; 32 characters is a floor, not
  // a recommendation. `openssl rand -hex 32` gives 64.
  if (token.length < 32) throw new Error('BRIDGE_TOKEN (or BRIDGE_TOKEN_FILE) must hold at least 32 characters');
  if (!secret(env, 'PROTON_PASS_PERSONAL_ACCESS_TOKEN')) {
    throw new Error('PROTON_PASS_PERSONAL_ACCESS_TOKEN (or PROTON_PASS_PERSONAL_ACCESS_TOKEN_FILE) must be set');
  }
  // The bridge removes <dir>/.session before each login (see pass.mjs), so
  // the directory has to belong to the bridge and nothing else.
  const sessionDir = env.PROTON_PASS_SESSION_DIR ?? '';
  if (!isAbsolute(sessionDir)) throw new Error('PROTON_PASS_SESSION_DIR must be set to an absolute path the bridge owns');
  // Each namespace reads exactly one vault, `<prefix><namespace>`. Without a
  // prefix a namespace called "homelab" would read a vault called "homelab".
  const vaultPrefix = env.VAULT_PREFIX ?? 'k8s-';
  if (!vaultPrefix) throw new Error('VAULT_PREFIX must not be empty');

  return {
    token,
    port: intFrom(env, 'PORT', 8080),
    host: env.HOST || '0.0.0.0',
    passCli: env.PASS_CLI || 'pass-cli',
    sessionDir,
    vaultPrefix,
    // The field read when an ExternalSecret names no `property`.
    defaultField: env.DEFAULT_FIELD || 'value',
    // ESO refreshes every hour by default; a minute of caching only spares
    // Proton the bursts of a resync, and it never outlives a rotation by much.
    cacheSeconds: intFrom(env, 'CACHE_SECONDS', 60),
    // Proton ends a PAT session after two hours. Logging in again a little
    // before that avoids the one failed request that would otherwise find out.
    sessionMinutes: intFrom(env, 'SESSION_MINUTES', 100, 1),
    // Per pass-cli call. A read is at most login + view + login + view, so
    // the default keeps one read inside ESO's 30 s webhook timeout in the
    // common case of one call.
    commandTimeoutMs: intFrom(env, 'COMMAND_TIMEOUT_MS', 20_000, 1000),
  };
}
