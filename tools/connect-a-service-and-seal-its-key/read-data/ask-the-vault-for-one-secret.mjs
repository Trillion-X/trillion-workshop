// The one way JavaScript asks the vault for a secret.
//
// WHY THIS EXISTS: secrets used to sit in a credentials-vault folder inside the home
// directory's .bitfield folder as plain JSON protected by nothing but file permissions, and
// every process that wanted one opened the file itself. Three of the autonomous-tick
// processes had three copies of the same telegram-bot.json lookup. Copies of a secret lookup
// are how a plaintext store survives forever: you can never delete the folder, because you
// can never find every reader.
//
// So there is one reader, here, beside the package that owns secret resolution. A caller
// names the holder and the field. It never learns a path, a port, or a handle format.
//
// WHERE THE VAULT IS: the held-values vault of the native engine (its src/held_values.rs),
// the same credentials-vault crate this package builds, sealed in
// one S2h record under a key derived from the Mac account key in the Keychain. Which
// command, store and account is a product fact, so it lives in the product's DATA home:
// `credential-home.json` in the folder the PRODUCT_DATA_ROOT launch setting names (the
// same setting the engine reads its product DATA through). This package names no product.
// It used to be a Bitfield engine found by a port scan; that
// engine stopped serving in September, and a scan that finds nothing reads as "no secret",
// which is how a present credential reads as an absent one.
// A launcher may instead select CREDENTIAL_HOME_COMMAND. Its `secrets where` metadata supplies the resolved home
// without opening a vault or reading a key. A failed selected command never falls back to the legacy DATA route.
//
// HOW A VALUE TRAVELS: the command mints a short-lived handle and resolves it inside its
// own process (the vault's audited read), then writes the value only to a private pipe on
// descriptor 3, which this process holds. It refuses when descriptor 3 is not a pipe or is
// the same pipe as standard output, so a value never lands in a terminal or a transcript.
// Names and field names come from the command's `names` answer, which carries no value.
//
// NO FALLBACK TO A FILE, DELIBERATELY. A fallback keeps the plaintext alive and quietly
// re-creates the thing this replaces. A secret that cannot be resolved must fail loudly,
// and the failure names what was checked.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCT_DATA_ROOT_SETTING = 'PRODUCT_DATA_ROOT';
const COMMAND_SETTING = 'CREDENTIAL_HOME_COMMAND';
const HOME_FILE = 'credential-home.json';
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 30_000;

/** Ask the selected native command for its resolved metadata. This operation opens no vault and reads no key. */
function nativeCredentialHome(command) {
  if (!isAbsolute(command)) throw new Error(`no credential home: ${COMMAND_SETTING} must name an absolute command`);
  const answer = spawnSync(command, ['secrets', 'where'], {
    env: process.env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_ANSWER_BYTES, timeout: METADATA_TIMEOUT_MS,
  });
  if (answer.error || answer.status !== 0) {
    const reason = answer.error?.code ?? `exit ${answer.status ?? answer.signal}`;
    throw new Error(`no credential home: ${command} secrets where did not answer (${reason}); the selected command must support metadata discovery`);
  }
  let home;
  try { home = JSON.parse(String(answer.stdout)); }
  catch { throw new Error(`no credential home: ${command} secrets where did not return metadata JSON`); }
  if (!home || typeof home !== 'object' || Array.isArray(home)
      || typeof home.command !== 'string' || !isAbsolute(home.command) || home.command !== command
      || typeof home.store !== 'string' || !isAbsolute(home.store)
      || typeof home.account !== 'string' || !home.account
      || typeof home.verb !== 'string' || !home.verb
      || typeof home.settings?.setting !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(home.settings.setting)
      || typeof home.settings?.file !== 'string' || !isAbsolute(home.settings.file)) {
    throw new Error(`no credential home: ${command} secrets where returned incomplete or inconsistent metadata`);
  }
  return {
    command: home.command, commandFrom: `the launch setting ${COMMAND_SETTING}`, commandSetting: COMMAND_SETTING,
    store: home.store, account: home.account, verb: home.verb, settings: home.settings,
  };
}

/**
 * The vault's store file. A path is that file. A bare file name is that file in the selected
 * account's state folder, which the product's app names in a settings file inside the user's
 * home (`state_from`: `{home_file, field}`), so the store moves with the account's state and
 * no product DATA holds a machine path.
 */
function storeOf(home, file) {
  if (home.store.includes('/')) return home.store;
  return join(stateFolderOf(home, file, `the store ${home.store}`), home.store);
}

/** The selected account's state folder, as the app's settings file inside the user's home names it (`state_from`). */
function stateFolderOf(home, file, what) {
  const settingsFile = home.state_from?.home_file ? join(homedir(), home.state_from.home_file) : null;
  let state;
  try {
    state = settingsFile ? JSON.parse(readFileSync(settingsFile, 'utf8'))[home.state_from.field] : undefined;
  } catch (error) {
    throw new Error(`no credential home: ${file} names ${what} in the state folder that ${settingsFile} names, and that file could not be read: ${error.code || error.message}`);
  }
  if (typeof state !== 'string' || !isAbsolute(state)) {
    throw new Error(`no credential home: ${file} names ${what} in a state folder, and ${settingsFile ?? 'no state_from file'} names none`);
  }
  return state;
}

/**
 * The account whose vault is asked. The product DATA names no person: `account_from` is
 * `{state_file, pointer}`, the JSON pointer into a file of the selected account's state folder
 * that holds its owner id (the engine reads the same id there).
 */
function accountOf(home, file) {
  const from = home.account_from;
  if (!from?.state_file || typeof from.pointer !== 'string') {
    throw new Error(`no credential home: ${file} does not name the account (account_from: {state_file, pointer})`);
  }
  const stateFile = join(stateFolderOf(home, file, 'the account'), from.state_file);
  let value;
  try {
    value = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (error) {
    throw new Error(`no credential home: ${file} names the account in ${stateFile}, and that file could not be read: ${error.code || error.message}`);
  }
  for (const part of from.pointer.split('/').slice(1)) value = value?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
  if (typeof value !== 'string' || !value) {
    throw new Error(`no credential home: ${stateFile} holds no account at ${from.pointer}`);
  }
  return value;
}

/**
 * Where the vault lives, as the product's DATA home declares it (`credential-home.json`:
 * command, store, account). The command can be named by the launch setting the record
 * names (a build of the engine that is not yet the installed one); the store and the
 * account cannot.
 */
export function credentialHome() {
  // A selected native command is authoritative. Failure never falls back to a guessed path or a different vault.
  if (process.env[COMMAND_SETTING] !== undefined) return nativeCredentialHome(process.env[COMMAND_SETTING]);
  const root = process.env[PRODUCT_DATA_ROOT_SETTING];
  if (!root) {
    throw new Error(`no credential home: the launch setting ${PRODUCT_DATA_ROOT_SETTING} names no product DATA folder holding ${HOME_FILE}`);
  }
  // The engine reads its product DATA through this same setting and refuses a path with `..` in it, so a relative
  // setting (as a caller run from a sibling checkout writes it) is resolved to the folder it names before the engine sees it.
  const file = join(resolve(root), HOME_FILE);
  let home;
  try {
    home = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`no credential home: ${file} (from ${PRODUCT_DATA_ROOT_SETTING}) could not be read: ${error.code || error.message}`);
  }
  // The DATA route names the engine the runtime selected, as a home-relative pointer it maintains (`command_from`), never a
  // copy of the engine pinned in an app bundle: a pinned copy answers with a stale vault layout.
  const pointed = home?.command_from?.home_file ? join(homedir(), home.command_from.home_file) : undefined;
  if (!(home?.command || pointed) || !home?.store) {
    throw new Error(`no credential home: ${file} does not name a command and a store`);
  }
  const named = home.command_setting ? process.env[home.command_setting] : undefined;
  return {
    command: named || pointed || home.command,
    commandFrom: named ? `the launch setting ${home.command_setting}` : pointed ? `${file} command_from` : `${file} command`,
    commandSetting: home.command_setting ?? null,
    store: storeOf(home, file),
    account: accountOf(home, file),
    verb: home.verb,
    settings: home.settings,
  };
}

/** One answer of the vault command: its standard output, and the private pipe when asked. */
export function askTheVault(words, { privatePipe = false } = {}) {
  const home = credentialHome();
  // The vault's command word and the product settings file it reads (beside the command, in its app) are product
  // facts in credential-home.json: `verb` (the engine renamed held-values to secrets on 2026-11-04, trillion-rust
  // 9fa0d5157) and `settings` ({ setting, beside_command }), so a renamed engine is a DATA edit, not a code edit.
  const settings = home.settings ? { [home.settings.setting]: home.settings.file ?? resolve(home.command, '..', home.settings.beside_command) } : {};
  const answer = spawnSync(home.command, [home.verb ?? 'held-values', home.store, home.account, ...words], {
    env: { ...process.env, ...settings, ...(process.env[PRODUCT_DATA_ROOT_SETTING] ? { [PRODUCT_DATA_ROOT_SETTING]: resolve(process.env[PRODUCT_DATA_ROOT_SETTING]) } : {}) },
    stdio: ['ignore', 'pipe', 'pipe', privatePipe ? 'pipe' : 'ignore'],
    maxBuffer: MAX_ANSWER_BYTES,
    // Metadata must fail with the checked owner named, rather than hold an agent forever on a stuck command.
    ...(['names-only', 'describe'].includes(words[0]) ? { timeout: METADATA_TIMEOUT_MS } : {}),
  });
  if (answer.error || answer.status !== 0) {
    // The command's errors carry names and vault error codes only, never a value.
    const said = answer.error ? answer.error.code || answer.error.message : String(answer.stderr ?? '').trim().slice(0, 400);
    throw new Error(
      `the vault did not answer ${words[0]}${words[1] ? ` ${words[1]}` : ''}: checked the command ${home.command} `
      + `(from ${home.commandFrom}), the store ${home.store}, the account ${home.account}; `
      + `it ${answer.error?.code === 'ETIMEDOUT' ? `did not answer within ${METADATA_TIMEOUT_MS} ms` : answer.error ? 'did not start' : `exited ${answer.status ?? answer.signal}`}: ${said || 'no message'}`,
    );
  }
  return { out: String(answer.stdout ?? ''), value: privatePipe ? answer.output[3] : null };
}

/**
 * Every held name with what its value is made of, in name order, never a value:
 * `{name, held}` where `held` is `{"fields": [...]}`, `"bare"` or `"signing-root"`.
 */
export function whatTheVaultHolds() {
  return askTheVault(['names']).out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Everything one holder keeps, as an object.
 * `holder` is the name the secret was stored under, e.g. "telegram-bot" or "vapi".
 */
export async function heldByTheVault(holder) {
  const { value } = askTheVault(['read', holder], { privatePipe: true });
  // Some holders keep an object of fields and some keep one bare value, because
  // a Bearer token is a string and wrapping it in JSON would invent structure
  // nobody asked for. Parsing was unconditional here, so every bare-string
  // holder threw on the way out and read to the caller as a missing secret.
  const raw = value ? value.toString('utf8') : '';
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** One field of one holder. Fails loudly, and names what the holder does keep. */
export async function askTheVaultForOneSecret(holder, field) {
  const held = await heldByTheVault(holder);
  if (!held || typeof held !== 'object' || !(field in held)) {
    const fields = await fieldNamesHeldByTheVault(holder);
    throw new Error(`${holder} holds no ${field}, it holds: ${fields.join(', ') || '(one bare value)'}`);
  }
  return held[field];
}

/**
 * The names the vault holds, in name order. Names only: the vault's names answer never
 * carries a value or a handle, so a caller asking "what is held?" never reads a secret.
 */
export async function namesHeldByTheVault() {
  return askTheVault(['names-only']).out.split('\n').filter(Boolean).map((line) => JSON.parse(line).name);
}

/** One holder's shape. The native owner inspects only this name, preserving its value-read protection. */
export function shapeHeldByTheVault(holder) {
  return JSON.parse(askTheVault(['describe', holder]).out).held;
}

/**
 * The field names one holder keeps, never their values. A bare-value holder (and a SigV4
 * signing root, which is never read) keeps no fields and answers an empty list.
 */
export async function fieldNamesHeldByTheVault(holder) {
  const shape = shapeHeldByTheVault(holder);
  return Array.isArray(shape?.fields) ? [...shape.fields].sort() : [];
}

// This entry reads metadata only; value operations stay on the private-pipe API.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== 'where') throw new Error('usage: ask-the-vault-for-one-secret.mjs where');
    process.stdout.write(`${JSON.stringify(credentialHome())}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
