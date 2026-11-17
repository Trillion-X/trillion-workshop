// tools/better-auth-official/pages/sign-in-client.mjs
//
// What the sign-in pages' forms and buttons do: each calls Better Auth through its official client (better-auth/client
// with the passkey, email OTP and two-factor client plugins, as the docs show). The pages themselves are sections in this
// folder; this script only reads their own forms (by action and hidden `way`), buttons (data-passkey, data-consent,
// data-device, data-approve) and steps (data-step), and the words it may show are words.json. Bundled to assets/sign-in.js
// by `npm run build-pages`.
import { createAuthClient } from 'better-auth/client';
import { emailOTPClient, twoFactorClient } from 'better-auth/client/plugins';
import { passkeyClient } from '@better-auth/passkey/client';
import words from './words.json' with { type: 'json' };
import approveRules from './approve.json' with { type: 'json' };
import { authorizeQuery, signedQuery } from './oauth-query.mjs';
import { changeOf, firstRoot, fingerprintOf, signRoot } from './approve-client.mjs';

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
    return data?.twoFactorRedirect ? go('/sign-in/way', { way: 'authenticator' }) : finish();
  }
  if (action === '/sign-in/way' && way === 'email-code' && reset) {
    const to = field(form, 'sign_in_email') || email, password = form.querySelector('[name="new_password"]').value;
    const { error } = await client.emailOtp.resetPassword({ email: to, otp: field(form, 'code'), password });
    if (error) return refusal(error);
    const signed = await client.signIn.email({ email: to, password });
    return signed.error ? go('/sign-in', { email: to }) : finish();
  }
  if (action === '/sign-in/way' && way === 'email-code') {
    const { error } = await client.signIn.emailOtp({ email: field(form, 'sign_in_email') || email, otp: field(form, 'code') });
    return error ? refusal(error) : go('/sign-in/add-passkey');
  }
  if (action === '/sign-in/way' && way === 'authenticator') {
    const { error } = await client.twoFactor.verifyTotp({ code: field(form, 'code') });
    return error ? refusal(error) : finish();
  }
  if (action === '/sign-in/way' && way === 'backup-codes') {
    const { error } = await client.twoFactor.verifyBackupCode({ code: field(form, 'code') });
    return error ? refusal(error) : finish();
  }
  return status(words.unavailable);
}

// Each passkey button, by its purpose: sign in, or make one now (signed in), after which the person's first root is made.
async function passkey(button) {
  const purpose = button.dataset.purpose;
  if (purpose === 'sign-in') {
    const { error } = await client.signIn.passkey();
    return error ? status(button.dataset.failed ?? words.failed) : finish();
  }
  if (purpose === 'register') {
    const { error } = await client.passkey.addPasskey();
    if (error) return status(button.dataset.failed ?? words.failed);
    return approveRules.first_root ? go('/approve', { first: '1' }) : finish();
  }
}

// A passkey offered in the email box itself (WebAuthn conditional mediation, as the passkey docs show): the browser lists the
// person's passkeys under the box, and choosing one signs in with no click here.
function offerPasskeysInTheEmailBox() {
  if (!document.querySelector('input[autocomplete~="webauthn"]')) return;
  window.PublicKeyCredential?.isConditionalMediationAvailable?.().then(available => {
    if (available) client.signIn.passkey({ autoFill: true }).then(({ error }) => { if (!error) finish(); });
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
async function nameTheAsker() {
  const asked = query.get('client_id');
  if (!carried || !asked) return;
  const named = await post(`${authBase}/oauth2/public-client-prelogin`, { client_id: asked, oauth_query: carried });
  fillAll({ client: named.data?.client_name ?? words.asker_unknown, computer: computerOf() });
  for (const node of document.querySelectorAll('[data-fill="asker"]')) node.hidden = false;
}

// /consent: the AI that asked, the computer and what it may do, then Allow or Deny through Better Auth's consent endpoint.
async function consentPage() {
  if (!(await client.getSession()).data) return go('/sign-in');
  const named = await json(`${authBase}/oauth2/public-client?client_id=${encodeURIComponent(query.get('client_id') ?? '')}`);
  fillAll({ client: named.data?.client_name ?? words.asker_unknown, computer: computerOf() });
  listOf('scopes', scopeLines(query.get('scope')));
  show('review');
}
async function consent(button) {
  const answer = await post(`${authBase}/oauth2/consent`, { accept: button.dataset.consent === 'allow', oauth_query: carried });
  return answer.ok && answer.data?.url ? location.assign(answer.data.url) : status(words.failed);
}

// /device: the code a device showed (RFC 8628 user code), the app that asked and what it may do, then Allow or Deny.
const deviceCode = query.get('user_code');
async function devicePage() {
  if (!deviceCode) return show('code');
  if (!(await client.getSession()).data) return go('/sign-in', { next: location.pathname + location.search });
  const asked = await json(`${authBase}/device?user_code=${encodeURIComponent(deviceCode)}`);
  if (!asked.ok) { show('code'); return status(asked.data?.error === 'expired_token' ? words.code_expired : words.code_wrong); }
  if (asked.data.status !== 'pending') return deviceDone(asked.data.status === 'approved');
  if (!asked.data.client_id) { show('code'); return status(words.code_wrong); }
  fillAll({ client: asked.data.client_id, code: deviceCode });
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

// /approve: a proposed root declaration (?root=<fingerprint>) or, right after the first passkey (?first=1), the person's first
// root; the change in plain words, then the passkey signs it and the signature goes back to where the page got the root.
let approving = null;
const changeLines = (before, after) => {
  const lines = changeOf(before, after, { kinds: words.kinds, summaryFields: approveRules.summary_fields })
    .map(({ verb, kind, name }) => words[`approve_${verb}`].replace('{kind}', kind).replace('{name}', name));
  return lines.length ? lines : [words.approve_none];
};
async function approvePage() {
  if (!(await client.getSession()).data) return go('/sign-in', { next: location.pathname + location.search });
  const current = await json(approveRules.current_path);
  const previous = current.ok ? current.data : null;
  // Only the engine's own "no root yet" is a person with no root; any other answer is a place with no root service, and the page steps aside.
  if (!previous && current.data?.error !== 'no_root') return finish();
  if (query.get('first') === '1') {
    if (previous) return finish();
    const root = firstRoot({ host: location.host, issuer: location.origin });
    approving = { root, previous: null };
    listOf('changes', changeLines(null, root));
    return show('first');
  }
  const fingerprint = query.get('root') ?? '';
  const proposed = await json(`${approveRules.proposed_path}${encodeURIComponent(fingerprint)}`);
  if (!proposed.ok) { show('review'); return status(words.root_missing); }
  if (fingerprintOf(proposed.data) !== fingerprint) { show('review'); return status(words.root_mismatch); }
  approving = { root: proposed.data, previous: previous?.fingerprint ?? null };
  listOf('changes', changeLines(previous?.root ?? null, proposed.data));
  return show('review');
}
async function approve() {
  const session = (await client.getSession()).data;
  const options = await client.$fetch('/passkey/generate-authenticate-options', { method: 'GET' });
  const passkeys = (await client.passkey.listUserPasskeys()).data ?? [];
  if (!session || !options.data?.rpId || !passkeys.length) return status(words.approve_failed);
  const signature = await signRoot({
    ...approving, issuer: location.origin, sub: session.user.id, rpId: options.data.rpId, passkeys, credentials: navigator.credentials,
  });
  const sent = await post(approveRules.signature_path, { signature, root: approving.root });
  if (!sent.ok) return status(words.failed);
  return query.get('first') === '1' ? finish() : show('done');
}

document.addEventListener('click', event => {
  const button = event.target.closest('button[data-key], button[data-consent], button[data-device], button[data-approve], button[data-passkey]');
  if (!button) return;
  event.preventDefault();
  const failed = () => status(button.dataset.failed ?? words.failed);
  if (button.matches('[data-key]')) makeKey(button).catch(failed);
  else if (button.matches('[data-consent]')) consent(button).catch(failed);
  else if (button.matches('[data-device]')) device(button).catch(failed);
  else if (button.matches('[data-approve]')) approve().catch(() => status(words.approve_failed));
  else passkey(button).catch(failed);
});

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
// "Not now" ends the step the page offered and carries on to where the person was going.
document.addEventListener('click', event => {
  if (!event.target.closest('[data-page-skip]')) return;
  event.preventDefault();
  finish();
});

offerPasskeysInTheEmailBox();
nameTheAsker().catch(() => {});
const connectPage = { '/consent': consentPage, '/device': devicePage, '/approve': approvePage }[location.pathname];
connectPage?.().catch(() => status(words.unavailable));
