import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { createPass } from '../src/pass.mjs';
import { startServer } from '../src/server.mjs';
import { connect } from 'node:net';
import { sandbox, TOKEN, PAT } from './helpers.mjs';

/**
 * Starts the bridge on an ephemeral port against a fresh fake, runs `body`
 * with a small client, and always closes the server.
 */
async function withBridge(body, { env: extra = {}, state } = {}) {
  const box = sandbox(state);
  const env = { ...box.env, PORT: '0', HOST: '127.0.0.1', ...extra };
  const config = loadConfig(env);
  const lines = [];
  const clock = { t: 5_000_000 };
  const pass = createPass(config, env, () => clock.t);
  const server = await startServer({ config, pass, log: l => lines.push(l), now: () => clock.t });
  const base = `http://127.0.0.1:${server.address().port}`;
  /** Requests a path, by default with the bearer token; returns status and JSON body. */
  const get = async (path, token = TOKEN, method = 'GET') => {
    const res = await fetch(base + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  try {
    await body({ get, lines, box, pass, clock, port: server.address().port });
  } finally {
    await new Promise(r => server.close(r));
  }
}

const q = (namespace, key, property) =>
  `/v1/secret?${new URLSearchParams({ namespace, key, ...(property ? { property } : {}) })}`;

test('health answers without a token; readiness waits for a login', () =>
  withBridge(async ({ get, pass }) => {
    assert.equal((await get('/healthz', null)).status, 200);
    assert.equal((await get('/readyz', null)).status, 503);
    await pass.login();
    assert.equal((await get('/readyz', null)).status, 200);
  }));

test('the secret endpoint wants the exact bearer token', () =>
  withBridge(async ({ get, box }) => {
    assert.equal((await get(q('aemtli', 'anthropic'), null)).status, 401);
    assert.equal((await get(q('aemtli', 'anthropic'), 'x'.repeat(40))).status, 401);
    assert.equal((await get(q('aemtli', 'anthropic'), TOKEN.slice(1))).status, 401);
    assert.equal(box.calls().length, 0, 'nothing reaches Proton without the token');
  }));

test('returns the value from the namespace vault, defaulting the field to "value"', () =>
  withBridge(async ({ get }) => {
    const res = await get(q('aemtli', 'anthropic'));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { value: 'sk-test-1' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await get(q('aemtli', 'anthropic', 'note'))).body, { value: 'two\nlines' });
  }));

test('a namespace only ever reaches its own vault', () =>
  withBridge(async ({ get }) => {
    assert.deepEqual((await get(q('other', 'anthropic'))).body, { value: 'sk-other' });
    // "aemtli" content is not reachable from a namespace without that name,
    // and a crafted namespace is not a namespace.
    assert.equal((await get(q('nosuch', 'anthropic'))).status, 403);
    assert.equal((await get(q('../k8s-aemtli', 'anthropic'))).status, 400);
    assert.equal((await get(q('Aemtli', 'anthropic'))).status, 400);
    assert.equal((await get(q('', 'anthropic'))).status, 400);
  }));

test('missing item or field is 404, an empty or oversized key is 400', () =>
  withBridge(async ({ get }) => {
    assert.equal((await get(q('aemtli', 'nope'))).status, 404);
    assert.equal((await get(q('aemtli', 'anthropic', 'nope'))).status, 404);
    assert.equal((await get('/v1/secret?namespace=aemtli')).status, 400);
    assert.equal((await get(q('aemtli', 'k'.repeat(257)))).status, 400);
    assert.equal((await get(q('aemtli', 'anthropic', 'p'.repeat(257)))).status, 400);
  }));

test('a Proton failure is 502 and its detail goes to the log, not the reply', () =>
  withBridge(async ({ get, box, lines }) => {
    box.patchState({ loginFails: 'Proton is down for maintenance' });
    const res = await get(q('aemtli', 'anthropic'));
    assert.equal(res.status, 502);
    assert.doesNotMatch(JSON.stringify(res.body), /maintenance/);
    assert.ok(lines.some(l => /maintenance/.test(l)));
  }));

test('a successful read is cached for CACHE_SECONDS and no longer', () =>
  withBridge(async ({ get, box, clock }) => {
    const reads = () => box.calls().filter(c => c.args[0] === 'item').length;
    await get(q('aemtli', 'anthropic'));
    await get(q('aemtli', 'anthropic'));
    assert.equal(reads(), 1);
    clock.t += 61_000;
    await get(q('aemtli', 'anthropic'));
    assert.equal(reads(), 2);
  }));

test('CACHE_SECONDS=0 turns the cache off', () =>
  withBridge(async ({ get, box }) => {
    await get(q('aemtli', 'anthropic'));
    await get(q('aemtli', 'anthropic'));
    assert.equal(box.calls().filter(c => c.args[0] === 'item').length, 2);
  }, { env: { CACHE_SECONDS: '0' } }));

test('logs name what was asked, never the value', () =>
  withBridge(async ({ get, lines }) => {
    await get(q('aemtli', 'anthropic'));
    const line = lines.find(l => l.startsWith('GET /v1/secret'));
    assert.match(line, /namespace="aemtli" key="anthropic" property=null -> 200/);
    assert.doesNotMatch(lines.join('\n'), /sk-test-1/);
  }));

test('unknown paths are 400 (never 404, which ESO reads as deleted) and other methods 405', () =>
  withBridge(async ({ get, box }) => {
    assert.equal((await get('/v2/secret')).status, 400);
    assert.equal((await get(q('aemtli', 'anthropic'), TOKEN, 'POST')).status, 405);
    assert.equal((await get(q('aemtli', 'anthropic'), TOKEN, 'DELETE')).status, 405);
    assert.equal(box.calls().length, 0);
  }));

test('control characters and an empty property are handled', () =>
  withBridge(async ({ get }) => {
    assert.equal((await get(q('aemtli', 'anthropic\u0000x'))).status, 400);
    assert.equal((await get(q('aemtli', 'anthropic', 'va\nlue'))).status, 400);
    assert.deepEqual((await get('/v1/secret?namespace=aemtli&key=anthropic&property=')).body, { value: 'sk-test-1' });
  }));

test('the cache keeps namespaces apart', () =>
  withBridge(async ({ get }) => {
    assert.deepEqual((await get(q('aemtli', 'anthropic'))).body, { value: 'sk-test-1' });
    assert.deepEqual((await get(q('other', 'anthropic'))).body, { value: 'sk-other' });
  }));

test('a malformed request target is a 400 and the server stays up', () =>
  withBridge(async ({ get, port }) => {
    const raw = await new Promise((resolve, reject) => {
      const s = connect(port, '127.0.0.1', () => s.write('GET //[/v1/secret HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let data = '';
      s.on('data', d => { data += d; });
      s.on('end', () => resolve(data));
      s.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 400/);
    assert.equal((await get('/healthz', null)).status, 200);
  }));

test('a failed login leaves the token out of replies and logs', () =>
  withBridge(async ({ get, lines, box }) => {
    box.patchState({ pat: 'some-other-token' });
    const res = await get(q('aemtli', 'anthropic'));
    assert.equal(res.status, 502);
    const everything = JSON.stringify(res.body) + lines.join('\n');
    assert.doesNotMatch(everything, new RegExp(PAT.slice(0, 12)));
  }));
