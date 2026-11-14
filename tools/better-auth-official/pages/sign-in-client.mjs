// tools/better-auth-official/pages/sign-in-client.mjs
//
// What the sign-in pages' forms and buttons do: each calls Better Auth through its official client (better-auth/client
// with the passkey, email OTP and two-factor client plugins, as the docs show). The pages themselves are plain HTML in
// this folder; this script only reads their own forms (by action and hidden `way`) and buttons (data-passkey), and the
// words it may show are words.json. Bundled to assets/sign-in.js by `npm run build-pages`.
import { createAuthClient } from 'better-auth/client';
import { emailOTPClient, twoFactorClient } from 'better-auth/client/plugins';
import { passkeyClient } from '@better-auth/passkey/client';
import words from './words.json' with { type: 'json' };

const client = createAuthClient({ plugins: [passkeyClient(), emailOTPClient(), twoFactorClient()] });
const query = new URLSearchParams(location.search);
// Where to go after signing in: a same-origin path only, else the app's front page.
const next = (() => { const asked = query.get('next') ?? '/'; return asked.startsWith('/') && !asked.startsWith('//') ? asked : '/'; })();
const email = query.get('email') ?? '';
const go = (path, values = {}) => {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries({ ...values, next })) if (value) url.searchParams.set(key, value);
  location.assign(url.pathname + url.search);
};
const status = text => { const box = document.querySelector('.page-status'); if (box) box.textContent = text; };
const refusal = (error, fallback = words.failed) => status(error?.status === 429 ? words.too_many : fallback);
const field = (form, name) => form.querySelector(`[name="${name}"]`)?.value?.trim() ?? '';

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
  if (action === '/sign-in') return go('/sign-in', { email: field(form, 'email') });
  if (action === '/sign-out') {
    const { error } = await client.signOut();
    return error ? refusal(error) : location.assign('/sign-in');
  }
  if (action === '/sign-up/password') {
    const name = [field(form, 'given_name'), field(form, 'family_name')].filter(Boolean).join(' ');
    const { error } = await client.signUp.email({ name, email: field(form, 'email'), password: form.querySelector('[name="password"]').value });
    return error ? refusal(error) : go('/sign-in/add-passkey');
  }
  // No text-message channel is set up for Better Auth here, so the text-code way answers with the page's own words.
  if (way === 'text-code') return status(words.unavailable);
  if (action === '/sign-in/way/send') {
    const to = field(form, 'sign_in_email') || email;
    const { error } = await client.emailOtp.sendVerificationOtp({ email: to, type: reset ? 'forget-password' : 'sign-in' });
    if (error) return refusal(error, words.not_sent);
    return reset ? go('/sign-in/forgot-password', { sent: '1', email: to }) : go('/sign-in/way', { way: 'email-code', sent: '1', email: to });
  }
  if (action === '/sign-in/way' && way === 'password') {
    const { data, error } = await client.signIn.email({ email: field(form, 'sign_in_email'), password: form.querySelector('[name="password"]').value });
    if (error) return refusal(error);
    return data?.twoFactorRedirect ? go('/sign-in/way', { way: 'authenticator' }) : go(next);
  }
  if (action === '/sign-in/way' && way === 'email-code' && reset) {
    const to = field(form, 'sign_in_email') || email, password = form.querySelector('[name="new_password"]').value;
    const { error } = await client.emailOtp.resetPassword({ email: to, otp: field(form, 'code'), password });
    if (error) return refusal(error);
    const signed = await client.signIn.email({ email: to, password });
    return signed.error ? go('/sign-in', { email: to }) : go(next);
  }
  if (action === '/sign-in/way' && way === 'email-code') {
    const { error } = await client.signIn.emailOtp({ email: field(form, 'sign_in_email') || email, otp: field(form, 'code') });
    return error ? refusal(error) : go('/sign-in/add-passkey');
  }
  if (action === '/sign-in/way' && way === 'authenticator') {
    const { error } = await client.twoFactor.verifyTotp({ code: field(form, 'code') });
    return error ? refusal(error) : go(next);
  }
  if (action === '/sign-in/way' && way === 'backup-codes') {
    const { error } = await client.twoFactor.verifyBackupCode({ code: field(form, 'code') });
    return error ? refusal(error) : go(next);
  }
  return status(words.unavailable);
}

// Each passkey button, by its purpose: sign in, make one now (signed in), or start an account by email code first.
async function passkey(button) {
  const purpose = button.dataset.purpose;
  if (purpose === 'sign-in') {
    const { error } = await client.signIn.passkey();
    return error ? status(button.dataset.failed ?? words.failed) : go(next);
  }
  if (purpose === 'register') {
    const name = document.querySelector('[name="passkey-name"]')?.value?.trim() || undefined;
    const { error } = await client.passkey.addPasskey({ name });
    return error ? status(button.dataset.failed ?? words.failed) : go(next);
  }
  if (purpose === 'sign-up') {
    const to = field(button.closest('section') ?? document, 'email');
    if (!to) return status(words.email_needed);
    const { error } = await client.emailOtp.sendVerificationOtp({ email: to, type: 'sign-in' });
    return error ? refusal(error, words.not_sent) : go('/sign-in/way', { way: 'email-code', sent: '1', email: to });
  }
}

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
document.addEventListener('click', event => {
  const button = event.target.closest('button[data-passkey]');
  if (!button) return;
  event.preventDefault();
  passkey(button).catch(() => status(button.dataset.failed ?? words.failed));
});
