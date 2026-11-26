// The settings every part of this tool reads: this tool's own settings.json, with the file BETTER_AUTH_SETTINGS names laid over
// it (a computer's row renders that file with only what is its own; a key it names wins, an object is merged key by key and a
// list is replaced whole). What follows from the site block (settings.site) is filled once here, so no other file names a
// product: the session cookie's name, the passkey's relying party name and the authenticator issuer.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHIPPED = fileURLToPath(new URL('./settings.json', import.meta.url));

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

// A signed local call's address is this computer's own: plain http to 127.0.0.1 or localhost, with the secret that signs it named.
// Refused at start otherwise, so no request can ever leave the computer with the person's email in it. Two calls are made that
// way: the clean-up before an account is deleted (delete_user.before_delete_url) and the call after one is made (after_sign_up.url).
const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];
function checkLocalCall(name, url, secretKey, secretName) {
  let address;
  try { address = new URL(url); } catch { throw new Error(`settings.${name} is not an address: ${url}`); }
  if (address.protocol !== 'http:' || !LOCAL_HOSTS.includes(address.hostname)) throw new Error(`settings.${name} must be an http address on 127.0.0.1 or localhost, not ${url}`);
  if (!secretName) throw new Error(`settings.${name} needs ${secretKey}, the name of the credential that signs the request`);
}
function checkBeforeDelete(deleting) {
  if (deleting?.before_delete_url) checkLocalCall('delete_user.before_delete_url', deleting.before_delete_url, 'before_delete_secret', deleting.before_delete_secret);
}
// A cookie name as RFC 6265 allows it (a token): the after-sign-up call carries only the cookies settings.after_sign_up names.
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function checkAfterSignUp(after) {
  if (!after?.url) return;
  checkLocalCall('after_sign_up.url', after.url, 'after_sign_up.secret', after.secret);
  if (!Array.isArray(after.carried_cookies) || !after.carried_cookies.every(name => typeof name === 'string' && COOKIE_NAME.test(name))) {
    throw new Error('settings.after_sign_up.carried_cookies must be a list of cookie names');
  }
  if (!(Number.isInteger(after.timeout_ms) && after.timeout_ms > 0)) throw new Error('settings.after_sign_up.timeout_ms must be a whole number of milliseconds above 0');
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
  checkBeforeDelete(settings.delete_user);
  checkAfterSignUp(settings.after_sign_up);
  return { settings };
}
