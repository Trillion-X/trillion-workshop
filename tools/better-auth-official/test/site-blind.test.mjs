// tools/better-auth-official/test/site-blind.test.mjs
//
// The tool is blind to whose sign-in it is: no source file names a product, and the site block (settings.site) is the one place a
// computer says so. The pages and every email wear the block they are given; with another block, nothing of the stand-in is left.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url).pathname;
// The platform's own catalogue files (the tool row, the kit) name the platform that lists the tool; they are not the tool's source.
const catalogue = new Set(['what-this-tool-does-and-how-to-run-it.json', 'kits', 'node_modules', 'package-lock.json', 'sign-in.js', 'site-blind.test.mjs']);
const product = new RegExp(['tril', 'lion'].join(''), 'i');
const sources = (dir = root) => readdirSync(dir).filter(name => !catalogue.has(name)).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? sources(path) : [path];
});

test('no source file of the tool names a product', () => {
  const named = sources().filter(path => product.test(readFileSync(path, 'utf8')) || product.test(relative(root, path)));
  assert.deepEqual(named.map(path => relative(root, path)), []);
});

test('pages and emails wear the site block they are given', () => {
  const settings = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
  settings.site = { ...settings.site, name: 'Acme Cloud', cli: 'acme', storage_prefix: 'acme', look_css: ':root{--bg-primary:#123456}',
    theme: { data_theme: 'acme-theme', scheme: 'dark', theme_color: '#123456' }, mark_svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', wordmark_png: Buffer.from('png').toString('base64'),
    share: { title: 'Acme Cloud sign-in', description: 'Sign in to Acme.' }, links: [{ rel: 'manifest', href: '/acme.webmanifest' }] };
  const dir = tempFolder(join(tmpdir(), 'site-blind-'));
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify(settings));
  const script = `
    import { pageAnswer } from ${JSON.stringify(root + 'pages.mjs')};
    import { messageOf } from ${JSON.stringify(root + 'send-email.mjs')};
    import { readSettings } from ${JSON.stringify(root + 'settings.mjs')};
    const { settings } = readSettings();
    const page = String(pageAnswer('/sign-in').body);
    const mark = pageAnswer('/sign-in/assets/mark.svg');
    const mail = messageOf({ kind: 'otp-sign-in', to: 'a@example.com', otp: '123456' }, { minutes: '10', site: settings.site, site_url: 'https://x.example.com/', assets_url: 'https://x.example.com/a/' });
    process.stdout.write(JSON.stringify({ page, mark: mark?.status, mail, cookie: settings.session_cookie_name, rp: settings.passkey.rp_name, issuer: settings.two_factor_issuer }));`;
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, BETTER_AUTH_SETTINGS: file }, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  const out = JSON.parse(ran.stdout);
  assert.match(out.page, /data-theme="acme-theme" data-look-scheme="dark" data-site-name="Acme Cloud" data-site-prefix="acme"/);
  assert.match(out.page, /<style>:root\{--bg-primary:#123456\}<\/style>/);
  assert.match(out.page, /alt="Acme Cloud"/);
  assert.match(out.page, /href="\/acme\.webmanifest"/);
  assert.doesNotMatch(out.page, /Example|\{\{/);
  assert.equal(out.mark, 200);
  assert.match(out.mail.subject, /^Your Acme Cloud sign-in code: 123456$/);
  assert.match(out.mail.html, /Acme Cloud/);
  assert.equal(out.cookie, '__Host-acme_session');
  assert.equal(out.rp, 'Acme Cloud');
  assert.equal(out.issuer, 'Acme Cloud');
});
