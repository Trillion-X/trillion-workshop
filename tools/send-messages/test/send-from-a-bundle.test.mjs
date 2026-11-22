// tools/send-messages/test/send-from-a-bundle.test.mjs
//
// A site bundles send-a-message (and the email look) into one file, which has no read-data folder beside it.
// Run from source, every test passes either way; the school's bundled site refused every sign-up with 502 (10:42 PM CST
// Nov 21 2026) because the provider rows were read from a path at run time. Here the modules are bundled into a folder of
// their own and an email is sent through the bundle, so a run-time read of a data file fails this test. No network.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, it } from 'node:test';
import { build } from 'esbuild';

const folder = mkdtempSync(join(tmpdir(), 'send-from-a-bundle-'));
after(() => rmSync(folder, { recursive: true, force: true }));
const here = new URL('..', import.meta.url).pathname;
const entry = join(folder, 'site.mjs');
writeFileSync(entry, [
  `export { sendMessage, inProcess, providers } from ${JSON.stringify(join(here, 'do-work/send-a-message.mjs'))};`,
  `export { EMAIL_LOOK } from ${JSON.stringify(join(here, 'read-data/draw-an-email.mjs'))};`,
].join('\n'));
const bundled = async () => {
  const outfile = join(folder, 'dist', 'serve.mjs');
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
};

it('an email is sent through the bundled module, its provider row read from inside the bundle', async () => {
  const site = await bundled();
  assert.ok(site.providers().some(row => row.id === 'resend'));
  assert.equal(typeof site.EMAIL_LOOK, 'object');
  const handed = [];
  const fake = { send: async (input, env) => { handed.push({ input, key: env.RESEND_API_KEY }); return input.recipients.map(recipient => ({ recipient, messageId: 'msg-1' })); } };
  const answer = await site.sendMessage({ recipients: ['reader@example.com'], from: 'Coach <coach@example.com>', subject: 'Lesson one', html: '<p>Hi</p>', text: 'Hi' },
    { providerId: 'resend', credentials: { RESEND_API_KEY: 'test-key' }, run: site.inProcess({ 'send-via-resend.cjs': fake }) });
  assert.deepEqual(answer.sent, [{ recipient: 'reader@example.com', messageId: 'msg-1' }]);
  assert.equal(handed[0].key, 'test-key');
});
