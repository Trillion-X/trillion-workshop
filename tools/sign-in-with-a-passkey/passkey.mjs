// Runs the ways in on the sign-in pages: the email-and-password form, the passkey step and the emailed codes. It
// attaches to the forms and actions the page already shows and only sets text.
import { authenticate } from '@passwordless-id/webauthn/dist/esm/client.js';
import { makePasskey, PASSKEY_STEP, passkeyStepEnded } from '../passkey-step.mjs';
import { passwordStrengthSaid } from '../password-strength.mjs';
import { loadingMark, startWork } from '../../parts/ui/show/server-rendered-page/page-work.mjs';
import SIGN_IN_METHODS from '../sign-in-methods.json' with { type: 'json' };
import PASSWORD_WORDS from '../passwords.json' with { type: 'json' };
import { signInAgainAddress } from '../sign-in-again.mjs';
import { suppliedProfileNames } from '../profile-names.mjs';
import { forgetKeptValues } from '../../parts/ui/show/request/kept-values.ts';
import { chooseStillWorkingWords } from '../../parts/ui/show/still-working/still-working.ts';
import firstAnswers from '../workspace/first-answers.json' with { type: 'json' };

const requestId = new URLSearchParams(location.search).get('request');
let activeStatus = null;
const status = () => activeStatus ?? document.querySelector('.page-status');
// What the page says under its actions; a failure is marked so it reads as one.
const say = (text, tone) => { const target = status(); if (!target) return; target.textContent = text; if (tone) target.dataset.pageTone = tone; else delete target.dataset.pageTone; };
// Each pressed button says what its work is doing in itself (page-work.mjs), in the words for that work.
const WORK = SIGN_IN_METHODS.work;
// A pressed button whose work runs long says it is still working, in these words.
chooseStillWorkingWords(SIGN_IN_METHODS.still_working);
// A done button stays in sight a moment before the page moves on, so the person sees it worked.
const DONE_MS = 600;
const shown = () => new Promise(resolve => setTimeout(resolve, DONE_MS));

// A choice shown as chips (src/pages.mjs): the one picked is marked selected, which is what the page sends.
const picked = prefix => [...document.querySelectorAll(`.page-chip--selected[href^="#${prefix}:"]`)].map(chip => decodeURIComponent(chip.getAttribute('href').slice(prefix.length + 2)));
const mark = (chip, on) => { chip.classList.toggle('page-chip--selected', on); chip.setAttribute('aria-pressed', String(on)); chip.removeAttribute('aria-current'); };
// What a connecting app may reach: one choice of several.
const reachChoice = () => picked('reach')[0];

async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Something went wrong. Please try again.'), { result });
  return result;
}

// The person's password manager kept in step with their account (the WebAuthn Signal API, src/passkey-options.mjs): a
// passkey the service does not know is dropped, and after a sign-in only the account's own passkeys stay, shown under
// its name. A browser without the API is left as it is, and a signal it refuses never stops signing in.
async function forgetPasskey(signal) {
  if (!signal || typeof PublicKeyCredential?.signalUnknownCredential !== 'function') return;
  await PublicKeyCredential.signalUnknownCredential({ rpId: signal.rp_id, credentialId: signal.credential_id }).catch(() => {});
}
async function keepPasskeys(signal) {
  if (!signal || typeof PublicKeyCredential === 'undefined') return;
  if (typeof PublicKeyCredential.signalAllAcceptedCredentials === 'function') await PublicKeyCredential.signalAllAcceptedCredentials({ rpId: signal.rp_id, userId: signal.user_id, allAcceptedCredentialIds: signal.accepted_credential_ids }).catch(() => {});
  if (signal.name && typeof PublicKeyCredential.signalCurrentUserDetails === 'function') await PublicKeyCredential.signalCurrentUserDetails({ rpId: signal.rp_id, userId: signal.user_id, name: signal.name, displayName: signal.display_name }).catch(() => {});
}

// Return the code in this tab so the app's registered callback receives it. The browser cannot confirm that
// the app exchanged the code, so this page must not claim the connection succeeded.
async function returnToApp(redirect) {
  document.documentElement.dataset.authState = 'returning';
  const target = new URL(redirect, location.href);
  location.assign(target.href);
}

// Where an error points next: the page action its answer names (`next.action`, matched with any ?next it carries), else
// the button that was pressed, to try again. A way in added without a recent sign-in (`sign_in_again`) opens sign-in,
// which comes back here.
let pressed = null;
function pointAt(result) {
  if (result?.sign_in_again) { location.assign(signInAgainAddress(location.pathname + location.search)); return; }
  const href = result?.next?.action;
  const named = href ? [...document.querySelectorAll('.page-action')].find(link => { const at = link.getAttribute('href') ?? ''; return at === href || at.startsWith(`${href}?`); }) : null;
  (named ?? pressed)?.focus();
}

// Where the passkey offer carries on to: its Skip link.
const carryOnHref = () => document.querySelector('.page-action[href^="/"]')?.getAttribute('href') ?? '/';

// One passkey step at a time: a second press while one is working would cancel the first in the browser's dialog.
let working = false;
async function run(action, offerId, target, button = pressed) {
  if (working) return;
  working = true;
  activeStatus = target ?? document.querySelector('.page-status');
  const mode = { create: 'create', link: 'link', 'add-here': 'add' }[action] ?? 'sign-in';
  const code = new URLSearchParams(location.search).get('add_passkey');
  const purpose = { buy: 'buy', 'add-passkey': 'add-passkey' }[action];
  say('');
  const work = startWork(button, WORK[mode === 'sign-in' ? 'passkey_sign_in' : 'passkey_create']);
  try {
    // A new passkey is saved for Trillion under the email (else the name) typed on the page, so it is easy to find in
    // Passwords.
    const profile = mode === 'create' ? suppliedProfileNames(Object.fromEntries(['name', 'given_name', 'family_name'].map(field => [field, fieldValue(field)]))) : null;
    const name = ['passkey_name', 'email'].map(field => fieldValue(field)).find(Boolean) || profile?.name || fieldValue('name');
    const { challenge_id, options } = await post('/passkey/options', { mode, ...(mode === 'link' ? { code } : {}), ...(mode !== 'sign-in' && name ? { name } : {}), ...(mode === 'create' ? { profile } : {}) });
    const response = mode === 'sign-in' ? await authenticate(options) : await makePasskey(options);
    // A page that sent the person here to sign in (a community page) is where they return to.
    const next = new URLSearchParams(location.search).get('next');
    const result = await post('/passkey/finish', { mode, challenge_id, response, request_id: requestId, purpose, offer_id: offerId, ...(name ? { name } : {}), ...(next ? { next } : {}), ...(requestId ? { reach_choice: reachChoice() } : {}), ...(mode === 'create' && fieldValue('setup_access_notice') ? { setup_access_notice: fieldValue('setup_access_notice') } : {}) });
    await keepPasskeys(result.keep_passkeys);
    // Signed in; now the new passkey, on the same account.
    if (result.add) {
      say('Signed in. Now make your new passkey…');
      const added = await post('/passkey/finish', { mode: 'add', challenge_id: result.add.challenge_id, response: await makePasskey(result.add.options) });
      say('');
      work.done();
      await shown();
      location.assign(added.redirect);
      return;
    }
    work.done();
    if (result.redirect && mode === 'link') { await shown(); location.assign(result.redirect); return; }
    if (mode === 'add') { await shown(); location.assign(carryOnHref()); return; }
    if (result.redirect && requestId) { await returnToApp(result.redirect); return; }
    if (result.redirect) { await shown(); location.assign(result.redirect); return; }
  } catch (error) {
    await forgetPasskey(error?.result?.forget_passkey);
    // Signing in with no passkey for this site ends the same way as cancelling, so the message names both and says
    // where a new person starts.
    // A phone scanned for signing in that has no Trillion passkey ends here too: Create is where it goes next.
    const noPasskey = mode === 'sign-in' && (error?.name === 'NotAllowedError' || /not linked to a Trillion account/.test(error?.message ?? ''));
    const ended = passkeyStepEnded(noPasskey ? { name: 'NotAllowedError' } : error, mode === 'sign-in' ? 'sign-in' : 'make');
    // This device already holds a passkey for the account: the step is done, so the page carries on.
    if (ended.already && mode === 'add') { work.done(); say(`${ended.said} ${PASSKEY_STEP.opening}`); location.assign(carryOnHref()); return; }
    work.failed();
    say(ended.said, 'error');
    if (noPasskey) document.querySelector('input[name="email"]')?.focus();
    else if (error?.result?.needs_names) document.querySelector('input[name="given_name"], input[name="family_name"]')?.focus();
    else if (error?.result?.needs_name) document.querySelector('input[name="email"], input[name="passkey_name"]')?.focus();
    else pointAt(error?.result);
  } finally {
    working = false;
  }
}

// Connecting an app on a browser already signed in: one press, with the reach picked on the page.
async function connectSignedIn(button) {
  const work = startWork(button, WORK.connect);
  try {
    const result = await post('/sign-in/connect', { request_id: requestId, reach_choice: reachChoice() });
    work.done();
    await returnToApp(result.redirect);
  } catch (error) {
    work.failed();
    say(String(error?.message || error), 'error');
  }
}

// Connecting an app that may reach only the spaces the person picks.
async function connectSpaces(button) {
  const params = new URLSearchParams(location.search);
  const work = startWork(button, WORK.connect);
  try {
    const result = await post('/sign-in/spaces', { request_id: params.get('request'), pick: params.get('pick'), spaces: picked('space') });
    work.done();
    await returnToApp(result.redirect);
  } catch (error) {
    work.failed();
    say(String(error?.message || error), 'error');
  }
}

// A code typed on a code page: one emailed to an address (src/sign-in-email.mjs), asked for first, or a backup code
// (src/sign-in-methods.mjs). The page's own address names what the code is for (/sign-in/email signs in,
// /sign-in/add-email adds the email, /sign-in/backup-code and /sign-in/authenticator sign in,
// /sign-in/authenticator/setup turns an authenticator app on), and its /send and /finish answer.
const fieldValue = name => document.querySelector(`input[name="${name}"]`)?.value.trim() ?? '';

// A page in steps (src/pages.mjs codeStep): the address is asked for on one step and the code typed on its own next
// step, one shown at a time; the browser's Back goes back a step.
const stepSections = name => [...document.querySelectorAll(`.page-section[data-page-step="${name}"]`)];
function showStep(name, remember = true) {
  const steps = [...document.querySelectorAll('.page-section[data-page-step]')];
  if (!steps.some(section => section.dataset.pageStep === name)) return false;
  for (const section of steps) section.hidden = section.dataset.pageStep !== name;
  if (remember && history.state?.step !== name) history.pushState({ step: name }, '');
  return true;
}
window.addEventListener('popstate', () => {
  const step = history.state?.step ?? 'ask';
  if (showStep(step, false) && step === 'ask') stepSections('ask')[0]?.querySelector('input[name="sign_in_email"], input[name="sign_in_phone"], input[name="email"]')?.focus();
});
// The code step, for the address the code went to: what the service said about it, and its first box ready.
function toCodeStep(email, said) {
  if (!showStep('code')) return false;
  for (const at of document.querySelectorAll('[data-page-sent-to]')) at.textContent = email;
  const section = stepSections('code')[0];
  const body = section.querySelector('.page-body');
  if (body && said) body.textContent = said;
  activeStatus = section.querySelector('.page-status');
  say('');
  section.querySelector('.page-code-box')?.focus();
  startWait(section.querySelector('[data-page-cooldown]'));
  return true;
}
// Sending a new code waits its cooldown after each send, counting down on the link itself.
const waits = new Map();
function startWait(link) {
  if (!link) return;
  const label = waits.get(link)?.label ?? link.textContent;
  clearInterval(waits.get(link)?.timer);
  let left = Number(link.dataset.pageCooldown);
  const tick = () => {
    if (left <= 0) { clearInterval(waits.get(link)?.timer); link.textContent = label; link.removeAttribute('data-page-waiting'); link.removeAttribute('aria-disabled'); return; }
    link.textContent = `${label} in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    left -= 1;
  };
  link.setAttribute('data-page-waiting', '');
  link.setAttribute('aria-disabled', 'true');
  waits.set(link, { label, timer: setInterval(tick, 1000) });
  tick();
}
// The email the ask step holds: the sign-in, sign-up and code pages each name it their own way.
const askedEmail = () => fieldValue('sign_in_phone') || fieldValue('sign_in_email') || fieldValue('email');
const signUpForm = () => document.querySelector('form.page-choices[action="/sign-up"]');
// A wrong code empties its boxes for the next try.
const clearCode = () => document.querySelector('.page-section:not([hidden]) [data-page-code] .page-code-box')?.dispatchEvent(new CustomEvent('page-code-clear', { bubbles: true }));

async function codeStep(step, target, button) {
  activeStatus = target ?? document.querySelector('.page-status');
  // Making an account: the form on the first step sends the code, and the code sends the form.
  const form = signUpForm();
  if (form && step === 'finish') return sendPasswordForm(form, fieldValue('sign_in_code'), button);
  if (step === 'next') {
    const email = askedEmail();
    if (!email) { say('Type the email your Trillion account uses.', 'error'); document.querySelector('input[name="sign_in_email"]')?.focus(); return; }
    toCodeStep(email);
    return;
  }
  say('');
  const work = startWork(button, WORK[step === 'finish' ? 'code_finish' : 'code_send']);
  try {
    if (step === 'send' || step === 'resend') {
      const email = askedEmail();
      const result = form ? await post('/sign-up/send', { email, given_name: fieldValue('given_name'), family_name: fieldValue('family_name') }) : await post(`${location.pathname}/send`, location.pathname.includes('phone') ? { phone: email } : { email });
      if (step === 'resend') { work.idle(); say(result.said); startWait(document.querySelector('[data-page-cooldown]')); return; }
      work.done();
      await shown();
      work.idle();
      if (!toCodeStep(email, result.said)) say(result.said);
      return;
    }
    // Sent from an app's connecting page, the code connects that app with the reach picked there.
    const params = new URLSearchParams(location.search);
    const next = params.get('next');
    const email = fieldValue('sign_in_email');
    const phone = fieldValue('sign_in_phone');
    const connect = requestId ? { request_id: requestId, ...(params.get('reach') ? { reach_choice: params.get('reach') } : {}) } : {};
    // Resetting a password sends the new one with its code; it is read as typed, never trimmed.
    const password = document.querySelector('input[name="password"]')?.value;
    const result = await post(`${location.pathname}/finish`, { ...(email ? { email } : {}), ...(phone ? { phone } : {}), code: fieldValue('sign_in_code'), ...(password ? { password } : {}), ...(next ? { next } : {}), ...connect });
    work.done();
    await shown();
    location.assign(result.redirect);
  } catch (error) {
    work.failed();
    say(String(error?.message || error), 'error');
    if (step === 'finish') clearCode();
    else pointAt(error?.result);
  }
}

// The email-and-password form (src/pages.mjs authForm, and setting a password): its fields are sent as typed, with
// the reach picked on an app's connecting page. Signed in, the page opens where the answer says, or returns to the app.
const PASSWORD_FORMS = ['/sign-in/password', '/sign-up', '/sign-in/set-password'];
async function sendPasswordForm(form, code = null, button = null) {
  if (working) return;
  working = true;
  const signUp = form.getAttribute('action') === '/sign-up';
  // Making an account: the code is typed on its own step, and what that step says is written there.
  activeStatus = (signUp && code !== null ? stepSections('code')[0] : form.closest('.page-section'))?.querySelector('.page-status');
  pressed = button ?? form.querySelector('[type="submit"]');
  let work = null;
  try {
    const body = { ...Object.fromEntries(new FormData(form)), ...(code !== null ? { code } : {}) };
    // A new password typed twice is sent only when both are the same.
    if (typeof body.password_again === 'string' && body.password_again !== body.password) {
      say(PASSWORD_WORDS.words.not_the_same, 'error');
      form.querySelector('input[name="password_again"]')?.focus();
      return;
    }
    // Making an account confirms its email first: Create account emails a code, and the code is typed on the next step.
    say('');
    if (signUp && code === null) {
      work = startWork(pressed, WORK.sign_up_send);
      const sent = await post('/sign-up/send', { email: body.email, given_name: body.given_name, family_name: body.family_name });
      work.done();
      await shown();
      work.idle();
      if (!toCodeStep(body.email, sent.said)) say(sent.said);
      return;
    }
    work = startWork(pressed, WORK[signUp ? 'sign_up_finish' : form.getAttribute('action') === '/sign-in/set-password' ? 'password_set' : 'password_sign_in']);
    const next = new URLSearchParams(location.search).get('next');
    const result = await post(form.getAttribute('action'), { ...body, ...(next && !body.next ? { next } : {}), ...(requestId ? { request_id: requestId, reach_choice: reachChoice() } : {}) });
    work.done();
    if (result.redirect && requestId) { await returnToApp(result.redirect); return; }
    await shown();
    location.assign(result.redirect);
  } catch (error) {
    work?.failed();
    say(String(error?.message || error), 'error');
    if (signUp && code !== null) clearCode();
    else pointAt(error?.result);
  } finally {
    working = false;
  }
}

// The other ways in keep where the person was going and the app connecting, the reach picked on its page, and the
// email already typed, so moving between them never asks twice.
const WAYS_IN = ['/sign-in', '/sign-in/email', '/sign-in/forgot-password', '/sign-in/backup-code', '/sign-in/authenticator'];
function carryOver(link) {
  const href = link.getAttribute('href') ?? '';
  const [path, own = ''] = href.split('?');
  if (!WAYS_IN.includes(path)) return;
  link.addEventListener('click', () => {
    const query = new URLSearchParams(own);
    const here = new URLSearchParams(location.search);
    for (const name of ['request', 'next']) if (here.get(name) && !query.has(name)) query.set(name, here.get(name));
    if (requestId && reachChoice()) query.set('reach', reachChoice());
    const email = fieldValue('email') || fieldValue('sign_in_email');
    if (email && path !== '/sign-in') query.set('email', email);
    const search = query.toString();
    link.setAttribute('href', search ? `${path}?${search}` : path);
  });
}

// Connecting an app with a personal key instead of a passkey.
async function signInWithKey(button) {
  const field = document.querySelector('input[name="personal_key"]');
  const work = startWork(button, WORK.key);
  try {
    const result = await post('/key/finish', { personal_key: field?.value ?? '', request_id: requestId, reach_choice: reachChoice() });
    if (field) field.value = '';
    work.done();
    await returnToApp(result.redirect);
  } catch (error) {
    work.failed();
    say(String(error?.message || error), 'error');
  }
}

// Every action the page shows, attached once per paint (the first, and each repaint of the person's own screen).
function attach(root) {
  // Reach choices are one of several; spaces are any number.
  for (const chip of root.querySelectorAll('.page-chip[href^="#reach:"], .page-chip[href^="#space:"]')) {
    const single = chip.getAttribute('href').startsWith('#reach:');
    mark(chip, chip.classList.contains('page-chip--selected'));
    chip.addEventListener('click', event => {
      event.preventDefault();
      if (single) for (const other of root.querySelectorAll('.page-chip[href^="#reach:"]')) mark(other, other === chip);
      else mark(chip, !chip.classList.contains('page-chip--selected'));
    });
  }
  for (const form of root.querySelectorAll('form.page-choices')) {
    if (PASSWORD_FORMS.includes(form.getAttribute('action'))) form.addEventListener('submit', event => { event.preventDefault(); sendPasswordForm(form); });
  }
  for (const link of root.querySelectorAll('.page-field-link, .page-prompt-link')) carryOver(link);
  for (const link of root.querySelectorAll('.page-action')) {
    if (link.getAttribute('href') === '#connect-signed-in') { link.addEventListener('click', event => { event.preventDefault(); connectSignedIn(link); }); continue; }
    if (link.getAttribute('href') === '#connect-spaces') { link.addEventListener('click', event => { event.preventDefault(); connectSpaces(link); }); continue; }
    if (link.getAttribute('href') === '#key') { link.addEventListener('click', event => { event.preventDefault(); signInWithKey(link); }); continue; }
    const href = link.getAttribute('href') ?? '';
    // An offer's action names it: #buy:<offer id>.
    if (href.startsWith('#buy:')) { link.addEventListener('click', event => { event.preventDefault(); run('buy', decodeURIComponent(href.slice('#buy:'.length)), link.closest('.page-section')?.querySelector('.page-status'), link); }); continue; }
    const codeAction = { '#code-send': 'send', '#code-finish': 'finish', '#code-resend': 'resend', '#code-next': 'next' }[href];
    if (codeAction) {
      link.addEventListener('click', event => {
        event.preventDefault();
        if (link.hasAttribute('data-page-waiting') || link.hasAttribute('data-page-work')) return;
        pressed = link;
        codeStep(codeAction, link.closest('.page-section')?.querySelector('.page-status'), link);
      });
      continue;
    }
    // Change email: back to the step that asks for it (the browser's Back does the same).
    if (href === '#code-change') { link.addEventListener('click', event => { event.preventDefault(); if (history.state?.step === 'code') history.back(); else showStep('ask', false); }); continue; }
    // Skip on an offer after signing in: this device is not offered that way in again (the Worker keeps it as a cookie).
    if (link.dataset.pageSkip) {
      link.addEventListener('click', event => { event.preventDefault(); void fetch('/sign-in/skip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: link.dataset.pageSkip }), keepalive: true }).finally(() => location.assign(href)); });
      continue;
    }
    carryOver(link);
    const action = { '#sign-in': 'sign-in', '#create': 'create', '#open-work': 'open-work', '#add-passkey': 'add-passkey', '#link-passkey': 'link', '#add-here': 'add-here' }[href];
    if (action) link.addEventListener('click', event => { event.preventDefault(); pressed = link; run(action, undefined, link.closest('.page-section')?.querySelector('.page-status'), link); });
  }
}
attach(document);
// A failure that tries again by itself (an action's `again_seconds`, src/page-words.json): the action says its pending
// words in itself, then is pressed. At most AGAIN_TRIES times for one address in this tab, so a failure that keeps
// failing settles on its Try again and the person's AI.
const AGAIN_TRIES = 2;
for (const link of document.querySelectorAll('.page-action[data-page-again]')) {
  const href = link.getAttribute('href');
  const counted = `trillion.again:${href}`;
  let tried = 0;
  try { tried = Number(sessionStorage.getItem(counted)) || 0; } catch { tried = AGAIN_TRIES; }
  if (!href || tried >= AGAIN_TRIES) continue;
  startWork(link);
  setTimeout(() => {
    try { sessionStorage.setItem(counted, String(tried + 1)); } catch { /* the press still happens */ }
    location.assign(href);
  }, Number(link.dataset.pageAgain) * 1000);
}
// A page that is only waiting (returning to an app) shows the one loading animation beside what it is waiting for.
for (const heading of document.querySelectorAll('.page-section--auth-progress .page-heading')) heading.prepend(loadingMark());
// A new password's hint says how strong it is as it is typed (src/password-strength.mjs).
document.addEventListener('input', event => {
  const input = event.target;
  if (!input?.hasAttribute?.('data-page-strength')) return;
  const hint = document.getElementById(`${input.id}-hint`);
  if (hint) hint.textContent = passwordStrengthSaid(input.value);
});
// A whole code sends itself, once the step's other boxes (a new password) are filled too.
document.addEventListener('page-code-complete', event => {
  const section = event.target.closest('.page-section');
  const empty = [...(section?.querySelectorAll('.page-field-input') ?? [])].find(input => !input.value);
  if (empty) { empty.focus(); return; }
  section?.querySelector('.page-action[href="#code-finish"]')?.click();
});
// A page that offers signing in is seen by someone signed out: every account's workspace answers kept on this
// computer are deleted, so the next person to use it finds none (src/kept-answers.mjs).
if (document.querySelector('.page-action[href="#sign-in"], .page-action[href="#create"]')) void forgetKeptValues(name => name.startsWith(firstAnswers.kept.store_prefix));
