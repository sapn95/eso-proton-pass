// The only part that talks to Proton: a thin wrapper around `pass-cli`.
//
// pass-cli prints a field's value followed by one newline, and reports every
// failure as exit code 1 with a sentence on stderr. So the sentence is what
// tells "no such item" apart from "the session ran out", and the patterns
// below are the ones the CLI printed when this was written (2.4.2).
import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

/** The item, or the field on it, does not exist. ESO reads 404 as "deleted". */
export class NotFound extends Error {}

/** The vault for a namespace is missing or the token was never granted it. */
export class NoVault extends Error {}

/** Proton or the CLI failed in a way the caller cannot fix by asking again. */
export class Upstream extends Error {}

const NOT_FOUND = [/no item found/i, /field does not exist/i];
const NO_VAULT = [/could not find vault/i, /error finding vault/i];

/** First non-empty line of a CLI message, for logs and error replies. */
function firstLine(text) {
  return String(text).split('\n').map(l => l.trim()).find(Boolean) ?? 'no message';
}

/** Maps a stderr text to one of the error classes, or null if unknown. */
export function classify(stderr) {
  const line = firstLine(stderr);
  if (NOT_FOUND.some(re => re.test(line))) return new NotFound(line);
  if (NO_VAULT.some(re => re.test(line))) return new NoVault(line);
  return null;
}

/**
 * Runs pass-cli without a shell. Resolves with the exit code and both
 * streams and never rejects: a timeout or a missing binary is a failure
 * like any other, reported through `code` and `stderr`.
 */
function run(bin, args, env, timeoutMs) {
  return new Promise(resolve => {
    execFile(bin, args, { env, timeout: timeoutMs, maxBuffer: 1 << 20, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const code = typeof err.code === 'number' ? err.code : 1;
      resolve({ code, stdout: stdout ?? '', stderr: stderr || err.message });
    });
  });
}

/**
 * Creates the Proton client.
 *
 * `env` is the process environment. The personal access token is taken out
 * of it here and handed only to `pass-cli login`; every other call runs
 * without it, so a field read cannot leak it through a child's environment.
 * `now` is injectable for the session-age tests.
 */
export function createPass(config, env = process.env, now = Date.now) {
  const { passCli, commandTimeoutMs, sessionMinutes } = config;
  const pat = env.PROTON_PASS_PERSONAL_ACCESS_TOKEN;
  const base = { ...env };
  delete base.PROTON_PASS_PERSONAL_ACCESS_TOKEN;
  delete base.BRIDGE_TOKEN;

  let loggedInAt = 0;
  let queue = Promise.resolve();

  /** Runs `task` after every earlier one: all calls share one session directory. */
  function serial(task) {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
  }

  /**
   * Logs in with the token, after removing whatever session is left over.
   *
   * Not with `pass-cli logout`: with the filesystem key provider, 2.4.2
   * deletes local.key and the database but fails to remove session.json
   * ("Directory not empty"), and the next login then writes a new key that
   * cannot decrypt the old session.json. Every later command fails with
   * "Error getting client". Removing the directory leaves nothing to trip on.
   */
  async function login() {
    rmSync(join(config.sessionDir, '.session'), { recursive: true, force: true });
    const r = await run(passCli, ['login'], { ...base, PROTON_PASS_PERSONAL_ACCESS_TOKEN: pat }, commandTimeoutMs);
    if (r.code !== 0) {
      loggedInAt = 0;
      throw new Upstream(`login failed: ${firstLine(r.stderr)}`);
    }
    loggedInAt = now();
  }

  /** Logs in when there is no session yet or the current one is near its end. */
  async function ensureSession() {
    if (!loggedInAt || now() - loggedInAt >= sessionMinutes * 60_000) await login();
  }

  /** One `item view` call for a single field. */
  function view(vault, item, field) {
    return run(passCli, ['item', 'view', '--vault-name', vault, '--item-title', item, '--field', field], base, commandTimeoutMs);
  }

  /**
   * Reads one field. A failure the patterns do not recognise is most likely
   * an expired or revoked session, so it gets one fresh login and one retry
   * before it is reported.
   */
  function read(vault, item, field) {
    return serial(async () => {
      await ensureSession();
      let r = await view(vault, item, field);
      if (r.code !== 0 && !classify(r.stderr)) {
        await login();
        r = await view(vault, item, field);
      }
      // Exactly the one newline the CLI appends; a value that itself ends in
      // a newline (a PEM key, say) keeps its own.
      if (r.code === 0) return r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout;
      throw classify(r.stderr) ?? new Upstream(firstLine(r.stderr));
    });
  }

  return {
    read,
    login: () => serial(login),
    /** Whether a login has succeeded and not failed since. */
    get ready() { return loggedInAt > 0; },
  };
}
