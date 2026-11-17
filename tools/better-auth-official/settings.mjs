// The settings every part of this tool reads: settings.json, or the file BETTER_AUTH_SETTINGS names. What follows from the brand
// block (settings.brand) is filled once here, so no other file names a product: the session cookie's name, the passkey's relying
// party name and the authenticator issuer.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readSettings() {
  const path = resolve(process.env.BETTER_AUTH_SETTINGS ?? new URL('./settings.json', import.meta.url).pathname);
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  const { name, storage_prefix: prefix } = settings.brand ?? {};
  if (!name || !prefix) throw new Error('settings.brand needs a name and a storage_prefix: the computer running this tool says whose sign-in it is');
  settings.session_cookie_name ??= `__Host-${prefix}_session`;
  settings.passkey = { ...settings.passkey, rp_name: settings.passkey.rp_name ?? name };
  settings.two_factor_issuer ??= name;
  return { settings };
}
