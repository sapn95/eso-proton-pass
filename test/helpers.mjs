// Shared set-up: a fake pass-cli with its own state file and call log in a
// fresh temporary directory per test.
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_CLI = join(here, 'fake-pass-cli.mjs');
chmodSync(FAKE_CLI, 0o755);

// Test values are built at run time, so no literal here looks like a token.
export const PAT = ['pst', 'test'.repeat(4)].join('_') + '::' + 'k'.repeat(16);
export const TOKEN = 'b'.repeat(40);

/** The state every test starts from: one vault for namespace "aemtli". */
export function defaultState() {
  return {
    pat: PAT,
    session: false,
    vaults: {
      'k8s-aemtli': {
        anthropic: { value: 'sk-test-1', note: 'two\nlines' },
        pem: { value: '-----KEY-----\n' },
      },
      'k8s-other': { anthropic: { value: 'sk-other' } },
    },
  };
}

/**
 * Creates a sandbox and returns the env the bridge should run with, plus
 * helpers to read and change the fake's state and to read its call log.
 */
export function sandbox(state = defaultState()) {
  const dir = mkdtempSync(join(tmpdir(), 'eso-proton-pass-'));
  const statePath = join(dir, 'state.json');
  const logPath = join(dir, 'calls.jsonl');
  writeFileSync(statePath, JSON.stringify(state));
  const env = {
    PATH: process.env.PATH,
    PROTON_PASS_SESSION_DIR: join(dir, 'session'),
    FAKE_PASS_STATE: statePath,
    FAKE_PASS_LOG: logPath,
    PROTON_PASS_PERSONAL_ACCESS_TOKEN: PAT,
    BRIDGE_TOKEN: TOKEN,
    PASS_CLI: FAKE_CLI,
  };
  return {
    env,
    dir,
    readState: () => JSON.parse(readFileSync(statePath, 'utf8')),
    patchState: patch => writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), ...patch })),
    calls: () => existsSync(logPath)
      ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [],
  };
}
