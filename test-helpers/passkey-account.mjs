// A browser with a simulated passkey device, and an account made with it, for the proof scripts.
import { createRequire } from 'node:module';
import { launchChromium } from './chromium.mjs';
import { observeProofSignup } from './customer-signup-observation.mjs';
import signInMethods from './sign-in-methods.json' with { type: 'json' };
const { chromium } = createRequire(import.meta.url)('playwright');

// The one-time steps a new account may land on before the workspace (src/sign-in-methods.json after_sign_in.offers):
// each is signed in already.
const offeredSteps = signInMethods.after_sign_in.offers.map(offer => offer.path);

// Playwright appends request and Call log details to many errors. Keep only an
// ordinary first line so cleanup reports cannot print session cookies.
export function safeErrorLine(error) {
  const first = String(error?.message ?? error ?? '').split(/\r?\n/, 1)[0].trim();
  if (!first || /^(?:call log:|request(?:\s|:)|response(?:\s|:)|cookie:|set-cookie:)/i.test(first)) {
    return 'Browser operation failed.';
  }
  return first
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"']+/gi, '[AUTHORIZATION REDACTED]')
    .replace(/\bnm_[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/\b(?:password|token|secret|credential|api[_ -]?key|authorization|cookie)\s*[=:]\s*[^,;\s]+/gi, '[CREDENTIAL REDACTED]');
}

export class ProofBrowserCleanupError extends Error {
  constructor({ accountFailures = [], otherErrors = [], browserClosed = false } = {}) {
    const issues = [
      ...accountFailures.map(failure => `account cleanup failed for ${failure.userId ?? failure.proofName}: ${failure.error}`),
      ...otherErrors.map(error => safeErrorLine(error)),
    ];
    super(issues.join('\n') || 'Proof browser cleanup failed.');
    this.name = 'ProofBrowserCleanupError';
    this.accountFailures = accountFailures;
    this.otherErrors = otherErrors;
    this.browserClosed = browserClosed;
  }
}

// Run the same wrapped close path for process signals that Playwright handles by
// default, then re-raise the signal after Chromium has disconnected. Re-raising
// preserves the normal signal exit status without letting Chromium close first.
export function closeBrowserOnSignals(browser, close, processEvents = process) {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  let closingSignal = null;
  let closePromise = null;
  const removeListeners = () => {
    for (const [signal, listener] of listeners) processEvents.off(signal, listener);
    browser.off('disconnected', removeListeners);
  };
  const listeners = new Map(signals.map(signal => [signal, () => {
    if (closingSignal) return;
    closingSignal = signal;
    closePromise ??= Promise.resolve().then(close);
    void closePromise.catch(error => {
      processEvents.stderr?.write?.(`Browser cleanup failed: ${safeErrorLine(error)}\n`);
    }).finally(() => {
      // A failing close may not emit disconnected, but signal termination must
      // still proceed after the cleanup attempt.
      removeListeners();
      try { processEvents.kill(processEvents.pid, signal); }
      catch (error) { processEvents.stderr?.write?.(`Could not re-raise ${signal}: ${safeErrorLine(error)}\n`); }
    });
  }]));
  for (const [signal, listener] of listeners) processEvents.on(signal, listener);
  browser.once('disconnected', removeListeners);
  if (typeof browser.isConnected === 'function' && !browser.isConnected()) removeListeners();
  return removeListeners;
}

// Closing the browser first deletes every account made in it (createAccount), through the same delete a person gets,
// so a proof leaves no account behind; `createAccount(page, origin, { keep: true })` keeps one that must outlive it.
// `args` go to the browser as it starts (fake camera and microphone for a proof that records), `page` to its page
// (a recording of the proof, permissions).
export async function browserWithPasskeyDevice({ args = [], page: pageOptions = {}, onAccountCleanup = null, handleSignals = true, admission, executablePath, channel, launchTimeout, launchBrowser } = {}) {
  const browserOptions = { args, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, admission, ...(executablePath ? { executablePath } : {}), ...(channel ? { channel } : {}), ...(launchTimeout ? { timeout: launchTimeout } : {}) };
  const browser = launchBrowser
    ? await launchBrowser(browserOptions)
    : process.env.OBSCURA_CDP_URL
      ? await chromium.connectOverCDP(process.env.OBSCURA_CDP_URL)
      : await launchChromium(browserOptions);
  const page = await browser.newPage(pageOptions);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  const close = browser.close.bind(browser);
  let closePromise;
  browser.close = () => closePromise ??= (async () => {
    const accountFailures = [];
    const otherErrors = [];
    for (const made of accountsMadeIn.get(browser) ?? []) {
      const said = await deleteMadeAccount(made).catch(error => `not deleted: ${safeErrorLine(error)}`);
      if (said) {
        const failure = { proofName: made.proofName, userId: made.userId ?? null, origin: made.origin, deleted: false, error: said };
        process.stderr.write(`proof account ${failure.userId ?? failure.proofName} on ${failure.origin}: ${failure.error}\n`);
        accountFailures.push(failure);
      }
      try { await onAccountCleanup?.({ proofName: made.proofName, userId: made.userId ?? null, origin: made.origin, deleted: !said, error: said }); }
      catch (error) { otherErrors.push(error instanceof Error ? error : new Error(safeErrorLine(error))); }
    }
    accountsMadeIn.delete(browser);
    let browserClosed = false;
    try {
      await close();
      browserClosed = true;
    } catch (error) {
      otherErrors.push(error instanceof Error ? error : new Error(safeErrorLine(error)));
    }
    if (accountFailures.length || otherErrors.length) throw new ProofBrowserCleanupError({ accountFailures, otherErrors, browserClosed });
  })();
  if (handleSignals) closeBrowserOnSignals(browser, browser.close);
  return { browser, page };
}

// Adds an independent account surface to an existing proof browser. Each
// context owns its cookies and virtual passkey, while account deletion remains
// registered against the shared browser's close lifecycle.
export async function newPasskeyPage(browser, pageOptions = {}) {
  const context = await browser.newContext(pageOptions);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  return { context, page };
}

const accountsMadeIn = new WeakMap();
// Deletes an account this browser made, signed in again with its passkey when the page was signed out. An account the
// proof already deleted cannot sign in any more, and is left as it is. Answers a line to report, or null when deleted.
export async function deleteMadeAccount({ page, origin, userId, signInAgain, wait = ms => new Promise(done => setTimeout(done, ms)) }) {
  if (page.isClosed()) return 'not deleted: its page was closed';
  if (typeof userId !== 'string' || !userId.trim())
    return 'not deleted: proof account identity was not recorded; exact recovery required';
  // Do not delete whichever session happens to be on this page. A missed
  // signup or an account switch cannot authorize an unbound deletion.
  try {
    const identity = await page.context().request.get(`${origin}/work/api/viewer`, { timeout: 10000 });
    const body = identity.status() === 200 ? await identity.json().catch(() => ({})) : {};
    if (body.user_id !== userId)
      return typeof body.user_id === 'string' ? 'not deleted: browser is signed in to a different account'
        : `not deleted: current browser identity was not verified (HTTP ${identity.status()}); exact recovery required`;
  } catch { return 'not deleted: current browser identity read failed; exact recovery required'; }
  // The browser context shares the page's cookies, but its request is not
  // destroyed if the page navigates while the account is being deleted.
  // Only sign in again if the direct request says its session is gone.
  const deleteOnce = async () => {
    const response = await page.context().request.post(`${origin}/work/api/account/delete`, {
      data: {}, headers: { origin }, timeout: 120000,
    });
    return { status: response.status(), body: await response.json().catch(() => ({})) };
  };
  const askToDelete = async () => {
    const reply = await deleteOnce();
    // Retry only the same account's recognized platform interruption. An input,
    // policy or budget refusal must remain a refusal, and only the deletion
    // acknowledgement below establishes that this account is gone.
    const transient = reply.body.retryable !== false && (
      ['service-busy', 'service-interrupted'].includes(reply.body.code)
      || /Durable Object reset|reset because its code was updated|Network connection lost/i.test(reply.body.error ?? ''));
    if (!transient || String(reply.body.said ?? '').includes('Your account is deleted')) return reply;
    await wait(5000);
    return deleteOnce();
  };
  let reply = await askToDelete();
  if (reply.status === 401 || reply.status === 403 || String(reply.body.redirect ?? '').startsWith('/sign-in?again=1')) {
    const signedIn = await (signInAgain ? signInAgain() : signIn(page, origin)).catch(() => null);
    if (!signedIn) return `not deleted: sign-in failed after HTTP ${reply.status}`;
    if (userId && signedIn !== userId) return 'not deleted: sign-in opened a different account';
    reply = await askToDelete();
  }
  // A plan the proof just ended reaches the account through Stripe's webhook a little later; until then the delete says
  // to cancel first, so it is asked again for up to three minutes (a notice the store was not ready for waits 30 s, then 60 s, in the payments inbox).
  for (let tries = 0; tries < 36; tries += 1) {
    if (String(reply.body.said ?? '').includes('Your account is deleted') || !/Cancel what you pay for first/.test(reply.body.error ?? reply.body.said ?? '')) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
    reply = await askToDelete();
  }
  const detail = safeErrorLine(reply.body.error ?? JSON.stringify(reply.body));
  return String(reply.body.said ?? '').includes('Your account is deleted') ? null : `not deleted: HTTP ${reply.status}, ${detail}`;
}

// The sign-in page's two passkey actions, found by what they do rather than by their words.
export const createAction = page => page.locator('.page-action[href="#create"]').first();
export const signInAction = page => page.locator('.page-action[href="#sign-in"]').first();

// The account the page is signed in to, or null, from the session's own viewer read (its user_id). The Account screen's
// row this once read was removed in 745c8c710, so every proof sign-up failed here after making its account.
export const signedInAccount = page => page.evaluate(async () => {
  const response = await fetch('/work/api/viewer');
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return null;
  return (await response.json()).user_id ?? null;
});

// Register before the action that creates an account. Password proofs keep
// recovery inside their closure rather than storing a password in proof files.
export function registerMadeAccount(page, origin, { proofName, signInAgain } = {}) {
  const browser = page.context().browser();
  const made = { page, origin, proofName, ...(signInAgain ? { signInAgain } : {}) };
  accountsMadeIn.set(browser, [...(accountsMadeIn.get(browser) ?? []), made]);
  return made;
}

// Signs out (the workspace's own sign-out) and signs in again with the device's passkey; resolves to the account it
// opened the workspace for, or null. Signing out first matters: a signed-in browser's /account opens the workspace, which has
// no sign-in action to press.
export async function signIn(page, origin) {
  try {
    await page.goto(`${origin}/work/sign-out`);
    await page.waitForURL(url => url.pathname === '/account', { timeout: 30000 });
    await signInAction(page).click();
    // A sign-in lands in the workspace, or first on the one-time step that offers a sign-in email; either is signed in.
    const opened = await page.waitForURL(url => url.origin === origin && ['/', '/sign-in/add-email', ...offeredSteps].includes(url.pathname), { timeout: 30000, waitUntil: 'commit' }).then(() => true, () => false);
    return opened ? signedInAccount(page) : null;
  } catch (error) {
    throw new Error(safeErrorLine(error));
  }
}

// Creates an account on `origin`, which opens signed in on the workspace (a creation that does not fails here), and returns a
// personal key made from its Account screen for the proof's API calls. The account is deleted when the browser closes.
// `navigate: false` makes it on the sign-in page already open (reached from an invite or another page with its own
// `next`), and accepts wherever that page then lands.
export async function createAccount(page, origin, { keep = false, makeKey = true, navigate = true, onRegistered = null, onIdentity = null, onCreated = null, onNavigationFailure = null, onNavigationRecovered = null } = {}) {
  if (navigate) await page.goto(`${origin}/account?create`);
  // Named as a proof (src/proof-account-names.json), so the operator's sweep of unused accounts removes one a proof
  // could not delete itself, files and all; a person's own account is never named this way.
  const proofName = `trillion-proof+${Date.now()}@example.test`;
  // The one sign-in form (d447c47) names a new passkey from its Email and Name fields; older pages had passkey_name.
  for (const field of ['passkey_name', 'email', 'name', 'given_name', 'family_name']) {
    const input = page.locator(`input[name="${field}"]`);
    // The sign-up form asks for a first and last name; a proof gives it "Proof" and "Account".
    if (await input.count()) await input.first().fill(field === 'given_name' ? 'Proof' : field === 'family_name' ? 'Account' : proofName);
  }
  // A click can create the account before a later navigation times out.
  // Register cleanup before that click, then use the URL commit as the proof
  // of arrival; late page assets need not finish loading.
  const made = keep ? null : registerMadeAccount(page, origin, { proofName });
  // Record exact signup intent before the one mutating signup click.
  await onRegistered?.({ proofName });
  // Sign-up needs a first and last name (c5457196a); a proof's are fixed words.
  for (const [field, value] of [['given_name', 'Proof'], ['family_name', 'Account']]) {
    const input = page.locator(`input[name="${field}"]`);
    if (await input.count()) await input.first().fill(value);
  }
  let boundIdentity = null;
  const bindIdentity = async (userId, identity_basis) => {
    if (boundIdentity === userId) return;
    if (boundIdentity) throw new Error('Signup changed the bound proof account identity.');
    if (made) made.userId = userId;
    boundIdentity = userId;
    await onIdentity?.({ proofName, userId, ...(identity_basis ? { identity_basis } : {}) });
  };
  const observation = observeProofSignup(page, { origin, proofName });
  let originalNavigationError = null;
  try {
    await createAction(page).click();
    await page.waitForURL(url => url.origin === origin && (navigate ? ['/', '/sign-in/add-email', ...offeredSteps].includes(url.pathname) : url.pathname !== '/account'), { timeout: 30000, waitUntil: 'commit' });
  } catch (error) {
    originalNavigationError = error;
    const userId = await observation.matchingSessionIdentity();
    try {
      // Preserve the original failure before the existing-session continuation.
      await onNavigationFailure?.({ proofName, userId, error: String(error.message ?? error), continuation_planned: Boolean(navigate && userId) });
      if (userId) await bindIdentity(userId, 'original-signup-response-and-session-read-after-navigation-failure');
      if (!navigate || !userId) throw error;
      // Main's ordinary root continuation is admitted only for this exact
      // original registration and session. No signup or sign-in is repeated.
      await page.goto(`${origin}/`, { waitUntil: 'commit' });
      if (await signedInAccount(page) !== userId) throw error;
      await onNavigationRecovered?.({ proofName, userId, route: 'existing-session-open-root' });
    } catch { throw error; }
  } finally { observation.stop(); }
  const userId = await signedInAccount(page);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId ?? '') || boundIdentity && boundIdentity !== userId)
    throw originalNavigationError ?? new Error('Created proof account returned no exact browser identity.');
  await bindIdentity(userId);
  if (!makeKey) return null;
  const key = await page.evaluate(async () => (await (await fetch('/work/api/account/keys/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).reveal.text);
  // Persist recovery access before the authenticated identity check. If a later
  // probe is interrupted, the proof still has the one-time key it already made.
  await onCreated?.({ userId, key });
  const authenticatedUserId = await page.evaluate(async key => (await (await fetch('/mcp/api/account', { headers: { authorization: `Bearer ${key}` } })).json()).user_id ?? null, key);
  if (authenticatedUserId !== userId)
    throw new Error('Created proof account key identity did not match browser account.');
  return key;
}
