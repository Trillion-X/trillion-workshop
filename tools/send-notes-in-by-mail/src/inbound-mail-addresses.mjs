// src/inbound-mail-addresses.mjs
//
// Which addresses this Worker's mail handler (src/inbound-mail.mjs) takes, read without the handler itself, so a
// sender (src/mail-sender.mjs) can ask before sending.
//
// Purpose
//   Cloudflare Email Routing hands every address in the zone that has no rule of its own to this Worker. An account's
//   address (`domain` in inbound-mail-settings.json, its token held in APP_KV) is kept for that account; a `handed_on`
//   domain's mail is passed whole to the Worker its row names; anything else at `domain` is refused. A send to an
//   address that would be refused here is never reported as sent.
//
// Non-negotiable invariants
//   1. The domains and the hand-on rows are DATA (inbound-mail-settings.json); nothing here names a domain.
//   2. refusalOf and the handler read the same token key, so they never disagree about an address.
//
import settings from './inbound-mail-settings.json' with { type: 'json' };

/** The APP_KV key an account address's token is held under. */
export const tokenKey = token => `inbound-address:${token}`;

const clean = value => String(value ?? '').trim().toLowerCase();
const domainOf = address => clean(address).split('@')[1] ?? '';

/** The `handed_on` row for the domain of `address`, or null. */
export const handedOnFor = address => (settings.handed_on ?? []).find(row => row.domain === domainOf(address)) ?? null;

/**
 * Why mail to `address` would be refused when it reaches this Worker, or null when it would be kept or never comes
 * here: an address at the accounts' own domain that no account holds.
 */
export async function refusalOf(env, address) {
  if (domainOf(address) !== settings.domain) return null;
  const token = clean(address).split('@')[0];
  return token && (await env?.APP_KV?.get(tokenKey(token), 'json')) ? null : 'No such address.';
}
