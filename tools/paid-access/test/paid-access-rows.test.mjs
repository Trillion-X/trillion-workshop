// The rows run as the container runs them, against the fake records door with exactly each row's rights: a file is
// sealed with a key handed on a private pipe, its paid-file record is kept, a buyer whose payment events and offers
// give them the access gets a link and opens it, anyone else does not, a refund closes it on the next open, and the
// key is never in a record or an answer. Every value here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import { startFakeDoor } from 'trillion-workshop/tools/records-door/test/fake-door.mjs';
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

const record = (type, id, value) => ({ type, id, value });
const offer = record('commercial-offer', 'offer:class', { id: 'offer:class', access_refs: ['access:course-a'], price_options: [{ id: 'price:class', amount_cents: 9000 }] });
const paid = record('payment-event', 'payment-event:evt_1', { event_id: 'evt_1', event_kind: 'payment.confirmed', occurred_at: '2026-03-01T00:00:00.000Z', attributes: { provider_event_id: 'evt_1', customer_email: ANA, offer_id: 'offer:class', payment_intent_ref: 'pi_1', payment_status: 'paid' } });
const refund = record('payment-event', 'payment-event:evt_2', { event_id: 'evt_2', event_kind: 'payment.refunded', occurred_at: '2026-03-02T00:00:00.000Z', attributes: { provider_event_id: 'evt_2', provider_object_ref: 'ch_1', payment_intent_ref: 'pi_1' } });

// Runs the seal row's argv the way the container does: the door on its descriptor, the key (when given) on the
// row's credential descriptor, and --out in a scratch folder instead of /opt.
async function runSeal(input, { key } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'seal-a-paid-file-'));
  const fake = await startFakeDoor({ rights: seal.invoke.records.rights });
  const stdio = ['pipe', 'pipe', 'pipe'];
  stdio[seal.invoke.records.fd] = openSync(fake.descriptor, 'r');
  if (key !== undefined) {
    writeFileSync(join(scratch, 'key'), key);
    stdio[seal.invoke.credential_mounts[0].fd] = openSync(join(scratch, 'key'), 'r');
  }
  const out = join(scratch, 'sealed.bin');
  const argv = seal.invoke.argv.map(word => (word === seal.invoke.outputs[0].path ? out
    : word.startsWith('/opt/') ? join(tools, word.slice('/opt/'.length)) : word));
  try {
    const answer = await new Promise((done, fail) => {
      const child = spawn(process.execPath, argv.slice(1), { stdio });
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.on('error', fail);
      child.on('close', status => done({ status, stdout, ...JSON.parse(stdout.trim().split('\n').at(-1)) }));
      child.stdin.end(JSON.stringify(input));
    });
    return { ...answer, out, kept: [...fake.kept.values()] };
  } finally { await fake.close(); }
}

async function serving(bytes) {
  const server = createServer((request, reply) => reply.writeHead(200).end(bytes));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}/file`, close: () => new Promise(done => server.close(done)) };
}

test('a sealed file opens only for a buyer whose payments give the access, a refund closes it, and the key is never written or answered', async () => {
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
    assert.ok(!JSON.stringify(sealed.kept).includes(KEY_HEX), 'the key is not in a record');
    assert.deepEqual(sealed.kept.map(item => [item.id, item.type]), [['chapter-one.pdf', 'paid-file']]);

    const records = [...sealed.kept, offer, paid];
    const granted = await runRow(link, { object_key: 'chapter-one.pdf', subject: ANA }, { records });
    assert.equal(granted.status, 0, granted.error);
    assert.equal(granted.result.status, 'grant');
    const token = granted.result.delivery_url.split('/').pop();
    const opened = await runRow(open, { token, subject: ANA }, { records });
    assert.deepEqual([opened.result.authorized, opened.result.cas_hash, opened.result.enc_key_ref], [true, row.cas_hash, 'paid-files-key']);

    const stranger = await runRow(open, { token, subject: 'bo@example.com' }, { records });
    assert.equal(stranger.result.authorized, false, 'a link passed to someone who has not paid does not open');
    const unpaid = await runRow(link, { object_key: 'chapter-one.pdf', subject: 'bo@example.com' }, { records });
    assert.deepEqual(unpaid.result, { status: 'denied', reason: 'not-entitled' });
    const anonymous = await runRow(link, { object_key: 'chapter-one.pdf', subject: '' }, { records });
    assert.deepEqual(anonymous.result, { status: 'denied', reason: 'anonymous' });

    const refunded = await runRow(open, { token, subject: ANA }, { records: [...records, refund] });
    assert.equal(refunded.result.authorized, false, 'the refund stops the very next open');
  } finally { await file.close(); }
});

test('sealing refuses with no key handed, and a file anyone could open is not a paid file', async () => {
  const file = await serving(PLAINTEXT);
  try {
    const keyless = await runSeal({ file: file.url, object_key: 'chapter-one.pdf', required_access_refs: ['access:course-a'] });
    assert.equal(keyless.status, 1);
    assert.match(keyless.error, /No paid-files key was handed to this run/);
    assert.deepEqual(keyless.kept, []);
    const ungated = await runSeal({ file: file.url, object_key: 'chapter-one.pdf', required_access_refs: [] }, { key: KEY_HEX });
    assert.equal(ungated.status, 1);
    assert.match(ungated.error, /at least one access ref/);
  } finally { await file.close(); }
});

test('see-who-holds answers from the person\'s records through the row\'s own rights', async () => {
  const answer = await runRow(see, { subject: ANA }, { records: [offer, paid] });
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual(answer.result.held_access_refs, ['access:course-a']);
  const after = await runRow(see, { subject: ANA }, { records: [offer, paid, refund] });
  assert.deepEqual(after.result.held_access_refs, []);
  assert.deepEqual(after.result.episodes.map(episode => episode.state), ['ended']);
  assert.deepEqual(after.kept.map(item => item.id).sort(), ['offer:class', 'payment-event:evt_1', 'payment-event:evt_2'], 'nothing is written');
});

test('the scope check runs as its row runs it', async () => {
  const scope = { schema: 'addressed-expiring-value-scope/v1', value_ref: 'page:class', instance_ref: 'page:class:1', required_access_refs: ['access:course-a'] };
  assert.deepEqual((await runRow(mayOpen, { subject: ANA, scope }, { records: [offer, paid] })).result, { authorized: true });
  assert.deepEqual((await runRow(mayOpen, { subject: 'bo@example.com', scope }, { records: [offer, paid] })).result, { authorized: false });
});

test('the sample runs answer as the rows say, with no records at all', async () => {
  for (const row of rows.records.map(item => item.payload).filter(item => item.verify)) {
    const [sample] = row.verify;
    const answer = await runRow(row, sample.input);
    assert.equal(answer.status, 0, answer.error);
    assert.ok(String(answer.result[sample.output_selector.slice(2)]).includes(sample.contains), `${row.id}: ${JSON.stringify(answer.result)}`);
  }
});

test('the rows read payments and write nothing but the sealed file\'s record, and no row holds a key or a person', () => {
  const all = rows.records.map(item => item.payload);
  for (const row of all) {
    for (const right of row.invoke.records?.rights ?? []) {
      const writes = right.operations.some(operation => operation === 'records:write');
      assert.ok(!writes || (row.id === 'tool:seal-a-paid-file' && right.kind === 'paid-file'), `${row.id} writes only the sealed file's record`);
    }
    for (const mount of row.invoke.credential_mounts ?? []) assert.equal(mount.secret_name, 'paid-files-key');
    assert.doesNotMatch(JSON.stringify(row), /\b(?:sk|rk|whsec)_[A-Za-z0-9]/);
    assert.doesNotMatch(row.maker, /trillion|bitfield/i);
  }
  assert.deepEqual(all.filter(row => row.invoke.credential_mounts).map(row => row.id), ['tool:seal-a-paid-file']);
  assert.deepEqual(all.filter(row => row.invoke.internet).map(row => row.id), ['tool:seal-a-paid-file']);
});
