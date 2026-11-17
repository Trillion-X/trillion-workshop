// tools/better-auth-official/test/pages.test.mjs
//
// The sign-in pages are this tool's own files, answered with the content security policy pages/routes.json gives: every
// script a page runs is allowed by it (an inline script by its sha256, the tool's own script by 'self'), nothing else is,
// and no page names anything outside this tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { pageAnswer, table } from '../pages.mjs';

const dir = new URL('../pages/', import.meta.url);
const sectionFiles = readdirSync(new URL('sections/', dir)).filter(name => name.endsWith('.html'));
const shell = readFileSync(new URL('shell.html', dir), 'utf8');
const csp = table.headers['content-security-policy'];
const scriptSrc = csp.split(';').map(part => part.trim()).find(part => part.startsWith('script-src ')).split(' ').slice(1);
const urlOf = ({ path, query = {} }) => `${path}?${new URLSearchParams(Object.fromEntries(Object.entries(query).map(([key, value]) => [key, value === '*' ? 'someone@example.test' : value])))}`;
const page = url => pageAnswer(url)?.body.toString() ?? '';

test('every address in routes.json answers its page with the policy, the referrer rule and the frame rule', () => {
  for (const route of table.routes.filter(row => !row.redirect)) {
    const answer = pageAnswer(urlOf(route));
    assert.ok(answer, `${urlOf(route)} answers a page`);
    assert.equal(answer.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(answer.headers['content-security-policy'], csp);
    assert.equal(answer.headers['referrer-policy'], 'same-origin');
    assert.equal(answer.headers['x-frame-options'], 'DENY');
  }
  assert.equal(pageAnswer('/sign-in/assets/sign-in.js').headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(pageAnswer('/sign-in/assets/../routes.json'), null);
  assert.equal(pageAnswer('/elsewhere'), null);
});

test('every page is the one shared shell around its own sections: no head, style or script is copied per page', () => {
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.html')), ['shell.html']);
  for (const name of sectionFiles) assert.doesNotMatch(readFileSync(new URL(`sections/${name}`, dir), 'utf8'), /<(?:html|head|style|script|body)\b/, `${name} holds sections only`);
  const used = new Set(table.routes.flatMap(route => route.sections ?? []));
  assert.deepEqual([...used].sort(), sectionFiles.map(name => name.replace(/\.html$/, '')).sort(), 'every section file is drawn by a route and every route draws a file');
  for (const route of table.routes.filter(row => !row.redirect)) {
    const body = page(urlOf(route));
    assert.ok(body.includes(`<title>${route.title.replace(/&/g, '&amp;')}</title>`), `${route.path} carries its own title`);
    assert.doesNotMatch(body, /\{\{/, `${route.path} leaves no gap of the shell undrawn`);
  }
});

test('the policy allows exactly the scripts the shell runs: each inline script by its sha256 and the tool\'s own script by \'self\'', () => {
  const inline = new Set();
  for (const [, body] of shell.matchAll(/<script>([\s\S]*?)<\/script>/g)) inline.add(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
  for (const [, src] of shell.matchAll(/<script src="([^"]+)"/g)) assert.ok(src.startsWith(table.assets_path), `the shell loads its script from this tool (${src})`);
  assert.deepEqual(new Set(scriptSrc), new Set(["'self'", ...inline]));
  for (const name of sectionFiles) {
    const text = readFileSync(new URL(`sections/${name}`, dir), 'utf8');
    assert.doesNotMatch(text, / on[a-z]+=/, `${name} has no inline event handler, which the policy would block`);
    assert.doesNotMatch(text, / style=/, `${name} has no inline style: pages reuse the shell's own styles`);
  }
});

test('no page or the client names the old sign-in tool', () => {
  for (const name of [...sectionFiles.map(file => `sections/${file}`), 'shell.html', 'sign-in-client.mjs', 'routes.json', 'words.json']) {
    assert.doesNotMatch(readFileSync(new URL(name, dir), 'utf8'), /from-trillion-rust|tools\/sign-in\//, name);
  }
});

test('/sign-out answers a page whose one form signs out through Better Auth and goes to /sign-in', () => {
  assert.match(page('/sign-out'), /<form class="page-choices" method="post" action="\/sign-out">/);
  const client = readFileSync(new URL('sign-in-client.mjs', dir), 'utf8');
  assert.match(client, /if \(action === '\/sign-out'\) \{\n    const \{ error \} = await client\.signOut\(\);\n    return error \? refusal\(error\) : location\.assign\('\/sign-in'\);/);
  assert.match(readFileSync(new URL('assets/sign-in.js', dir), 'utf8'), /\/sign-out/, 'the bundle is built from the client');
});

test('every email box shows the placeholder old Trillion showed (src/pages.mjs:223, :419)', () => {
  for (const name of sectionFiles) {
    for (const [box] of readFileSync(new URL(`sections/${name}`, dir), 'utf8').matchAll(/<input[^>]*type="email"[^>]*>|<input[^>]*name="(?:email|sign_in_email)"[^>]*>/g)) {
      const placeholder = box.match(/placeholder="([^"]*)"/)?.[1];
      if (placeholder !== undefined) assert.equal(placeholder, 'you@example.com', `${name}: ${box}`);
    }
  }
});

test('/sign-in/key answers a page whose key button makes the signed-in person a key through Better Auth and shows it once', () => {
  assert.match(page('/sign-in/key'), /<button class="page-action" type="button" data-key /);
  assert.match(page('/sign-in/key'), /name="made-key" readonly hidden/);
  const client = readFileSync(new URL('sign-in-client.mjs', dir), 'utf8');
  assert.match(client, /\$\{authBase\}\/api-key\/create/);
  assert.match(readFileSync(new URL('assets/sign-in.js', dir), 'utf8'), /api-key\/create/, 'the bundle is built from the client');
});

test('the sign-in page offers an email code and a passkey, the email box offers passkeys, and no password is asked first', () => {
  const signIn = page('/sign-in');
  assert.match(signIn, /action="\/sign-in\/way\/send"/, 'the one form sends an email code');
  assert.match(signIn, /<input[^>]*name="sign_in_email"[^>]*autocomplete="username webauthn"/, 'the email box lists the person\'s passkeys (conditional mediation)');
  assert.match(signIn, /data-passkey data-purpose="sign-in"/);
  assert.doesNotMatch(signIn, /type="password"/);
  assert.match(signIn, /href="\/sign-in\/other-ways"/);
  const other = page('/sign-in/other-ways');
  assert.match(other, /way=password/, 'other ways offers a password');
  assert.doesNotMatch(other, /way=authenticator|way=backup-codes/, 'a second factor is asked after a password, never offered as a first way');
  const sentOn = pageAnswer('/sign-up');
  assert.equal(sentOn.status, 301, 'creating an account is the same page as signing in');
  assert.equal(sentOn.headers.location, '/sign-in');
  assert.match(signIn, /By continuing you agree to the <a[^>]*>Terms<\/a> and <a[^>]*>What we keep<\/a>/);
  assert.match(signIn, /Sign in to continue to \{client\}/);
});

test('no page offers a way that never works: no text code, no address that answers nothing', () => {
  for (const name of sectionFiles) assert.doesNotMatch(readFileSync(new URL(`sections/${name}`, dir), 'utf8'), /text-code|Text me a code/, name);
  assert.equal(pageAnswer('/sign-in/way?way=text-code'), null);
  const addresses = new Set(table.routes.filter(route => !route.redirect).map(route => route.path));
  const queried = route => (route.path === '/sign-in/way' ? route.query?.way : null);
  for (const name of sectionFiles) {
    for (const [, href] of readFileSync(new URL(`sections/${name}`, dir), 'utf8').matchAll(/href="(\/[^"#]*)"/g)) {
      const url = new URL(href, 'http://page');
      if (['/', '/privacy', '/terms'].includes(url.pathname)) continue;
      assert.ok(addresses.has(url.pathname), `${name} links ${href}, which a route answers`);
      assert.ok(url.pathname !== '/sign-in/way' || table.routes.some(route => queried(route) === url.searchParams.get('way')), `${name} links ${href}, which a way answers`);
    }
  }
});

test('/consent shows who asks, where, what it may do, and Allow and Deny with the line to approve only what the person started', () => {
  const consent = page('/consent');
  assert.match(consent, /data-fill-list="scopes"/);
  assert.match(consent, /data-consent="allow"[^>]*>Allow</);
  assert.match(consent, /data-consent="deny"[^>]*>Deny</);
  assert.match(consent, /Only approve what you started\./);
  assert.match(consent, /\{client\} wants to use your Trillion/);
  assert.match(consent, /On \{computer\}/);
});

test('/device takes the code a device shows and asks to allow or deny it, for a device the person holds', () => {
  const device = page('/device?user_code=ABCD-1234');
  assert.match(device, /action="\/device"/);
  assert.match(device, /name="user_code"[^>]*autocomplete="off"/);
  assert.match(device, /data-device="allow"/);
  assert.match(device, /data-device="deny"/);
  assert.match(device, /Only approve a device you are holding\./);
});

test('the steps after a sign-in: a passkey once (Not now remembered), nothing between an AI\'s connect and its consent, and no password offer', () => {
  assert.equal(pageAnswer('/sign-in/name'), null, 'nobody is asked their name: sign-in is an email, a code and one passkey offer');
  assert.match(page('/sign-in/add-passkey'), /data-page-skip="passkey"/);
  assert.match(page('/sign-in/add-passkey'), /data-passkey-link/, 'a passkey is added on another device through a link');
  assert.match(page('/sign-in/change-email'), /action="\/sign-in\/change-email"/);
  assert.doesNotMatch(page('/sign-in'), /data-purpose="register"/, 'a passkey is made on the device in hand after the email is proven, never first');
  const client = readFileSync(new URL('sign-in-client.mjs', dir), 'utf8');
  assert.match(client, /skip\(link\.dataset\.pageSkip\)/);
  assert.match(client, /needsSession/);
  assert.match(client, /const asked = carried \|\| next\.startsWith\('\/device'\)/, 'a connect or a device code goes on with no passkey step between');
  assert.doesNotMatch(client, /add-password|set-password/);
  assert.match(client, /page-code-complete/, 'the sixth digit sends the code');
});

test('the pages promise only what the server does: the minutes a code works are the settings\' minutes', () => {
  const minutes = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8')).email_code.expires_in_seconds / 60;
  for (const url of ['/sign-in/way?way=email-code&sent=1', '/sign-in/forgot-password', '/sign-in/forgot-password?sent=1']) {
    assert.match(page(url), new RegExp(`${minutes} minutes`), url);
    assert.doesNotMatch(page(url), /\{\{/, url);
  }
});

test('pages/assets/sign-in.js is the build of the client as it is now (npm run build-pages)', async () => {
  const { build } = await import('esbuild');
  const built = await build({ entryPoints: [new URL('sign-in-client.mjs', dir).pathname], bundle: true, minify: true, format: 'iife', target: 'es2020', write: false, outfile: 'sign-in.js' });
  assert.equal(built.outputFiles[0].text, readFileSync(new URL('assets/sign-in.js', dir), 'utf8'));
});

test('the consent page says who is signed in and where the AI goes back to, and the device review shows a named device and a hyphenated code', () => {
  const consent = page('/consent');
  assert.match(consent, /Signed in as \{email\}\. <a[^>]*data-switch-account[^>]*>Not you\?<\/a>/);
  assert.match(consent, /go back to \{redirect\}/);
  const client = readFileSync(new URL('sign-in-client.mjs', dir), 'utf8');
  assert.match(client, /const humane = /);
  assert.match(client, /const hyphenated = /);
});

test('the password page links "Forgot password?" where the client binds it', () => {
  assert.match(page('/sign-in/way?way=password'), /<a class="page-field-link" href="\/sign-in\/forgot-password">Forgot password\?<\/a>/);
});

test('the consent page: Read only is a switch, an unknown return address needs its host typed, a remembered AI shows Connecting with an Undo, and /connected lists with Disconnect', () => {
  const consent = page('/consent');
  assert.match(consent, /data-read-only aria-pressed="false">Read only: off</);
  assert.match(consent, /data-unknown hidden[\s\S]*name="typed_host"/);
  assert.match(consent, /data-step="remembered"[\s\S]*data-undo>Undo</);
  assert.match(consent, /From \{clientHost\}\./);
  assert.doesNotMatch(readFileSync(new URL('sections/consent.html', dir), 'utf8'), /matching code|expires|ends on/i, 'no matching-code step and no end date');
  assert.match(page('/connected'), /data-fill-list="connected"/);
  const client = readFileSync(new URL('sign-in-client.mjs', dir), 'utf8');
  assert.match(client, /allow\.disabled = true/);
  assert.match(client, /button\.dataset\.disconnect|data-disconnect/);
});
