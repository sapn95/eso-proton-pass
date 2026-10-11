import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepLoggedIn } from '../src/keepalive.mjs';

/** A stand-in client whose login fails `failures` times and whose session can be dropped. */
function fakePass(failures) {
  const pass = {
    ready: false,
    logins: 0,
    async login() {
      pass.logins += 1;
      if (failures-- > 0) throw new Error('Proton is down');
      pass.ready = true;
    },
  };
  return pass;
}

test('keeps trying with a growing pause, and comes back after a later failure', async () => {
  const pass = fakePass(3);
  const stop = new AbortController();
  const pauses = [];
  const lines = [];
  let checks = 0;
  const sleep = async ms => {
    pauses.push(ms);
    if (ms === 30_000) {
      checks += 1;
      // After the first good login, the session is lost once (a failed
      // refresh); the loop has to notice and log in again by itself.
      if (checks === 1) pass.ready = false;
      if (checks === 2) stop.abort();
    }
  };
  await keepLoggedIn(pass, { log: l => lines.push(l), signal: stop.signal, sleep });
  assert.deepEqual(pauses.slice(0, 3), [2000, 4000, 8000]);
  assert.equal(pass.logins, 5, 'three failures, a login, and the one after the lost session');
  assert.equal(lines.filter(l => l === 'logged in to Proton Pass').length, 2);
});

test('the pause stops growing at five minutes', async () => {
  const pass = fakePass(20);
  const stop = new AbortController();
  const pauses = [];
  await keepLoggedIn(pass, { log: () => {}, signal: stop.signal, sleep: async ms => { pauses.push(ms); if (pauses.length === 12) stop.abort(); } });
  assert.equal(Math.max(...pauses), 300_000);
});

test('the default pause ends early when the signal fires', async () => {
  const pass = { ready: true, login: async () => {} };
  const stop = new AbortController();
  const started = Date.now();
  setTimeout(() => stop.abort(), 50);
  await keepLoggedIn(pass, { log: () => {}, signal: stop.signal, checkMs: 60_000 });
  assert.ok(Date.now() - started < 5000);
});
