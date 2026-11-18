// The settings every part of this tool reads: this tool's own settings.json, with the file BETTER_AUTH_SETTINGS names laid over
// it (a computer's row renders that file with only what is its own; a key it names wins, an object is merged key by key and a
// list is replaced whole). What follows from the site block (settings.site) is filled once here, so no other file names a
// product: the session cookie's name, the passkey's relying party name and the authenticator issuer.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHIPPED = new URL('./settings.json', import.meta.url).pathname;

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** `over` laid on `under`: each key `over` names wins; two objects under one key are laid the same way. */
export function laid(under, over) {
  const out = { ...under };
  for (const [name, value] of Object.entries(over)) out[name] = plain(value) && plain(under[name]) ? laid(under[name], value) : value;
  return out;
}

/** The JSON object in `file`; a file that cannot be read, or holds no JSON object, is refused with its path and why, so a
 * server that will not start says which settings file stopped it. */
function objectIn(file) {
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { throw new Error(`The settings file ${file} cannot be used: ${error.code ?? error.message}`); }
  if (!plain(value)) throw new Error(`The settings file ${file} cannot be used: it holds no JSON object`);
  return value;
}

export function readSettings() {
  const shipped = objectIn(SHIPPED);
  const named = process.env.BETTER_AUTH_SETTINGS ? resolve(process.env.BETTER_AUTH_SETTINGS) : null;
  const settings = named && named !== SHIPPED ? laid(shipped, objectIn(named)) : shipped;
  const { name, storage_prefix: prefix } = settings.site ?? {};
  if (!name || !prefix) throw new Error('settings.site needs a name and a storage_prefix: the computer running this tool says whose sign-in it is');
  settings.session_cookie_name ??= `__Host-${prefix}_session`;
  settings.passkey = { ...settings.passkey, rp_name: settings.passkey?.rp_name ?? name };
  settings.two_factor_issuer ??= name;
  return { settings };
}
