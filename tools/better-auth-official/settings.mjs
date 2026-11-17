// The settings every part of this tool reads: this tool's own settings.json, with the file BETTER_AUTH_SETTINGS names laid over
// it (a computer's row renders that file with only what is its own; a key it names wins, an object is merged key by key and a
// list is replaced whole). What follows from the brand block (settings.brand) is filled once here, so no other file names a
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

export function readSettings() {
  const shipped = JSON.parse(readFileSync(SHIPPED, 'utf8'));
  const named = process.env.BETTER_AUTH_SETTINGS ? resolve(process.env.BETTER_AUTH_SETTINGS) : null;
  const settings = named && named !== SHIPPED ? laid(shipped, JSON.parse(readFileSync(named, 'utf8'))) : shipped;
  const { name, storage_prefix: prefix } = settings.brand ?? {};
  if (!name || !prefix) throw new Error('settings.brand needs a name and a storage_prefix: the computer running this tool says whose sign-in it is');
  settings.session_cookie_name ??= `__Host-${prefix}_session`;
  settings.passkey = { ...settings.passkey, rp_name: settings.passkey?.rp_name ?? name };
  settings.two_factor_issuer ??= name;
  return { settings };
}
