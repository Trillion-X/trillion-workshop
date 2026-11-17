// tools/better-auth-official/pages/sign-in-client.mjs
//
// What the sign-in pages' forms and buttons do: each calls Better Auth through its official client (better-auth/client
// with the passkey, email OTP and two-factor client plugins, as the docs show). The pages themselves are sections in this
// folder; this script only reads their own forms (by action and hidden `way`), buttons (data-passkey, data-consent,
// data-device) and steps (data-step), and the words it may show are words.json. Bundled to assets/sign-in.js
// by `npm run build-pages`.
import { createAuthClient } from 'better-auth/client';
import { emailOTPClient, twoFactorClient } from 'better-auth/client/plugins';
import { passkeyClient } from '@better-auth/passkey/client';
import words from './words.json' with { type: 'json' };
import rules from './sign-in-rules.json' with { type: 'json' };
import { authorizeQuery, signedQuery } from './oauth-query.mjs';

const authBase = '/api/auth';
const client = createAuthClient({ plugins: [passkeyClient(), emailOTPClient(), twoFactorClient()] });
const query = new URLSearchParams(location.search);
// When an AI's connect opened this page, its signed request rides every page of the sign-in until the person is back at authorize.
const carried = signedQuery(location.search);
// Where to go after signing in: a same-origin path only, else the app's front page.
const next = (() => { const asked = query.get('next') ?? '/'; return asked.startsWith('/') && !asked.startsWith('//') ? asked : '/'; })();
const email = query.get('email') ?? '';
const go = (path, values = {}) => {
  const url = new URL(path, location.origin);
  for (const [key, value] of new URLSearchParams(carried)) url.searchParams.append(key, value);
  for (const [key, value] of Object.entries({ next: next === '/' ? '' : next, ...values })) if (value) url.searchParams.set(key, value);
  location.assign(url.pathname + url.search);
};
// The end of a sign-in: back to the AI's authorize request when one opened it, else the page the person was going to.
const finish = () => location.assign(carried ? `${authBase}/oauth2/authorize?${authorizeQuery(location.search)}` : next);
const visible = () => document.querySelector('.page-section:not([hidden]) .page-status') ?? document.querySelector('.page-status');
const status = text => { const box = visible(); if (box) box.textContent = text; };
const refusal = (error, fallback = words.failed) => status(error?.status === 429 ? words.too_many : fallback);
const field = (form, name) => form.querySelector(`[name="${name}"]`)?.value?.trim() ?? '';
const show = name => { for (const step of document.querySelectorAll('[data-step]')) step.hidden = step.dataset.step !== name; };
const json = async (path, options) => {
  const answer = await fetch(path, { credentials: 'same-origin', ...options });
  return { ok: answer.ok, status: answer.status, data: await answer.json().catch(() => null) };
};
const post = (path, body) => json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// The words with `{name}`-style gaps drawn on a page: filled from `values`, whatever the page's own words are around them.
const fill = (node, values) => {
  node.dataset.template ??= node.textContent;
  node.textContent = node.dataset.template.replace(/\{(\w+)\}/g, (gap, key) => values[key] ?? gap);
};
const fillAll = values => { for (const node of document.querySelectorAll('[data-fill]')) fill(node, values); };
const listOf = (name, lines) => {
  for (const list of document.querySelectorAll(`[data-fill-list="${name}"]`)) {
    list.replaceChildren(...lines.map(line => { const item = document.createElement('li'); item.className = 'page-item'; const body = document.createElement('p'); body.className = 'page-item-body'; body.textContent = line; item.append(body); return item; }));
  }
};
const scopeLines = scope => (scope ?? '').split(' ').filter(Boolean).map(name => words.scopes[name] ?? name);

// What the person said Not now to on this device is not offered again for rules.skip_days.
const skipped = way => Date.now() - Number(localStorage.getItem(`trillion-skipped-${way}`) ?? 0) < rules.skip_days * 864e5;
const skip = way => localStorage.setItem(`trillion-skipped-${way}`, String(Date.now()));
// A step that needs a signed-in person sends one who is not to sign in and back (their own request carried on).
const signedOut = error => [401, 403].includes(error?.status);
const toSignIn = () => go('/sign-in', { next: location.pathname + location.search });
// A passkey made on this device is remembered here, so the offer is not made again where one already exists.
const hasPasskeyHere = () => localStorage.getItem('trillion-passkey-here') === '1';
const markPasskeyHere = () => localStorage.setItem('trillion-passkey-here', '1');
// A passkey made without a page: browsers that support conditional create (Passkeys, the WebAuthn Level 3 capability) make one
// quietly when the person just signed in with a saved credential; any other answer leaves the offer to the page.
async function madeQuietly() {
  if (!(await window.PublicKeyCredential?.getClientCapabilities?.())?.conditionalCreate) return false;
  const made = await Promise.race([client.passkey.addPasskey({ useAutoRegister: true }), new Promise(resolve => setTimeout(() => resolve({ error: {} }), 4000))]);
  if (!made.error) markPasskeyHere();
  return !made.error;
}
// The end of every sign-in: for an AI's connect or a device code, straight on to it; else a
// passkey, once, if this device can hold one, has none and the person did not say Not now; then where they were going.
async function afterSignIn() {
  const session = (await client.getSession()).data;
  if (!session) return finish();
  const asked = carried || next.startsWith('/device');
  const canHold = await window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.();
  if (asked || !canHold || skipped('passkey') || hasPasskeyHere() || await madeQuietly()) return finish();
  return go('/sign-in/add-passkey');
}
// The words for how a passkey step ended, by step and the error code Better Auth's client gives.
const passkeyEnd = (step, error) => words.passkey_errors[step]?.[error?.code] ?? words.passkey_errors.any[error?.code] ?? { said: words.passkey_unknown, kind: 'error' };
// An error from an email-code sign-in, in the words for what went wrong.
const codeRefusal = error => status({ OTP_EXPIRED: words.code_ran_out, TOO_MANY_ATTEMPTS: words.code_tries, INVALID_OTP: words.code_wrong_login }[error?.code] ?? (error?.status === 429 ? words.too_many : words.failed));

// The address a code went to: the pages draw "{name}" where it goes.
if (email) {
  for (const node of document.querySelectorAll('[data-page-sent-to], .page-sent-to-address')) node.textContent = node.textContent.replaceAll('{name}', email);
  for (const input of document.querySelectorAll('input')) {
    if (input.value === '{name}') input.value = email;
    if (['email', 'sign_in_email'].includes(input.name) && input.type !== 'hidden' && !input.value) input.value = email;
  }
}

// Each form, by where the engine's page posted it: the same addresses, now answered by Better Auth.
async function submit(form) {
  const action = new URL(form.action, location.origin).pathname;
  const way = field(form, 'way');
  const reset = field(form, 'reset') === '1';
  if (action === '/device') return go('/device', { user_code: field(form, 'user_code') });
  if (action === '/sign-out') {
    const { error } = await client.signOut();
    return error ? refusal(error) : location.assign('/sign-in');
  }
  if (action === '/sign-in/way/send') {
    const to = field(form, 'sign_in_email') || email;
    if (!to) return status(words.email_needed);
    const { error } = await client.emailOtp.sendVerificationOtp({ email: to, type: reset ? 'forget-password' : 'sign-in' });
    if (error) return refusal(error, words.not_sent);
    return reset ? go('/sign-in/forgot-password', { sent: '1', email: to }) : go('/sign-in/way', { way: 'email-code', sent: '1', email: to });
  }
  if (action === '/sign-in/way' && way === 'password') {
    const { data, error } = await client.signIn.email({ email: field(form, 'sign_in_email'), password: form.querySelector('[name="password"]').value });
    if (error) return refusal(error);
    return data?.twoFactorRedirect ? go('/sign-in/way', { way: 'authenticator' }) : afterSignIn();
  }
  if (action === '/sign-in/way' && way === 'email-code' && reset) {
    const to = field(form, 'sign_in_email') || email, password = form.querySelector('[name="new_password"]').value;
    const { error } = await client.emailOtp.resetPassword({ email: to, otp: field(form, 'code'), password });
    if (error) return refusal(error);
    const signed = await client.signIn.email({ email: to, password });
    return signed.error ? go('/sign-in', { email: to }) : afterSignIn();
  }
  if (action === '/sign-in/way' && way === 'email-code') {
    const { error } = await client.signIn.emailOtp({ email: field(form, 'sign_in_email') || email, otp: field(form, 'code') });
    return error ? codeRefusal(error) : afterSignIn();
  }
  if (action === '/sign-in/way' && way === 'authenticator') {
    const { error } = await client.twoFactor.verifyTotp({ code: field(form, 'code') });
    return error ? refusal(error) : afterSignIn();
  }
  if (action === '/sign-in/way' && way === 'backup-codes') {
    const { error } = await client.twoFactor.verifyBackupCode({ code: field(form, 'code') });
    return error ? refusal(error) : afterSignIn();
  }
  if (action === '/sign-in/change-email') {
    const { error } = await client.changeEmail({ newEmail: field(form, 'new_email'), callbackURL: '/' });
    return error ? (signedOut(error) ? toSignIn() : refusal(error)) : status(words.email_change_sent);
  }
  return status(words.unavailable);
}

// Each passkey button, by its purpose: sign in, or make one now (signed in).
async function passkey(button) {
  const purpose = button.dataset.purpose;
  if (purpose === 'sign-in') {
    const { error } = await client.signIn.passkey();
    if (!error) return afterSignIn();
    status(passkeyEnd('sign-in', error).said);
    return document.querySelector('input[name="sign_in_email"]')?.focus();
  }
  if (purpose === 'register') {
    const { error } = await client.passkey.addPasskey();
    if (!error) { markPasskeyHere(); return afterSignIn(); }
    if (signedOut(error)) return toSignIn();
    const end = passkeyEnd('make', error);
    if (end.already) markPasskeyHere();
    return end.already ? afterSignIn() : status(end.said);
  }
}

// The link that adds a passkey on another device: a one-time link by email, which signs that device in and offers its own passkey.
async function emailTheLink(button) {
  const session = (await client.getSession()).data;
  if (!session) return toSignIn();
  const { error } = await client.signIn.magicLink({ email: session.user.email, callbackURL: '/sign-in/add-passkey' });
  return status(error ? button.dataset.failed : words.link_sent);
}

// A passkey offered in the email box itself (WebAuthn conditional mediation, as the passkey docs show): the browser lists the
// person's passkeys under the box, and choosing one signs in with no click here.
function offerPasskeysInTheEmailBox() {
  if (!document.querySelector('input[autocomplete~="webauthn"]')) return;
  window.PublicKeyCredential?.isConditionalMediationAvailable?.().then(available => {
    if (available) client.signIn.passkey({ autoFill: true }).then(({ error }) => { if (!error) afterSignIn(); });
  });
}

// The key button (/sign-in/key): makes the signed-in person an API key with Better Auth's own api-key/create, shows it once
// and copies it. Its account and scopes are set by the server (auth.mjs), never by this page. Not signed in: sign in first.
async function makeKey(button) {
  const name = document.querySelector('[name="key-name"]')?.value?.trim() || undefined;
  const made = await post(`${authBase}/api-key/create`, { name });
  if (made.status === 401) return location.assign(`/sign-in?next=${encodeURIComponent(location.pathname)}`);
  if (!made.ok || !made.data?.key) return refusal({ status: made.status }, button.dataset.failed ?? words.failed);
  const box = document.querySelector('[name="made-key"]');
  if (box) { box.value = made.data.key; box.hidden = false; box.select(); }
  await navigator.clipboard?.writeText(made.data.key).catch(() => {});
  return status(words.key_made);
}

// The AI that is asking, on the sign-in pages an AI's connect opened: its name from its client metadata and the computer it asked for.
const computerOf = () => { try { return new URL(query.get('resource') ?? '').host; } catch { return words.computer_unknown; } };
const redirectHost = () => { try { return new URL(query.get('redirect_uri') ?? '').host || new URL(query.get('redirect_uri')).protocol; } catch { return words.computer_unknown; } };
async function nameTheAsker() {
  const asked = query.get('client_id');
  if (!carried || !asked) return;
  const named = await post(`${authBase}/oauth2/public-client-prelogin`, { client_id: asked, oauth_query: carried });
  fillAll({ client: named.data?.client_name ?? words.asker_unknown, computer: computerOf() });
  for (const node of document.querySelectorAll('[data-fill="asker"]')) node.hidden = false;
}

// /consent: the AI that asked, where it is from, the computer and what it may do, then Allow or Deny through Better Auth's consent endpoint.
// - The owner's own AI gets everything; Read only is a switch, off by default.
// - An AI whose return address is not its own (not its document's host, not a loopback address) has Deny as the main button, and Allow
//   opens only when the address is typed.
// - An AI the person already allowed is shown "Connecting" with an Undo, and goes on by itself after rules.remembered_seconds.
const isLoopback = host => host === 'localhost' || host === '[::1]' || /^127\./.test(host);
const hostOf = address => { try { return new URL(address).hostname.toLowerCase(); } catch { return ''; } };
const related = (a, b) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
let readOnly = false;
const rememberedAs = (granted, asked) => {
  const drops = rules.read_only_drops;
  const narrowed = !granted.some(scope => drops.includes(scope));
  return asked.every(scope => granted.includes(scope) || (drops.includes(scope) && narrowed)) ? { readOnly: narrowed && asked.some(scope => drops.includes(scope)) } : null;
};
async function consentPage() {
  const session = await client.getSession();
  if (!session.data) return go('/sign-in');
  const id = query.get('client_id') ?? '';
  const named = await json(`${authBase}/oauth2/public-client?client_id=${encodeURIComponent(id)}`);
  const clientHost = id.startsWith('https://') ? hostOf(id) : '';
  const returnHost = hostOf(query.get('redirect_uri') ?? '');
  fillAll({ client: named.data?.client_name ?? words.asker_unknown, clientHost: clientHost || words.computer_unknown, computer: computerOf(), email: session.data.user.email, redirect: redirectHost() });
  const asked = (query.get('scope') ?? '').split(' ').filter(Boolean);
  listOf('scopes', scopeLines(query.get('scope')));
  const known = Boolean(clientHost) && (related(returnHost, clientHost) || isLoopback(returnHost));
  const before = ((await json(`${authBase}/oauth2/get-consents`)).data ?? []).find(row => row.clientId === id);
  const again = before && known ? rememberedAs(before.scopes ?? [], asked) : null;
  if (again) {
    readOnly = again.readOnly;
    show('remembered');
    return void setTimeout(() => { if (!undone) consent(document.querySelector('[data-step="remembered"] [data-consent]')).catch(() => status(words.failed)); }, rules.remembered_seconds * 1000);
  }
  if (!known) {
    // Deny is the main button; Allow waits for the address, typed.
    const allow = document.querySelector('[data-step="review"] [data-consent="allow"]'), deny = document.querySelector('[data-step="review"] [data-consent="deny"]');
    const box = document.querySelector('[name="typed_host"]');
    document.querySelector('[data-unknown]').hidden = false;
    allow.className = 'page-action page-action--quiet'; deny.className = 'page-action';
    allow.disabled = true;
    box.addEventListener('input', () => { allow.disabled = box.value.trim().toLowerCase() !== redirectHost().toLowerCase(); });
  }
  show('review');
}
let undone = false;
async function consent(button) {
  const answer = await post(`${authBase}/oauth2/consent`, { accept: button.dataset.consent === 'allow', oauth_query: carried, read_only: readOnly });
  return answer.ok && answer.data?.url ? location.assign(answer.data.url) : status(words.failed);
}
// Undo on a remembered AI: it is disconnected (its tokens and consent end) and told no.
async function undo() {
  undone = true;
  await post(`${authBase}/connected/revoke`, { clientId: query.get('client_id') });
  const answer = await post(`${authBase}/oauth2/consent`, { accept: false, oauth_query: carried });
  return answer.ok && answer.data?.url ? location.assign(answer.data.url) : status(words.failed);
}

// /connected: the AIs the person allowed, what each can do, when it connected and last used, and one tap to disconnect.
const when = iso => new Date(iso).toLocaleString();
async function connectedPage() {
  if (!(await client.getSession()).data) return toSignIn();
  const listed = await json(`${authBase}/connected`);
  const ais = listed.data?.ais ?? [];
  document.querySelector('[data-fill="none"]').hidden = ais.length > 0;
  const list = document.querySelector('[data-fill-list="connected"]');
  list.replaceChildren(...ais.map(ai => {
    const item = document.createElement('li'); item.className = 'page-item';
    const add = (tag, className, text) => { const node = document.createElement(tag); node.className = className; node.textContent = text; item.append(node); return node; };
    add('h2', 'page-item-heading', ai.name ?? words.asker_unknown);
    add('p', 'page-item-detail', ai.read_only ? words.connected_can_read : words.connected_can_all);
    add('p', 'page-item-detail', ai.last_used_at ? words.connected_last_used.replace('{when}', when(ai.last_used_at)) : words.connected_never);
    add('p', 'page-item-detail', words.connected_since.replace('{when}', when(ai.connected_at)));
    if (ai.ended_by) add('p', 'page-item-detail', ai.ended_text ?? words.connected_ended_chain_ended);
    const actions = document.createElement('div'); actions.className = 'page-item-actions';
    if (ai.ended_by && ai.reconnect_url) { const link = document.createElement('a'); link.className = 'page-action'; link.href = ai.reconnect_url; link.textContent = words.connected_reconnect; actions.append(link); }
    else if (ai.ended_by) add('p', 'page-item-detail', words.connected_reconnect_none);
    const button = document.createElement('button'); button.className = 'page-action'; button.type = 'button'; button.dataset.disconnect = ai.client_id; button.textContent = words.disconnect;
    actions.append(button); item.append(actions);
    return item;
  }));
}
async function disconnect(button) {
  const done = await post(`${authBase}/connected/revoke`, { clientId: button.dataset.disconnect });
  if (!done.ok) return status(words.failed);
  button.closest('li').remove();
  if (!document.querySelector('[data-fill-list="connected"] li')) document.querySelector('[data-fill="none"]').hidden = false;
  status(words.disconnected);
}

// /device: the code a device showed (RFC 8628 user code), the app that asked and what it may do, then Allow or Deny.
const deviceCode = query.get('user_code');
// A device names itself by its client id (living-room-tv): said as words, and its code in the groups it was shown in.
const humane = id => { const said = id.replace(/[-_]+/g, ' ').trim(); return said.charAt(0).toUpperCase() + said.slice(1); };
const hyphenated = code => { const plain = code.replace(/[^a-z0-9]/gi, '').toUpperCase(); return plain.length > 4 ? `${plain.slice(0, 4)}-${plain.slice(4)}` : plain; };
async function devicePage() {
  if (!deviceCode) return show('code');
  if (!(await client.getSession()).data) return go('/sign-in', { next: location.pathname + location.search });
  const asked = await json(`${authBase}/device?user_code=${encodeURIComponent(deviceCode)}`);
  if (!asked.ok) { show('code'); return status(asked.data?.error === 'expired_token' ? words.code_expired : words.code_wrong); }
  if (asked.data.status !== 'pending') return deviceDone(asked.data.status === 'approved');
  if (!asked.data.client_id) { show('code'); return status(words.code_wrong); }
  fillAll({ client: humane(asked.data.client_id), code: hyphenated(deviceCode) });
  listOf('scopes', scopeLines(asked.data.scope));
  show('review');
}
const deviceDone = allowed => {
  document.querySelector('[data-fill="done-heading"]').textContent = allowed ? words.device_allowed_heading : words.device_denied_heading;
  document.querySelector('[data-fill="done-body"]').textContent = allowed ? words.device_allowed_body : words.device_denied_body;
  show('done');
};
async function device(button) {
  const allowed = button.dataset.device === 'allow';
  const answer = await post(`${authBase}/device/${allowed ? 'approve' : 'deny'}`, { userCode: deviceCode });
  return answer.ok ? deviceDone(allowed) : status(words.failed);
}

document.addEventListener('click', event => {
  const button = event.target.closest('button[data-key], button[data-passkey-link], button[data-undo], button[data-read-only], button[data-disconnect], button[data-consent], button[data-device], button[data-passkey]');
  if (!button) return;
  event.preventDefault();
  const failed = () => status(button.dataset.failed ?? words.failed);
  if (button.matches('[data-key]')) makeKey(button).catch(failed);
  else if (button.matches('[data-passkey-link]')) emailTheLink(button).catch(failed);
  else if (button.matches('[data-undo]')) undo().catch(failed);
  else if (button.matches('[data-disconnect]')) disconnect(button).catch(failed);
  else if (button.matches('[data-read-only]')) { readOnly = !readOnly; button.setAttribute('aria-pressed', String(readOnly)); button.textContent = readOnly ? words.read_only_on : words.read_only_off; }
  else if (button.matches('[data-consent]')) consent(button).catch(failed);
  else if (button.matches('[data-device]')) device(button).catch(failed);
  else passkey(button).catch(failed);
});

// The sixth digit sends the code; the Sign in button stays for anyone who wants it.
document.addEventListener('page-code-complete', event => event.target.closest('form')?.requestSubmit());

document.addEventListener('submit', event => {
  const form = event.target.closest('form');
  if (!form) return;
  event.preventDefault();
  submit(form).catch(() => status(words.unavailable));
});
// The password box's "Forgot password?" link opens the reset page (the drawn page points it at the password way's own page).
document.addEventListener('click', event => {
  const link = event.target.closest('a.page-field-link');
  if (!link || !link.closest('.page-field')?.querySelector('[name="password"]')) return;
  event.preventDefault();
  go('/sign-in/forgot-password', { email: document.querySelector('[name="sign_in_email"]')?.value?.trim() });
});
// "Not you?" on the consent page signs this person out and back in.
document.addEventListener('click', event => {
  if (!event.target.closest('[data-switch-account]')) return;
  event.preventDefault();
  client.signOut().then(() => go('/sign-in'));
});
// "Not now" is remembered on this device and carries on to what comes next.
document.addEventListener('click', event => {
  const link = event.target.closest('[data-page-skip]');
  if (!link) return;
  event.preventDefault();
  skip(link.dataset.pageSkip);
  finish();
});

offerPasskeysInTheEmailBox();
nameTheAsker().catch(() => {});
// The pages that are for a signed-in person send one who is not to sign in and come back.
const needsSession = async () => { if (!(await client.getSession()).data) toSignIn(); };
const connectPage = { '/consent': consentPage, '/connected': connectedPage, '/device': devicePage, '/sign-in/add-passkey': needsSession, '/sign-in/change-email': needsSession }[location.pathname];
connectPage?.().catch(() => status(words.unavailable));
