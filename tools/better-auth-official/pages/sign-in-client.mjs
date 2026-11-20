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
import wordsWithNameGaps from './words.json' with { type: 'json' };
import rules from './sign-in-rules.json' with { type: 'json' };
import { authorizeQuery, signedQuery } from './oauth-query.mjs';
import { safeNext } from './safe-next.mjs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FormAlert } from '../../ui/show/form-alert/FormAlert.tsx';
import busySentence from 'sign-in-busy-sentence';
import { isBusy, busyWords } from './busy.mjs';

const authBase = '/api/auth';
const client = createAuthClient({ plugins: [passkeyClient(), emailOTPClient(), twoFactorClient()] });
const query = new URLSearchParams(location.search);
// When an AI's connect opened this page, its signed request rides every page of the sign-in until the person is back at authorize.
const carried = signedQuery(location.search);
// Where to go after signing in: a same-origin path only, else the app's front page.
const next = safeNext(query.get('next'));
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
// A line that is news, not trouble ("A link is on its way"): the quiet status line of the section the person is on.
const status = text => { const box = visible(); if (box) box.textContent = text; };
// Trouble is never a quiet line. It is the shared FormAlert (tools/ui/show/form-alert), drawn right above the control that failed, in the danger
// colour at reading size, with the one next action as a button that takes focus; with no action the alert itself takes it. The control is the
// last one the person pressed or typed in. `next` names an action of words.alert_actions, which the table below does.
let lastControl = null;
for (const type of ['click', 'keydown', 'input', 'submit']) document.addEventListener(type, event => { if (event.target?.closest?.('button, input, form')) lastControl = event.target.closest('button, input, form'); }, true);
const clearAlerts = () => { for (const old of document.querySelectorAll('[data-form-alert]')) old.remove(); for (const box of document.querySelectorAll('.page-status')) box.textContent = ''; };
const nextActions = {
  // The email-code form of this page: send the code when the address is typed, else take the person to the box for it.
  'email-code': () => { const form = document.querySelector('form[action="/sign-in/way/send"]'); const box = form?.querySelector('[name="sign_in_email"]'); if (form && box?.value.trim()) form.requestSubmit(); else if (box) box.focus(); else go('/sign-in'); },
  // The same control again.
  // With no control to repeat (a page that failed as it loaded), the page is read again.
  'try-again': () => lastControl?.isConnected && lastControl.matches('button') ? lastControl.click() : lastControl?.form ? lastControl.form.requestSubmit() : location.reload(),
};
function fail(text, next, focus) {
  if (signedIn) return;
  const section = lastControl?.closest('.page-section') ?? document.querySelector('.page-section:not([hidden])') ?? document.body;
  // The alert is one more item of the stack the failed control stands in (above a whole field, never inside one), so it is spaced as that
  // stack spaces its items: the six code boxes no longer touch it.
  const above = lastControl?.closest('.page-actions, .page-choices-send, .page-field') ?? section.querySelector('.page-actions') ?? section.lastElementChild;
  const label = words.alert_actions[next];
  clearAlerts();
  const holder = document.createElement('div');
  // The shared part prerenders as markup; its button is wired here, and the alert is the one thing that takes focus (an alert with no action takes it itself).
  holder.innerHTML = renderToStaticMarkup(createElement(FormAlert, { title: text, action: label ? { label, onAction: () => {} } : undefined }));
  const alert = holder.firstElementChild;
  alert.dataset.formAlert = '';
  alert.tabIndex = -1;
  const button = alert.querySelector('button');
  if (button) button.addEventListener('click', () => nextActions[next]?.());
  above?.parentNode ? above.parentNode.insertBefore(alert, above) : section.append(alert);
  (focus ?? button ?? alert).focus();
}
// Any answer that failed goes through here: a busy server (429 or a 5xx) is said in the terminal's busy words, with Try again (the sign-in is kept);
// anything else is the fallback words with the action the caller names.
const refusal = (error, fallback = words.failed, next) => isBusy(error?.status) ? fail(busyWords(busySentence, siteName), 'try-again') : fail(fallback, next);
const field = (form, name) => form.querySelector(`[name="${name}"]`)?.value?.trim() ?? '';
const show = name => { for (const step of document.querySelectorAll('[data-step]')) step.hidden = step.dataset.step !== name; };
const json = async (path, options) => {
  const answer = await fetch(path, { credentials: 'same-origin', ...options });
  return { ok: answer.ok, status: answer.status, data: await answer.json().catch(() => null) };
};
const post = (path, body) => json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Whose sign-in this is comes from the page (data-site-name, data-site-prefix: settings.site): the words say {{name}} where they
// name the product, and every key kept in the browser starts with the prefix.
const siteName = document.documentElement.dataset.siteName;
const keep = `${document.documentElement.dataset.sitePrefix}-`;
const named = value => (typeof value === 'string' ? value.replaceAll('{{name}}', siteName) : Array.isArray(value) ? value.map(named) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, named(item)])) : value);
const words = named(wordsWithNameGaps);

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
const skipped = way => Date.now() - Number(localStorage.getItem(`${keep}skipped-${way}`) ?? 0) < rules.skip_days * 864e5;
const skip = way => localStorage.setItem(`${keep}skipped-${way}`, String(Date.now()));
// A step that needs a signed-in person sends one who is not to sign in and back (their own request carried on).
const signedOut = error => [401, 403].includes(error?.status);
const toSignIn = () => go('/sign-in', { next: location.pathname + location.search });
// The signed-in person, or null after the page has been told why not: a person with no session is sent to sign in and back, but a read that
// failed or was refused for too many asks (a 429 from a shared limit, a 5xx) is never taken for a signed-out person, or the page would send
// someone who is signed in back to sign in, again and again.
async function signedInPerson(sendToSignIn = toSignIn) {
  const read = await client.getSession();
  if (read.data) return read.data;
  if (read.error) { refusal(read.error, words.unavailable); return null; }
  sendToSignIn();
  return null;
}
// A passkey made on this device is remembered here, so the offer is not made again where one already exists.
const hasPasskeyHere = () => localStorage.getItem(`${keep}passkey-here`) === '1';
const markPasskeyHere = () => localStorage.setItem(`${keep}passkey-here`, '1');
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
// A sign-in that went through is the last word: the page is on its way out, so no later answer (a code that was already used) is shown as trouble.
let signedIn = false;
async function afterSignIn() {
  signedIn = true;
  const session = (await client.getSession()).data;
  if (!session) return finish();
  // First and last name, once, on every way an account is made (email code, passkey, password): an account with no name is asked first.
  if (!session.user?.name?.trim() || session.user.name.trim() === session.user.email) return go('/sign-in/your-name');
  const asked = carried || next.startsWith('/device');
  const canHold = await window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.();
  if (asked || !canHold || skipped('passkey') || hasPasskeyHere() || await madeQuietly()) return finish();
  return go('/sign-in/add-passkey');
}
// The words for how a passkey step ended, by step and the error code Better Auth's client gives.
const passkeyEnd = (step, error) => words.passkey_errors[step]?.[error?.code] ?? words.passkey_errors.any[error?.code] ?? { said: words.passkey_unknown, kind: 'error' };
// An error from an email-code sign-in, in the words for what went wrong.
const codeRefusal = error => {
  if (isBusy(error?.status)) return refusal(error);
  if (error?.code === 'OTP_EXPIRED') return fail(words.code_ran_out, 'email-code');
  if (error?.code === 'TOO_MANY_ATTEMPTS') return fail(words.code_tries, 'email-code');
  // A wrong code: the boxes are emptied and the first takes focus, so the person types it again where they were looking.
  const boxes = [...document.querySelectorAll('.page-code-box, [name="code"]')].filter(box => box.type !== 'hidden');
  for (const box of boxes) box.value = '';
  return fail(error?.code === 'INVALID_OTP' ? words.code_wrong_login : words.failed, undefined, boxes[0]);
};

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
  clearAlerts();
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
    if (!to) return fail(words.email_needed, undefined, document.querySelector('[name="sign_in_email"]'));
    const { error } = await client.emailOtp.sendVerificationOtp({ email: to, type: reset ? 'forget-password' : 'sign-in' });
    if (error) return refusal(error, words.not_sent);
    return reset ? go('/sign-in/forgot-password', { sent: '1', email: to }) : go('/sign-in/way', { way: 'email-code', sent: '1', email: to });
  }
  if (action === '/sign-in/way' && way === 'password') {
    const { data, error } = await client.signIn.email({ email: field(form, 'sign_in_email'), password: form.querySelector('[name="password"]').value });
    if (error) return refusal(error, words.password_errors[error.code] ?? words.failed, 'email-code');
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
  if (action === '/sign-in/your-name') {
    const name = [field(form, 'first_name'), field(form, 'last_name')].join(' ').trim();
    const { error } = await client.updateUser({ name });
    return error ? (signedOut(error) ? toSignIn() : refusal(error)) : afterSignIn();
  }
  if (action === '/account/delete') return deleteAccount(form);
  if (action === '/sign-in/change-email') {
    const { error } = await client.changeEmail({ newEmail: field(form, 'new_email'), callbackURL: '/' });
    return error ? (signedOut(error) ? toSignIn() : refusal(error)) : status(words.email_change_sent);
  }
  return fail(words.unavailable);
}

// Each passkey button, by its purpose: sign in, or make one now (signed in).
async function passkey(button) {
  clearAlerts();
  const purpose = button.dataset.purpose;
  if (purpose === 'sign-in') {
    const { error } = await client.signIn.passkey();
    if (!error) return afterSignIn();
    return fail(passkeyEnd('sign-in', error).said, 'email-code');
  }
  if (purpose === 'register') {
    const { error } = await client.passkey.addPasskey();
    if (!error) { markPasskeyHere(); return afterSignIn(); }
    if (signedOut(error)) return toSignIn();
    const end = passkeyEnd('make', error);
    if (end.already) markPasskeyHere();
    return end.already ? afterSignIn() : fail(end.said, 'try-again');
  }
}

// The link that adds a passkey on another device: a one-time link by email, which signs that device in and offers its own passkey.
async function emailTheLink(button) {
  const session = await signedInPerson();
  if (!session) return;
  const { error } = await client.signIn.magicLink({ email: session.user.email, callbackURL: '/sign-in/add-passkey' });
  return error ? refusal(error, button.dataset.failed, 'try-again') : status(words.link_sent);
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

// The AI that is asking, on the sign-in pages an AI's connect opened: its name from its client metadata.
async function nameTheAsker() {
  const asked = query.get('client_id');
  if (!carried || !asked) return;
  const named = await post(`${authBase}/oauth2/public-client-prelogin`, { client_id: asked, oauth_query: carried });
  fillAll({ client: named.data?.client_name ?? words.asker_unknown });
  for (const node of document.querySelectorAll('[data-fill="asker"]')) node.hidden = false;
}

// /consent: the AI that asked, where it is from, the computer and what it may do, then Allow or Deny through Better Auth's consent endpoint.
// - The owner's own AI gets everything; Read only is a switch, off by default.
// - An AI whose return address is not its own (not its document's host, not a loopback address) is called unknown in one plain line, with Deny
//   as the main button; no address is shown to the person.
// - An AI the person already allowed is shown "Connecting" with an Undo, and goes on by itself after rules.remembered_seconds.
const isLoopback = host => host === 'localhost' || host === '[::1]' || /^127\./.test(host);
const hostOf = address => { try { return new URL(address).hostname.toLowerCase(); } catch { return ''; } };
const related = (a, b) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
let readOnly = false;
// A remembered consent matches this request when each scope asked is granted, a read-only variant is granted by its full scope, or (a grant
// that was narrowed) the scope is one Read only leaves out.
const rememberedAs = (granted, asked) => {
  const { read_only_drops: drops, read_only_swaps: swaps } = rules;
  const keyOf = variant => Object.keys(swaps).find(full => swaps[full] === variant);
  const narrowed = !granted.some(scope => drops.includes(scope) || scope in swaps);
  const satisfied = scope => granted.includes(scope) || (keyOf(scope) && granted.includes(keyOf(scope))) || (narrowed && (drops.includes(scope) || scope in swaps));
  return asked.every(satisfied) ? { readOnly: narrowed && asked.some(scope => drops.includes(scope) || scope in swaps) } : null;
};
async function consentPage() {
  const person = await signedInPerson(() => go('/sign-in'));
  if (!person) return;
  const id = query.get('client_id') ?? '';
  const named = await json(`${authBase}/oauth2/public-client?client_id=${encodeURIComponent(id)}`);
  const clientHost = id.startsWith('https://') ? hostOf(id) : '';
  const returnHost = hostOf(query.get('redirect_uri') ?? '');
  fillAll({ client: named.data?.client_name ?? words.asker_unknown });
  const asked = (query.get('scope') ?? '').split(' ').filter(Boolean);
  listOf('scopes', scopeLines(asked.filter(scope => !Object.values(rules.read_only_swaps).includes(scope)).join(' ')));
  const known = Boolean(clientHost) && (related(returnHost, clientHost) || isLoopback(returnHost));
  // Our own program: the connect goes straight back to it; the person sees only that they are signed in.
  if (known && (await json(`${authBase}/first-party?client_id=${encodeURIComponent(id)}`)).data?.first_party) { show('signedin'); return void consent(document.querySelector('[data-step="review"] [data-consent="allow"]')).then(done => done || show('review')); }
  const before = ((await json(`${authBase}/oauth2/get-consents`)).data ?? []).find(row => row.clientId === id);
  const again = before && known ? rememberedAs(before.scopes ?? [], asked) : null;
  if (again) {
    readOnly = again.readOnly;
    show('remembered');
    return void setTimeout(() => { if (!undone) consent(document.querySelector('[data-step="remembered"] [data-consent]')).catch(() => fail(words.failed)); }, rules.remembered_seconds * 1000);
  }
  if (!known) {
    // Deny is the main button, and the person is told in one plain line.
    document.querySelector('[data-unknown]').hidden = false;
    document.querySelector('[data-step="review"] [data-consent="allow"]').className = 'page-action page-action--quiet';
    document.querySelector('[data-step="review"] [data-consent="deny"]').className = 'page-action';
  }
  show('review');
}
let undone = false;
async function consent(button) {
  const answer = await post(`${authBase}/oauth2/consent`, { accept: button.dataset.consent === 'allow', oauth_query: carried, read_only: readOnly });
  if (answer.ok && answer.data?.url) { location.assign(answer.data.url); return true; }
  refusal(answer, words.failed, 'try-again');
  return false;
}
// Undo on a remembered AI: it is disconnected (its tokens and consent end) and told no.
async function undo() {
  undone = true;
  await post(`${authBase}/connected/revoke`, { clientId: query.get('client_id') });
  const answer = await post(`${authBase}/oauth2/consent`, { accept: false, oauth_query: carried });
  return answer.ok && answer.data?.url ? location.assign(answer.data.url) : refusal(answer, words.failed, 'try-again');
}

// /connected: the AIs the person allowed, what each can do, when it connected and last used, and one tap to disconnect.
const when = iso => new Date(iso).toLocaleString();
async function connectedPage() {
  if (!(await signedInPerson())) return;
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
    add('p', 'page-item-detail', ai.idle_limit_days ? words.connected_limit_days.replace('{days}', ai.idle_limit_days) : words.connected_limit_none);
    if (ai.ended_by) add('p', 'page-item-detail', ai.ended_text ?? words.connected_ended_chain_ended);
    const limit = document.createElement('div'); limit.className = 'page-field';
    const label = document.createElement('label'); label.className = 'page-field-label'; label.textContent = words.connected_limit_label;
    const days = document.createElement('input'); days.className = 'page-field-input'; days.type = 'number'; days.min = '1'; days.step = '1'; days.inputMode = 'numeric'; days.value = ai.idle_limit_days ?? ''; days.dataset.limitFor = ai.client_id; label.append(days);
    const save = document.createElement('button'); save.className = 'page-action'; save.type = 'button'; save.dataset.limitSave = ai.client_id; save.textContent = words.connected_limit_save;
    const clear = document.createElement('button'); clear.className = 'page-action'; clear.type = 'button'; clear.dataset.limitClear = ai.client_id; clear.textContent = words.connected_limit_clear;
    limit.append(label, save, clear); item.append(limit);
    const actions = document.createElement('div'); actions.className = 'page-item-actions';
    if (ai.ended_by && ai.reconnect_url) { const link = document.createElement('a'); link.className = 'page-action'; link.href = ai.reconnect_url; link.textContent = words.connected_reconnect; actions.append(link); }
    else if (ai.ended_by) add('p', 'page-item-detail', words.connected_reconnect_none);
    const button = document.createElement('button'); button.className = 'page-action'; button.type = 'button'; button.dataset.disconnect = ai.client_id; button.textContent = words.disconnect;
    actions.append(button); item.append(actions);
    return item;
  }));
}
// The person's own limit for one AI: a whole number of days unused, or none (the default).
async function setLimit(button, clear) {
  const clientId = clear ? button.dataset.limitClear : button.dataset.limitSave;
  const box = [...document.querySelectorAll('[data-limit-for]')].find(input => input.dataset.limitFor === clientId);
  const days = clear ? null : Number(box.value);
  if (!clear && !(Number.isInteger(days) && days > 0)) return fail(words.failed);
  const done = await post(`${authBase}/connected/limit`, { clientId, days });
  if (!done.ok) return refusal(done, words.failed, 'try-again');
  await connectedPage();
  status(words.connected_limit_saved);
}
async function disconnect(button) {
  const done = await post(`${authBase}/connected/revoke`, { clientId: button.dataset.disconnect });
  if (!done.ok) return refusal(done, words.failed, 'try-again');
  button.closest('li').remove();
  if (!document.querySelector('[data-fill-list="connected"] li')) document.querySelector('[data-fill="none"]').hidden = false;
  status(words.disconnected);
}

// /account: the person's name, email and how they sign in, each with the page that changes it, and deleting the account. Deleting asks for the
// password when the account has one; an account with none is deleted on a sign-in that is still recent (Better Auth's delete-user).
let accountHasPassword = false;
const accountRow = (heading, detail, change) => {
  const item = document.createElement('li'); item.className = 'page-item';
  const title = document.createElement('h2'); title.className = 'page-item-heading'; title.textContent = heading;
  const text = document.createElement('p'); text.className = 'page-item-detail'; text.textContent = detail;
  item.append(title, text);
  if (change) {
    const actions = document.createElement('div'); actions.className = 'page-actions';
    const link = document.createElement('a'); link.className = 'page-action page-action--link'; link.href = change.href; link.textContent = change.text;
    actions.append(link); item.append(actions);
  }
  return item;
};
async function accountPage() {
  const session = await signedInPerson();
  if (!session) return;
  const [passkeys, accounts] = await Promise.all([client.passkey.listUserPasskeys(), client.listAccounts()]);
  const user = session.user;
  const linked = accounts.data ?? [];
  accountHasPassword = linked.some(account => account.providerId === 'credential');
  const others = linked.filter(account => account.providerId !== 'credential').map(account => humane(account.providerId));
  const count = passkeys.data?.length ?? 0;
  const hasName = user.name?.trim() && user.name.trim() !== user.email;
  document.querySelector('[data-fill-list="account"]').replaceChildren(
    accountRow(words.account_name, hasName ? user.name.trim() : words.account_name_unset, { href: '/sign-in/your-name', text: words.account_change }),
    accountRow(words.account_email, user.email, { href: '/sign-in/change-email', text: words.account_change }),
    accountRow(words.account_passkeys, count === 0 ? words.account_passkeys_none : count === 1 ? words.account_passkeys_one : words.account_passkeys_some.replace('{count}', count), { href: '/sign-in/add-passkey', text: words.account_add_passkey }),
    accountRow(words.account_authenticator, user.twoFactorEnabled ? words.account_on : words.account_off),
    accountRow(words.account_password, accountHasPassword ? words.account_password_set : words.account_password_unset),
    accountRow(words.account_other, others.length ? others.join(', ') : words.account_other_none),
  );
  const refused = passkeys.error ?? accounts.error;
  if (refused) refusal(refused, words.unavailable);
}
// The confirm step: the password box only for an account that has a password, cleared each time it is opened.
function deleteStart() {
  const form = document.querySelector('form[action="/account/delete"]');
  form.querySelector('[data-delete-password]').hidden = !accountHasPassword;
  form.querySelector('[name="password"]').value = '';
  show('confirm');
}
async function deleteAccount(form) {
  const box = form.querySelector('[name="password"]');
  if (accountHasPassword && !box.value) return fail(words.account_password_needed, undefined, box);
  const { error } = await client.deleteUser(accountHasPassword ? { password: box.value } : {});
  if (error?.code === 'INVALID_PASSWORD') return fail(words.account_wrong_password, undefined, box);
  if (error?.code === 'SESSION_EXPIRED' || signedOut(error)) return toSignIn();
  if (error) return refusal(error);
  show('deleted');
}

// /device: the code a device showed (RFC 8628 user code), the app that asked and what it may do, then Allow or Deny.
const deviceCode = query.get('user_code');
// A device names itself by its client id (living-room-tv): said as words, and its code in the groups it was shown in.
const humane = id => { const said = id.replace(/[-_]+/g, ' ').trim(); return said.charAt(0).toUpperCase() + said.slice(1); };
const hyphenated = code => { const plain = code.replace(/[^a-z0-9]/gi, '').toUpperCase(); return plain.length > 4 ? `${plain.slice(0, 4)}-${plain.slice(4)}` : plain; };
async function devicePage() {
  if (!deviceCode) return show('code');
  if (!(await signedInPerson(() => go('/sign-in', { next: location.pathname + location.search })))) return;
  const asked = await json(`${authBase}/device?user_code=${encodeURIComponent(deviceCode)}`);
  if (!asked.ok) { show('code'); return refusal(asked, asked.data?.error === 'expired_token' ? words.code_expired : words.code_wrong); }
  if (asked.data.status !== 'pending') return deviceDone(asked.data.status === 'approved');
  if (!asked.data.client_id) { show('code'); return fail(words.code_wrong); }
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
  return answer.ok ? deviceDone(allowed) : refusal(answer, words.failed, 'try-again');
}

document.addEventListener('click', event => {
  const button = event.target.closest('button[data-key], button[data-passkey-link], button[data-undo], button[data-read-only], button[data-details], button[data-disconnect], button[data-limit-save], button[data-limit-clear], button[data-consent], button[data-device], button[data-passkey]');
  if (!button) return;
  event.preventDefault();
  const failed = () => fail(button.dataset.failed ?? words.failed, 'try-again');
  if (button.matches('[data-key]')) makeKey(button).catch(failed);
  else if (button.matches('[data-passkey-link]')) emailTheLink(button).catch(failed);
  else if (button.matches('[data-undo]')) undo().catch(failed);
  else if (button.matches('[data-disconnect]')) disconnect(button).catch(failed);
  else if (button.matches('[data-limit-save]')) setLimit(button, false).catch(failed);
  else if (button.matches('[data-limit-clear]')) setLimit(button, true).catch(failed);
  else if (button.matches('[data-details]')) { const panel = document.querySelector('[data-details-panel]'); panel.hidden = !panel.hidden; button.setAttribute('aria-expanded', String(!panel.hidden)); }
  else if (button.matches('[data-read-only]')) { readOnly = !readOnly; button.setAttribute('aria-pressed', String(readOnly)); button.textContent = readOnly ? words.read_only_on : words.read_only_off; }
  else if (button.matches('[data-consent]')) consent(button).catch(failed);
  else if (button.matches('[data-device]')) device(button).catch(failed);
  else passkey(button).catch(failed);
});

// The sixth digit sends the code; the Sign in button stays for anyone who wants it.
document.addEventListener('page-code-complete', event => event.target.closest('form')?.requestSubmit());

// One send at a time per form, and none once the person is signed in: the sixth digit and Enter or the button can arrive together, and a one-time code works once.
const sending = new WeakSet();
document.addEventListener('submit', event => {
  const form = event.target.closest('form');
  if (!form) return;
  event.preventDefault();
  if (signedIn || sending.has(form)) return;
  sending.add(form);
  submit(form).catch(() => fail(words.unavailable, 'try-again')).finally(() => sending.delete(form));
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
// /account: Delete my account opens the confirm step; Keep my account goes back to the details.
document.addEventListener('click', event => {
  if (event.target.closest('[data-delete-start]')) { event.preventDefault(); deleteStart(); }
  else if (event.target.closest('[data-delete-cancel]')) { event.preventDefault(); show('details'); }
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
const needsSession = async () => { await signedInPerson(); };
const connectPage = { '/consent': consentPage, '/connected': connectedPage, '/account': accountPage, '/device': devicePage, '/sign-in/add-passkey': needsSession, '/sign-in/change-email': needsSession, '/sign-in/your-name': needsSession }[location.pathname];
connectPage?.().catch(() => fail(words.unavailable, 'try-again'));
