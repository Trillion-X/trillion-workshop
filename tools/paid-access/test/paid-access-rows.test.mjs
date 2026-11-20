// The rows run as the container runs them, with no records door handed to any row (the grant row was retired to
// workflow:keep-paid-access-grants): a file is
// sealed with a key handed on a private pipe and the paid-file row is answered (nothing is kept), a buyer whose
// payment events and offers (handed in by the caller) give them the access gets a link and opens it, anyone else
// does not, a refund closes it on the next open, and the key is never in an answer. Every value here is made up.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerOf, rowOf, said, rightsOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import { encryptPrivateObjectCtr } from '../read-data/encrypt-private-object.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const seal = rowOf(rows, 'tool:seal-a-paid-file');
const link = rowOf(rows, 'tool:give-a-buyer-a-paid-file-link');
const open = rowOf(rows, 'tool:open-a-paid-file-for-a-buyer');
const see = rowOf(rows, 'tool:see-who-holds-paid-access');
const mayOpen = rowOf(rows, 'tool:check-a-buyer-may-open');

const tools = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY_HEX = 'ab'.repeat(32);
const PLAINTEXT = Buffer.from('a made-up chapter a buyer pays for', 'utf8');
const ANA = 'ana@example.com';

const offer = { id: 'offer:class', access_refs: ['access:course-a'], price_options: [{ id: 'price:class', amount_cents: 9000 }] };
const paid = { event_id: 'evt_1', event_kind: 'payment.confirmed', occurred_at: '2026-03-01T00:00:00.000Z', attributes: { provider_event_id: 'evt_1', customer_email: ANA, offer_id: 'offer:class', payment_intent_ref: 'pi_1', payment_status: 'paid' } };
const refund = { event_id: 'evt_2', event_kind: 'payment.refunded', occurred_at: '2026-03-02T00:00:00.000Z', attributes: { provider_event_id: 'evt_2', provider_object_ref: 'ch_1', payment_intent_ref: 'pi_1' } };

// Runs the seal row's argv the way the container does: the key (when given) on the row's credential descriptor, and
// --out in a scratch folder instead of /opt.
async function runSeal(input, { key } = {}) {
  const scratch = tempFolder(join(tmpdir(), 'seal-a-paid-file-'));
  // descriptor 4 carries the key, or nothing when none is handed; descriptor 3 (where a records door would be) is empty
  writeFileSync(join(scratch, 'key'), key ?? '');
  const stdio = ['pipe', 'pipe', 'pipe', 'ignore'];
  stdio[seal.invoke.credential_mounts[0].fd] = openSync(join(scratch, 'key'), 'r');
  const out = join(scratch, 'sealed.bin');
  const argv = seal.invoke.argv.map(word => (word === seal.invoke.outputs[0].path ? out
    : word.startsWith('/opt/') ? join(tools, word.slice('/opt/'.length)) : word));
  const answer = await new Promise((done, fail) => {
    const child = spawn(process.execPath, argv.slice(1), { stdio });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', fail);
    child.on('close', status => done({ status, stdout, ...JSON.parse(stdout.trim().split('\n').at(-1)) }));
    child.stdin.end(JSON.stringify(input));
  });
  return { ...answer, out };
}

async function serving(bytes) {
  const server = createServer((request, reply) => reply.writeHead(200).end(bytes));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}/file`, close: () => new Promise(done => server.close(done)) };
}

test('a sealed file opens only for a buyer whose payments give the access, a refund closes it, and the key is never answered', async () => {
  const file = await serving(PLAINTEXT);
  try {
    const sealed = await runSeal({ file: file.url, object_key: 'chapter-one.pdf', required_access_refs: ['access:course-a'], mime: 'application/pdf' }, { key: KEY_HEX });
    assert.equal(sealed.status, 0, sealed.error);
    const row = sealed.result.row;
    assert.deepEqual([row.enc_key_ref, row.enc_alg, row.required_access_refs], ['paid-files-key', 'aes-256-ctr', ['access:course-a']]);
    const ciphertext = readFileSync(sealed.out);
    assert.equal(row.cas_hash, makeHashCodeHexFromBytes(new Uint8Array(ciphertext)));
    assert.ok(encryptPrivateObjectCtr(ciphertext, Buffer.from(KEY_HEX, 'hex'), Buffer.from(row.enc_nonce, 'hex')).equals(PLAINTEXT));
    assert.ok(!sealed.stdout.includes(KEY_HEX), 'the key is not in the answer');
    assert.ok(!JSON.stringify(sealed.result).includes(KEY_HEX), 'the key is not in the row');

    const rows = { paid_file: row, offers: [offer], payment_events: [paid] };
    const granted = await answerOf(link, { object_key: 'chapter-one.pdf', email_verified: true, subject: ANA, ...rows });
    assert.equal(granted.status, 0, granted.error);
    assert.equal(granted.result.status, 'grant');
    const token = granted.result.delivery_url.split('/').pop();
    const opened = await answerOf(open, { token, email_verified: true, subject: ANA, ...rows });
    assert.deepEqual([opened.result.authorized, opened.result.cas_hash, opened.result.enc_key_ref], [true, row.cas_hash, 'paid-files-key']);

    const stranger = await answerOf(open, { token, email_verified: true, subject: 'bo@example.com', ...rows });
    assert.equal(stranger.result.authorized, false, 'a link passed to someone who has not paid does not open');
    const unpaid = await answerOf(link, { object_key: 'chapter-one.pdf', email_verified: true, subject: 'bo@example.com', ...rows });
    assert.deepEqual(said(unpaid.result), { status: 'denied', reason: 'not-entitled' });
    const anonymous = await answerOf(link, { object_key: 'chapter-one.pdf', email_verified: true, subject: '', ...rows });
    assert.deepEqual(said(anonymous.result), { status: 'denied', reason: 'anonymous' });

    const refunded = await answerOf(open, { token, email_verified: true, subject: ANA, ...rows, payment_events: [paid, refund] });
    assert.equal(refunded.result.authorized, false, 'the refund stops the very next open');
  } finally { await file.close(); }
});

test('sealing refuses with no key handed, and a file anyone could open is not a paid file', async () => {
  const file = await serving(PLAINTEXT);
  try {
    const keyless = await runSeal({ file: file.url, object_key: 'chapter-one.pdf', required_access_refs: ['access:course-a'] });
    assert.equal(keyless.status, 1);
    assert.match(keyless.error, /No paid-files key was handed to this run/);
    const ungated = await runSeal({ file: file.url, object_key: 'chapter-one.pdf', required_access_refs: [] }, { key: KEY_HEX });
    assert.equal(ungated.status, 1);
    assert.match(ungated.error, /at least one access ref/);
  } finally { await file.close(); }
});

test('see-who-holds answers from the rows in its request and keeps nothing', async () => {
  const answer = await answerOf(see, { email_verified: true, subject: ANA, offers: [offer], payment_events: [paid] });
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual(answer.result.held_access_refs, ['access:course-a']);
  const after = await answerOf(see, { email_verified: true, subject: ANA, offers: [offer], payment_events: [paid, refund] });
  assert.deepEqual(after.result.held_access_refs, []);
  assert.deepEqual(after.result.episodes.map(episode => episode.state), ['ended']);
  assert.equal(see.invoke.records, undefined, 'no records door is handed to the run');
  assert.deepEqual(after.kept ?? [], [], 'nothing is written');
});

test('the scope check runs as its row runs it', async () => {
  const scope = { schema: 'addressed-expiring-value-scope/v1', value_ref: 'page:class', instance_ref: 'page:class:1', required_access_refs: ['access:course-a'] };
  const rows = { offers: [offer], payment_events: [paid] };
  const yes = (await answerOf(mayOpen, { email_verified: true, subject: ANA, scope, ...rows })).result;
  assert.equal(yes.authorized, true);
  assert.match(yes.membership_revision, /^[0-9a-f:]+$/);
  const no = (await answerOf(mayOpen, { email_verified: true, subject: 'bo@example.com', scope, ...rows })).result;
  assert.equal(no.authorized, false);
  assert.notEqual(no.membership_revision, yes.membership_revision);
  assert.equal(mayOpen.invoke.records, undefined, 'no records door is handed to the run');
});

test('the sample runs answer as the rows say, with no records at all', async () => {
  for (const row of rows.records.map(item => item.payload).filter(item => item.verify?.[0]?.output_selector)) {
    const [sample] = row.verify;
    const answer = await answerOf(row, sample.input);
    assert.equal(answer.status, 0, answer.error);
    assert.ok(String(answer.result[sample.output_selector.slice(2)]).includes(sample.contains), `${row.id}: ${JSON.stringify(answer.result)}`);
  }
});

test('no row reads or writes stored records, and no row holds a key or a person', () => {
  const all = rows.records.map(item => item.payload);
  assert.deepEqual(all.filter(row => rightsOf(row).length), []);
  for (const row of all) {
    for (const mount of row.invoke.credential_mounts ?? []) assert.equal(mount.secret_name, 'paid-files-key');
    assert.doesNotMatch(JSON.stringify(row), /\b(?:sk|rk|whsec)_[A-Za-z0-9]/);
    assert.doesNotMatch(row.maker, /trillion|bitfield/i);
  }
  assert.deepEqual(all.filter(row => row.invoke.credential_mounts).map(row => row.id), ['tool:seal-a-paid-file']);
  assert.deepEqual(all.filter(row => row.invoke.internet).map(row => row.id), ['tool:seal-a-paid-file']);
});

// One test per tool: its answer holds the whole result, from a run with no records door.
const noDoor = row => assert.equal(row.invoke.records, undefined, `${row.id} is handed no records door`);

test('see-who-holds-paid-access: the answer holds who holds what, from the rows it was given', async () => {
  noDoor(see);
  const answer = await answerOf(see, { subject: ANA, email_verified: true, offers: [offer], payment_events: [paid] });
  assert.deepEqual([answer.result.subject, answer.result.held_access_refs, answer.result.active_offers], [ANA, ['access:course-a'], ['offer:class']]);
});

test('check-a-buyer-may-open: the answer holds the verdict and the membership revision', async () => {
  noDoor(mayOpen);
  const scope = { schema: 'addressed-expiring-value-scope/v1', value_ref: 'page:class', instance_ref: 'page:class:1', required_access_refs: ['access:course-a'] };
  const answer = await answerOf(mayOpen, { subject: ANA, email_verified: true, scope, offers: [offer], payment_events: [paid] });
  assert.equal(answer.result.authorized, true);
  assert.equal(typeof answer.result.membership_revision, 'string');
});

test('seal-a-paid-file: the answer holds the paid-file row and nothing is kept by the run', async () => {
  noDoor(seal);
  const file = await serving(PLAINTEXT);
  try {
    const sealed = await runSeal({ file: file.url, object_key: 'chapter-one.pdf', required_access_refs: ['access:course-a'] }, { key: KEY_HEX });
    assert.equal(sealed.status, 0, sealed.error);
    assert.deepEqual([sealed.result.row.object_key, sealed.result.row.required_access_refs, sealed.result.sealed_bytes > 0], ['chapter-one.pdf', ['access:course-a'], true]);
  } finally { await file.close(); }
});

test('give-a-buyer-a-paid-file-link and open-a-paid-file-for-a-buyer: the answers hold the link and the opening, from the paid_file row they were given', async () => {
  noDoor(link);
  noDoor(open);
  const paid_file = { object_key: 'chapter-one.pdf', object_store_ref: 'object-store:paid-files', cas_hash: `1f:${'c'.repeat(64)}`, enc_alg: 'aes-256-ctr', enc_key_ref: 'paid-files-key', enc_nonce: 'ab'.repeat(16), required_access_refs: ['access:course-a'] };
  const rows = { paid_file, offers: [offer], payment_events: [paid], subject: ANA, email_verified: true };
  const granted = await answerOf(link, { object_key: 'chapter-one.pdf', ...rows });
  assert.equal(granted.result.status, 'grant');
  assert.match(granted.result.delivery_url, /^\/[^ ]+\/[0-9a-f]+$/i);
  const opened = await answerOf(open, { token: granted.result.delivery_url.split('/').pop(), ...rows });
  assert.deepEqual([opened.result.authorized, opened.result.cas_hash, opened.result.enc_key_ref], [true, paid_file.cas_hash, 'paid-files-key']);
  assert.deepEqual((await answerOf(link, { object_key: 'chapter-one.pdf', ...rows, paid_file: undefined })).result, { status: 'unavailable', reason: 'governing-item-missing' });
});
