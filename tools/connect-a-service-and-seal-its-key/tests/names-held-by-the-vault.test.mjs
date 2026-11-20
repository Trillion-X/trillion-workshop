import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  credentialHome,
  fieldNamesHeldByTheVault,
  heldByTheVault,
  namesHeldByTheVault,
} from '../read-data/ask-the-vault-for-one-secret.mjs';

const standIn = fileURLToPath(new URL('./fixtures/stand-in-vault-command.mjs', import.meta.url));
const ACCOUNT = 'a'.repeat(64);
const HOME = {
  command: standIn, command_setting: 'STAND_IN_VAULT_COMMAND', store: '/stand-in/held.sqlite',
  state_from: { home_file: 'App Settings/runtime.json', field: 'state' },
  account_from: { state_file: 'restore-receipt.json', pointer: '/account/ownerId' },
};

/**
 * A product DATA folder whose credential-home.json points at the stand-in command, named by PRODUCT_DATA_ROOT, and a
 * user home whose app settings name a state folder holding the selected account's owner id.
 */
function withStandIn(run, home = HOME) {
  const folder = tempFolder(join(tmpdir(), 'vault-reader-'));
  writeFileSync(join(folder, 'credential-home.json'), JSON.stringify(home));
  const user = join(folder, 'user');
  const state = join(folder, 'state');
  mkdirSync(join(user, 'App Settings'), { recursive: true });
  mkdirSync(state);
  writeFileSync(join(user, 'App Settings', 'runtime.json'), JSON.stringify({ state }));
  writeFileSync(join(state, 'restore-receipt.json'), JSON.stringify({ account: { ownerId: ACCOUNT } }));
  const asked = join(folder, 'asked.txt');
  const keys = ['HOME', 'PRODUCT_DATA_ROOT', 'STAND_IN_VAULT_ASKED', HOME.command_setting, 'CREDENTIAL_HOME_COMMAND', 'STAND_IN_VAULT_WHERE', 'STAND_IN_VAULT_WHERE_REFUSED', 'STAND_IN_VAULT_SETTINGS'];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.HOME = user;
  process.env.PRODUCT_DATA_ROOT = folder;
  process.env.STAND_IN_VAULT_ASKED = asked;
  delete process.env[HOME.command_setting];
  for (const key of ['CREDENTIAL_HOME_COMMAND', 'STAND_IN_VAULT_WHERE', 'STAND_IN_VAULT_WHERE_REFUSED', 'STAND_IN_VAULT_SETTINGS']) delete process.env[key];
  const operations = () => readFileSync(asked, 'utf8').trim().split('\n').map((line) => line.split(' ').slice(1, 4));
  return Promise.resolve(run({ operations, folder, user, state })).finally(() => {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  });
}

test('the home comes from the product DATA folder, and a launch setting can name another command', () => withStandIn(({ folder }) => {
  assert.deepEqual(credentialHome(), {
    command: standIn, commandFrom: `${join(folder, 'credential-home.json')} command`, commandSetting: 'STAND_IN_VAULT_COMMAND',
    store: HOME.store, account: ACCOUNT, verb: undefined, settings: undefined,
  });
  process.env.STAND_IN_VAULT_COMMAND = '/another/build';
  assert.equal(credentialHome().command, '/another/build');
  assert.equal(credentialHome().commandFrom, 'the launch setting STAND_IN_VAULT_COMMAND');
}));

test('a bare store name is that file in the state folder the app names inside the user\'s home', () => withStandIn(async ({ operations, user, state }) => {
  assert.equal(credentialHome().store, join(state, 'held.sqlite'));
  assert.deepEqual(await namesHeldByTheVault(), ['bare-token', 'service-a']);
  assert.deepEqual(operations(), [[join(state, 'held.sqlite'), ACCOUNT, 'names-only']]);
  writeFileSync(join(user, 'App Settings', 'runtime.json'), JSON.stringify({ state: 'relative' }));
  assert.throws(() => credentialHome(), /names the store held\.sqlite in a state folder, and .*runtime\.json names none/);
}, { ...HOME, store: 'held.sqlite' }));

test('the account is the owner id at the pointer in the state folder, and no product DATA names a person', () => withStandIn(({ state }) => {
  assert.equal(credentialHome().account, ACCOUNT);
  writeFileSync(join(state, 'restore-receipt.json'), JSON.stringify({ account: {} }));
  assert.throws(() => credentialHome(), /restore-receipt\.json holds no account at \/account\/ownerId/);
}));

test('a home that names no account_from is refused', () => withStandIn(() => {
  assert.throws(() => credentialHome(), /does not name the account \(account_from: \{state_file, pointer\}\)/);
}, { ...HOME, account_from: undefined }));

test('names come from the names answer alone, with no read of any value', () => withStandIn(async ({ operations }) => {
  assert.deepEqual(await namesHeldByTheVault(), ['bare-token', 'service-a']);
  assert.deepEqual(operations(), [[HOME.store, ACCOUNT, 'names-only']]);
}));

test('field names carry no value, and a bare value keeps no fields', () => withStandIn(async ({ operations }) => {
  const fields = await fieldNamesHeldByTheVault('service-a');
  assert.deepEqual(fields, ['application-key', 'key-id']);
  assert.equal(JSON.stringify(fields).includes('private'), false);
  assert.deepEqual(await fieldNamesHeldByTheVault('bare-token'), []);
  assert.deepEqual(operations().map((asked) => asked[2]), ['describe', 'describe']);
}));

test('the CLI filters the metadata names before inspecting any holder', () => withStandIn(({ folder }) => {
  const command = fileURLToPath(new URL('../read-data/list-the-vault-names.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [command, '^service-a$'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'service-a: key-id, application-key\n');
  const asked = readFileSync(join(folder, 'asked.txt'), 'utf8').trim().split('\n');
  assert.equal(asked.length, 2);
  assert.ok(asked[0].endsWith(' names-only'));
  assert.ok(asked[1].endsWith(' describe service-a'));
  assert.equal(asked.some((line) => line.endsWith(' bare-token')), false);
}));

test('a value arrives only through the private pipe', () => withStandIn(async ({ operations }) => {
  assert.deepEqual(await heldByTheVault('service-a'), { 'key-id': 'public', 'application-key': 'private' });
  assert.equal(await heldByTheVault('bare-token'), 'private');
  assert.deepEqual(operations().map((asked) => asked[2]), ['read', 'read']);
}));

test('a failure names what it checked', () => withStandIn(async () => {
  await assert.rejects(heldByTheVault('not-held'), (error) => {
    for (const part of [standIn, HOME.store, ACCOUNT, 'no value is held under not-held']) assert.ok(error.message.includes(part), part);
    return true;
  });
  process.env.STAND_IN_VAULT_COMMAND = '/nonexistent/vault-command';
  await assert.rejects(namesHeldByTheVault(), /checked the command \/nonexistent\/vault-command \(from the launch setting STAND_IN_VAULT_COMMAND\).*it did not start: ENOENT/);
  delete process.env.PRODUCT_DATA_ROOT;
  await assert.rejects(namesHeldByTheVault(), /the launch setting PRODUCT_DATA_ROOT names no product DATA folder holding credential-home\.json/);
  process.env.PRODUCT_DATA_ROOT = '/nonexistent/product';
  await assert.rejects(namesHeldByTheVault(), /\/nonexistent\/product\/credential-home\.json \(from PRODUCT_DATA_ROOT\) could not be read: ENOENT/);
}));

const resolvedHome = folder => ({
  command: standIn, verb: 'secrets', store: join(folder, 'resolved.sqlite'), account: ACCOUNT,
  settings: { setting: 'FIXTURE_PRODUCT_SETTINGS', file: join(folder, 'product-settings.json') },
});

test('native metadata selects the home without a product DATA folder and binds settings to private reads', () => withStandIn(async ({ folder }) => {
  const home = resolvedHome(folder);
  process.env.CREDENTIAL_HOME_COMMAND = standIn;
  process.env.STAND_IN_VAULT_WHERE = JSON.stringify(home);
  process.env.STAND_IN_VAULT_SETTINGS = home.settings.file;
  delete process.env.PRODUCT_DATA_ROOT;
  assert.deepEqual(credentialHome(), {
    ...home, commandFrom: 'the launch setting CREDENTIAL_HOME_COMMAND', commandSetting: 'CREDENTIAL_HOME_COMMAND',
  });
  assert.deepEqual(await namesHeldByTheVault(), ['bare-token', 'service-a']);
  assert.equal(await heldByTheVault('bare-token'), 'private');
  const asked = readFileSync(join(folder, 'asked.txt'), 'utf8').trim().split('\n');
  assert.deepEqual(asked.filter(line => line === 'secrets where'), ['secrets where', 'secrets where', 'secrets where']);
  assert.ok(asked.includes(`secrets ${home.store} ${ACCOUNT} names-only`));
  assert.ok(asked.includes(`secrets ${home.store} ${ACCOUNT} read bare-token`));
}));

test('failed or malformed native metadata never falls back to the valid legacy home', () => withStandIn(({ folder }) => {
  process.env.CREDENTIAL_HOME_COMMAND = standIn;
  process.env.STAND_IN_VAULT_WHERE_REFUSED = 'yes';
  assert.throws(() => credentialHome(), /secrets where did not answer.*metadata discovery/);
  delete process.env.STAND_IN_VAULT_WHERE_REFUSED;
  process.env.STAND_IN_VAULT_WHERE = 'not JSON';
  assert.throws(() => credentialHome(), /did not return metadata JSON/);
  for (const change of [{ command: '/another/command' }, { store: 'relative' }, { account: '' }, { settings: { setting: 'BAD-NAME', file: '/settings' } }]) {
    process.env.STAND_IN_VAULT_WHERE = JSON.stringify({ ...resolvedHome(folder), ...change });
    assert.throws(() => credentialHome(), /incomplete or inconsistent metadata/);
  }
  assert.ok(readFileSync(join(folder, 'asked.txt'), 'utf8').trim().split('\n').every(line => line === 'secrets where'));
}));

test('an explicit native selector must name an absolute command', () => withStandIn(() => {
  for (const command of ['', 'relative-command']) {
    process.env.CREDENTIAL_HOME_COMMAND = command;
    assert.throws(() => credentialHome(), /CREDENTIAL_HOME_COMMAND must name an absolute command/);
  }
}));

test('the writer uses the same native metadata and settings without printing its synthetic value', () => withStandIn(({ folder }) => {
  const home = resolvedHome(folder);
  process.env.CREDENTIAL_HOME_COMMAND = standIn;
  process.env.STAND_IN_VAULT_WHERE = JSON.stringify(home);
  process.env.STAND_IN_VAULT_SETTINGS = home.settings.file;
  delete process.env.PRODUCT_DATA_ROOT;
  const valueFile = join(folder, 'synthetic-input.json');
  const value = 'synthetic-value-not-for-output';
  writeFileSync(valueFile, JSON.stringify({ token: value }));
  const command = fileURLToPath(new URL('../do-work/put-one-secret-in-the-vault.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [command, '--name', 'synthetic-holder', '--from-file', valueFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { saved: 'synthetic-holder', use_it_by_name: 'synthetic-holder' });
  assert.equal(`${result.stdout}${result.stderr}`.includes(value), false);
  assert.deepEqual(readFileSync(join(folder, 'asked.txt'), 'utf8').trim().split('\n'), [
    'secrets where', `secrets ${home.store} ${ACCOUNT} put synthetic-holder`,
  ]);
}));

test('the metadata CLI calls only native where and leaves failures without a partial answer', () => withStandIn(({ folder }) => {
  const home = resolvedHome(folder);
  process.env.CREDENTIAL_HOME_COMMAND = standIn;
  process.env.STAND_IN_VAULT_WHERE = JSON.stringify(home);
  delete process.env.PRODUCT_DATA_ROOT;
  const command = fileURLToPath(new URL('../read-data/ask-the-vault-for-one-secret.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [command, 'where'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).store, home.store);
  assert.deepEqual(JSON.parse(result.stdout).settings, home.settings);
  process.env.STAND_IN_VAULT_WHERE_REFUSED = 'yes';
  const refused = spawnSync(process.execPath, [command, 'where'], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /metadata discovery/);
  assert.deepEqual(readFileSync(join(folder, 'asked.txt'), 'utf8').trim().split('\n'), ['secrets where', 'secrets where']);
}));

test('the command refuses a value read to a regular file and emits no synthetic value', () => withStandIn(({ folder }) => {
  const target = join(folder, 'not-a-private-pipe');
  const descriptor = openSync(target, 'wx');
  let result;
  try {
    result = spawnSync(standIn, ['held-values', HOME.store, ACCOUNT, 'read', 'bare-token'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', descriptor],
    });
  } finally { closeSync(descriptor); }
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /descriptor 3 is not a pipe/);
  assert.equal(result.stderr.includes('private'), false);
  assert.equal(readFileSync(target, 'utf8'), '');
}));

test('the writer propagates a failed input read without a saved answer', () => withStandIn(({ folder }) => {
  const home = resolvedHome(folder);
  process.env.CREDENTIAL_HOME_COMMAND = standIn;
  process.env.STAND_IN_VAULT_WHERE = JSON.stringify(home);
  process.env.STAND_IN_VAULT_SETTINGS = home.settings.file;
  const command = fileURLToPath(new URL('../do-work/put-one-secret-in-the-vault.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [command, '--name', 'synthetic-holder', '--from-file',
    join(folder, 'never-created-input.json')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /the vault did not answer put synthetic-holder/);
  assert.equal(result.stderr.includes('synthetic-value-not-for-output'), false);
}));
