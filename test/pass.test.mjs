import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { createPass, classify, NotFound, NoVault, Upstream, Aborted } from '../src/pass.mjs';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, TOKEN } from './helpers.mjs';

/** A Proton client against a fresh fake, with an adjustable clock. */
function setup(state) {
  const box = sandbox(state);
  const clock = { t: 1_000_000 };
  const pass = createPass(loadConfig(box.env), box.env, () => clock.t);
  return { ...box, pass, clock };
}

test('config refuses a short bridge token and a missing PAT', () => {
  const box = sandbox();
  assert.throws(() => loadConfig({ ...box.env, BRIDGE_TOKEN: 'short' }), /BRIDGE_TOKEN/);
  assert.throws(() => loadConfig({ ...box.env, PROTON_PASS_PERSONAL_ACCESS_TOKEN: '' }), /PERSONAL_ACCESS_TOKEN/);
  assert.throws(() => loadConfig({ ...box.env, CACHE_SECONDS: '-1' }), /CACHE_SECONDS/);
  assert.throws(() => loadConfig({ ...box.env, COMMAND_TIMEOUT_MS: '0' }), /COMMAND_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ ...box.env, VAULT_PREFIX: '' }), /VAULT_PREFIX/);
  assert.throws(() => loadConfig({ ...box.env, BRIDGE_TOKEN_FILE: '/nonexistent/token' }), /does not exist/);
  const config = loadConfig(box.env);
  assert.equal(config.vaultPrefix, 'k8s-');
  assert.equal(config.defaultField, 'value');
  assert.equal(config.token, TOKEN);
  assert.equal('pat' in config, false, 'the PAT must not travel in the config object');
  assert.throws(() => loadConfig({ ...box.env, PROTON_PASS_SESSION_DIR: 'relative/dir' }), /SESSION_DIR/);
  assert.throws(() => loadConfig({ ...box.env, PROTON_PASS_SESSION_DIR: undefined }), /SESSION_DIR/);
});

test('a session left behind by an earlier run does not break the login', async () => {
  const box = sandbox();
  // What pass-cli 2.4.2 leaves after its own logout: a session.json that no
  // longer matches any key.
  mkdirSync(join(box.env.PROTON_PASS_SESSION_DIR, '.session'), { recursive: true });
  writeFileSync(join(box.env.PROTON_PASS_SESSION_DIR, '.session', 'session.json'), 'stale');
  const pass = createPass(loadConfig(box.env), box.env);
  assert.equal(await pass.read('k8s-aemtli', 'anthropic', 'value'), 'sk-test-1');
  assert.equal(readFileSync(join(box.env.PROTON_PASS_SESSION_DIR, '.session', 'session.json'), 'utf8'), 'fresh');
});

test('reads a field, logging in first, with the PAT seen only by login', async () => {
  const { pass, calls } = setup();
  assert.equal(pass.ready, false);
  assert.equal(await pass.read('k8s-aemtli', 'anthropic', 'value'), 'sk-test-1');
  assert.equal(pass.ready, true);
  const log = calls();
  assert.deepEqual(log.map(c => c.args[0]), ['login', 'item']);
  for (const c of log) {
    assert.equal(c.hasPat, c.args[0] === 'login', `PAT exposure on ${c.args[0]}`);
    assert.equal(c.hasBridgeToken, false, `bridge token exposure on ${c.args[0]}`);
  }
});

test('strips exactly the newline the CLI adds, not one the value carries', async () => {
  const { pass } = setup();
  assert.equal(await pass.read('k8s-aemtli', 'pem', 'value'), '-----KEY-----\n');
  assert.equal(await pass.read('k8s-aemtli', 'anthropic', 'note'), 'two\nlines');
});

test('a missing item, field or vault is a typed error, not a retry', async () => {
  const { pass, calls } = setup();
  await assert.rejects(pass.read('k8s-aemtli', 'nope', 'value'), NotFound);
  await assert.rejects(pass.read('k8s-aemtli', 'anthropic', 'nope'), NotFound);
  await assert.rejects(pass.read('k8s-missing', 'anthropic', 'value'), NoVault);
  assert.equal(calls().filter(c => c.args[0] === 'login').length, 1, 'recognised errors must not cause a new login');
});

test('an unrecognised failure gets one fresh login and one retry', async () => {
  const { pass, readState } = setup({ ...sandbox().readState(), expireAfterReads: 1 });
  assert.equal(await pass.read('k8s-aemtli', 'anthropic', 'value'), 'sk-test-1');
  // The second read finds the session gone, logs in again and succeeds.
  assert.equal(await pass.read('k8s-aemtli', 'anthropic', 'value'), 'sk-test-1');
  assert.equal(readState().logins, 2);
});

test('logs in again once the session is older than SESSION_MINUTES', async () => {
  const { pass, clock, readState } = setup();
  await pass.read('k8s-aemtli', 'anthropic', 'value');
  clock.t += 99 * 60_000;
  await pass.read('k8s-aemtli', 'anthropic', 'value');
  assert.equal(readState().logins, 1, 'still inside the session');
  clock.t += 2 * 60_000;
  await pass.read('k8s-aemtli', 'anthropic', 'value');
  assert.equal(readState().logins, 2, 'past 100 minutes');
});

test('a failed login is reported and leaves the client not ready', async () => {
  const { pass, patchState } = setup();
  patchState({ loginFails: 'Invalid personal access token' });
  await assert.rejects(pass.login(), err => err instanceof Upstream && /Invalid personal access token/.test(err.message));
  assert.equal(pass.ready, false);
});

test('concurrent reads all complete, one CLI call at a time', async () => {
  const { pass } = setup();
  const values = await Promise.all([
    pass.read('k8s-aemtli', 'anthropic', 'value'),
    pass.read('k8s-other', 'anthropic', 'value'),
    pass.read('k8s-aemtli', 'anthropic', 'note'),
  ]);
  assert.deepEqual(values, ['sk-test-1', 'sk-other', 'two\nlines']);
});

test('a rejected task does not stall the queue', async () => {
  const { pass } = setup();
  await assert.rejects(pass.read('k8s-aemtli', 'nope', 'value'), NotFound);
  assert.equal(await pass.read('k8s-aemtli', 'anthropic', 'value'), 'sk-test-1');
});

test('classify knows the CLI messages and nothing else', () => {
  assert.ok(classify('Error: No item found with title: x') instanceof NotFound);
  assert.ok(classify('Error: Field does not exist: y') instanceof NotFound);
  assert.ok(classify('Error: Error finding vault [v]: Could not find vault v') instanceof NoVault);
  // The same prefix wraps a dead session; that one must get a fresh login.
  assert.equal(classify('Error: Error finding vault [v]: Error listing vaults'), null);
  assert.equal(classify('Error: Unauthorized'), null);
  assert.equal(classify(''), null);
  // A tracing line before the error does not hide it.
  assert.ok(classify('2026-10-11 ERROR pass::api: 422\nError: No item found with title: x') instanceof NotFound);
});

test('secrets can come from files, which are read again at each login', async () => {
  const box = sandbox();
  const tokenFile = join(box.dir, 'token');
  const patFile = join(box.dir, 'pat');
  writeFileSync(tokenFile, `${TOKEN}\n`);
  writeFileSync(patFile, 'wrong-token\n');
  const env = { ...box.env, BRIDGE_TOKEN: '', BRIDGE_TOKEN_FILE: tokenFile, PROTON_PASS_PERSONAL_ACCESS_TOKEN: '', PROTON_PASS_PERSONAL_ACCESS_TOKEN_FILE: patFile };
  const config = loadConfig(env);
  assert.equal(config.token, TOKEN, 'trimmed');
  const pass = createPass(config, env);
  await assert.rejects(pass.login(), /Invalid personal access token/);
  // A rotated Secret updates the mounted file; the next login uses it.
  writeFileSync(patFile, `${box.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN}\n`);
  await pass.login();
  assert.equal(pass.ready, true);
  assert.equal(box.calls().every(c => c.args[0] === 'login' || !c.hasPat), true);
});

test('an item title that starts with a dash stays a title', async () => {
  const { pass, calls } = setup();
  assert.equal(await pass.read('k8s-aemtli', '-dash', 'value'), 'dash-value');
  const view = calls().find(c => c.args[0] === 'item').args;
  assert.ok(view.includes('--item-title=-dash'), view.join(' '));
});

test('a forced login for an unknown failure happens at most once a minute', async () => {
  const { pass, patchState, readState, clock } = setup();
  await pass.read('k8s-aemtli', 'anthropic', 'value');
  patchState({ expireAfterReads: 0, session: false });
  // The first unknown failure logs in again and succeeds.
  patchState({ expireAfterReads: 1 });
  assert.equal(await pass.read('k8s-aemtli', 'anthropic', 'value'), 'sk-test-1');
  const logins = readState().logins;
  // Within the minute, another unknown failure is reported, not retried.
  patchState({ session: false });
  await assert.rejects(pass.read('k8s-aemtli', 'anthropic', 'value'), Upstream);
  assert.equal(readState().logins, logins);
  clock.t += 61_000;
  assert.equal(await pass.read('k8s-aemtli', 'anthropic', 'value'), 'sk-test-1');
  assert.equal(readState().logins, logins + 1);
});

test('a caller that went away skips its turn', async () => {
  const { pass, calls } = setup();
  const gone = new AbortController();
  gone.abort();
  await assert.rejects(pass.read('k8s-aemtli', 'anthropic', 'value', { signal: gone.signal }), Aborted);
  assert.equal(calls().length, 0);
});

test('a missing binary surfaces as an upstream error', async () => {
  const box = sandbox();
  const env = { ...box.env, PASS_CLI: '/nonexistent/pass-cli' };
  const pass = createPass(loadConfig(env), env);
  await assert.rejects(pass.read('k8s-aemtli', 'anthropic', 'value'), Upstream);
});
