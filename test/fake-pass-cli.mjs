#!/usr/bin/env node
// A stand-in for pass-cli, driven by a JSON state file. It answers the four
// commands the bridge uses with the same exit codes and messages the real
// CLI printed (2.4.2), and logs every call so a test can check what was run
// and with which environment.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const statePath = process.env.FAKE_PASS_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);

appendFileSync(process.env.FAKE_PASS_LOG, JSON.stringify({
  args,
  hasPat: 'PROTON_PASS_PERSONAL_ACCESS_TOKEN' in process.env,
  hasBridgeToken: 'BRIDGE_TOKEN' in process.env,
}) + '\n');

/** Persists the state for the next invocation. */
function save() {
  writeFileSync(statePath, JSON.stringify(state));
}

/** Exits the way pass-cli does on any error. */
function fail(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

/**
 * The value of a flag, in either form clap accepts: `--name=value` or
 * `--name value`. Like clap, the second form refuses a value that starts
 * with a dash (exit 2), which is the injection the bridge must not allow.
 */
function flag(name) {
  const joined = args.find(a => a.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  const value = args[args.indexOf(name) + 1];
  if (value === undefined || value.startsWith('-')) {
    process.stderr.write(`error: a value is required for '${name} <VALUE>' but none was supplied\n`);
    process.exit(2);
  }
  return value;
}

const [command, sub] = args;

// Like the real CLI, the session lives in PROTON_PASS_SESSION_DIR/.session.
// A stale one (a session.json reading "stale") breaks every command until it
// is removed, which is what pass-cli 2.4.2 leaves after its own logout.
const sessionFile = join(process.env.PROTON_PASS_SESSION_DIR, '.session', 'session.json');
if (existsSync(sessionFile) && readFileSync(sessionFile, 'utf8') === 'stale') fail('Error getting client');

if (command === 'login') {
  // Fails `loginFailsTimes` times (or forever with loginFails), then works.
  if (state.loginFailsTimes > 0) {
    state.loginFailsTimes -= 1;
    save();
    fail('Proton is down for maintenance');
  }
  if (state.loginFails) fail(state.loginFails);
  if (process.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN !== state.pat) fail('Invalid personal access token');
  mkdirSync(join(process.env.PROTON_PASS_SESSION_DIR, '.session'), { recursive: true });
  writeFileSync(sessionFile, 'fresh');
  state.session = true;
  state.reads = 0;
  state.logins = (state.logins ?? 0) + 1;
  save();
  process.exit(0);
}

if (command === 'item' && sub === 'view') {
  if (!state.session) fail(`Error finding vault [${flag('--vault-name')}]: Error listing vaults`);
  // Simulates the two-hour PAT session running out after N reads.
  if (state.expireAfterReads !== undefined && state.reads >= state.expireAfterReads) {
    state.session = false;
    save();
    fail(`Error finding vault [${flag('--vault-name')}]: Error listing vaults`);
  }
  const vaultName = flag('--vault-name');
  const vault = state.vaults[vaultName];
  if (!vault) fail(`Error finding vault [${vaultName}]: Could not find vault ${vaultName}`);
  const item = vault[flag('--item-title')];
  if (!item) fail(`No item found with title: ${flag('--item-title')}`);
  const field = flag('--field');
  if (!(field in item)) fail(`Field does not exist: ${field}`);
  state.reads += 1;
  save();
  process.stdout.write(`${item[field]}\n`);
  process.exit(0);
}

fail(`unknown command: ${args.join(' ')}`);
