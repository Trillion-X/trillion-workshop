// tools/send-messages/test/read-the-worn-email-look.test.mjs
//
// The look every email is drawn in is the person's worn screen look, read through their records door
// (do-work/read-the-worn-email-look.mjs) with exactly the rights the email rows hold. The older owner read the
// operator's published brand from a Worker (src/mail-sender.mjs currentPalette over readBrandPresentationWithin); its
// tests "the sent email uses the worn dark look ..." and "an email whose brand cannot be read is not sent ..." are run
// here with the look coming from the person's own records. The last test runs an email row's own command with a
// sign-in code request exactly as the engine sends it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { openRecordsDoor } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import { startFakeDoor } from 'trillion-workshop/tools/records-door/test/fake-door.mjs';
import { rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import { SETTINGS, SETTINGS_ID, SHIPPED, mailSender } from '../do-work/mail-sender.mjs';
import { wornLookReader } from '../do-work/read-the-worn-email-look.mjs';
import { EMAIL_LOOK, emailPalette } from '../read-data/draw-an-email.mjs';
import { resolveScreenLookPalette } from '../../screen-looks/read-data/resolve-screen-look-palette.js';

const folder = fileURLToPath(new URL('..', import.meta.url));
const stub = fileURLToPath(new URL('./stub-fetch.mjs', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'worn-email-look-test-'));
const doors = [];
after(() => Promise.all(doors.map(fake => fake.close())).then(() => rmSync(work, { recursive: true, force: true })));

const rights = rowOf(rows, 'tool:send-an-email-with-resend').invoke.records.rights;
const settingsWith = () => ({ ...structuredClone(SHIPPED), from: { email: 'hello@example.com', name: 'Example' }, owner: 'owner@example.com' });
// A dark look the account can wear, from the shipped looks (its ground is black).
const darkId = EMAIL_LOOK.looks.themes.map(row => row.payload).find(look => resolveScreenLookPalette(look)['--bg-primary'] === '#000000').id;

// A sender over a stand-in door holding `workspaceRecords` (the person's screen-look records), reading its look through
// that door; `binding.sends` is what the provider was given.
async function senderOver(workspaceRecords = {}, change = door => door) {
  const fake = await startFakeDoor({ rights, workspaceRecords });
  doors.push(fake);
  const door = change(openRecordsDoor({ descriptor: fake.descriptor }));
  const sends = [];
  const binding = { send: async composed => { sends.push(composed); return { messageId: `m${sends.length}` }; } };
  return { sends, sender: mailSender({ row: settingsWith(), door, binding, provider: 'resend', readLook: wornLookReader(door) }) };
}

describe('the email wears the person\'s worn look, read through their records door', () => {
  it('the sent email uses the worn dark look, shared button depth and the look\'s own faces', async () => {
    const { sends, sender } = await senderOver({ 'screen-look': [{ name: darkId }] });
    const result = await sender.sendWrittenEmail({ to: 'dark-proof@example.org', subject: 'Worn look', markdown: 'A message.', action: { label: 'Open', href: 'https://example.com/' } });
    assert.equal(result.sent, true);
    assert.match(sends[0].html, /background:#000000/);
    assert.match(sends[0].html, /name="color-scheme" content="dark"/);
    assert.match(sends[0].html, /background-image:linear-gradient/);
  });

  it('before the person chooses a look the email is drawn in the shipped look, and a look they made is worn as made', async () => {
    const early = await senderOver();
    assert.equal((await early.sender.sendWrittenEmail({ to: 'brand-proof@example.org', subject: 'Brand', markdown: 'A message.' })).sent, true, 'no email waits for a first choice');
    assert.match(early.sends[0].html, new RegExp(`background:${emailPalette(EMAIL_LOOK.shipped_palette).paper}`), 'drawn in the shipped look');
    const own = { kind: 'screen-look-editable-theme', id: 'harbor-proof', name: 'Harbor proof',
      tokens: [{ key: 'bg-primary', kind: 'color', value: '#123456', css_variable: '--bg-primary' }] };
    const mine = await senderOver({ 'screen-look': [{ name: 'harbor-proof' }], 'screen-look-own-themes': [{ payload: own }] });
    await mine.sender.sendWrittenEmail({ to: 'own-proof@example.org', subject: 'Own look', markdown: 'A message.' });
    assert.match(mine.sends[0].html, /background:#123456/);
  });

  it('an email whose look cannot be read is not sent in other colours', async () => {
    const { sends, sender } = await senderOver({}, door => ({ ...door, readWorkspace: async () => { throw new Error('the look owner is busy'); } }));
    const errors = console.error;
    console.error = () => {};
    let refused;
    try { refused = await sender.sendWrittenEmail({ to: 'brand-proof@example.org', subject: 'Brand', markdown: 'A message.' }); }
    finally { console.error = errors; }
    assert.equal(refused.sent, false);
    assert.match(refused.error, /could not be read, so it was not sent/);
    assert.equal(sends.length, 0, 'nothing went out in colours other than the look\'s');
  });

  it('a sign-in code request with no html, as the engine sends it, reaches the provider with drawn html and text in the worn look', async () => {
    const log = join(work, 'sign-in-requests.jsonl');
    writeFileSync(log, '');
    const keyFile = join(work, 'key');
    writeFileSync(keyFile, 'test-key-sign-in');
    const door = await startFakeDoor({ rights, records: [{ id: SETTINGS_ID, type: SETTINGS, value: settingsWith() }], workspaceRecords: { 'screen-look': [{ name: darkId }] } });
    doors.push(door);
    const child = spawn(process.execPath, [join(folder, 'do-work', 'mail-sender.mjs'), 'resend'], {
      stdio: ['pipe', 'pipe', 'pipe', openSync(door.descriptor, 'r'), openSync(keyFile, 'r')],
      env: { ...process.env, NODE_OPTIONS: `--import=${stub}`, STUB_LOG: log, STUB_REPLY: '{"status":200,"body":"{\\"id\\":\\"m-sign-in\\"}"}' },
    });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stdin.end(JSON.stringify({ to: 'reader@example.com', from: 'Example Sign In <signin@example.com>', subject: 'Your code: 246810', text: 'Your sign-in code is 246810.', idempotencyKey: 'sign-in:reader@example.com:1' }));
    await new Promise(done => child.on('close', done));
    const answer = JSON.parse(out.trim().split('\n').at(-1)).result;
    assert.equal(answer.sent[0].messageId, 'm-sign-in');
    const [request] = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const body = JSON.parse(request.body);
    assert.match(body.html, /^<!doctype html>/);
    assert.match(body.html, /Your sign-in code is 246810\./);
    assert.match(body.html, /background:#000000/, 'drawn in the worn look, read through the door');
    assert.match(body.text, /^Your sign-in code is 246810\./);
    assert.equal(request.headers['idempotency-key'], 'sign-in:reader@example.com:1');
    assert.equal(body.from, 'Example <hello@example.com>', 'the sender is the mail row\'s, never the request\'s');
  });
});
