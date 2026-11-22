// tools/take-payments/test/register-a-webhook-endpoint.test.mjs
//
// One webhook endpoint is registered and its signing secret is kept on the keep command's stdin only: never in argv, the
// program's output or an error. An endpoint already registered for the address is refused before anything is made, and a keep
// that fails deletes the endpoint it just made. The program runs as a process with a stand-in Stripe and a stand-in keep command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsOf, keepWith, registerWebhookEndpoint } from '../do-work/register-a-webhook-endpoint.mjs';

const SECRET = 'whsec_scratch_secret_for_this_test_only';
const URL_ = 'https://app.example.test/api/auth/stripe/webhook';
const ASKED = { url: URL_, events: ['checkout.session.completed', 'customer.subscription.deleted'], keep_as: 'example-webhook-secret', hosts: ['app.example.test'] };

function stripe(listed = []) {
  const sent = [];
  const send = async request => {
    sent.push(request);
    if (request.method === 'GET') return { data: listed };
    if (request.method === 'POST') return { id: 'we_example_1', secret: SECRET, url: URL_ };
    return { id: 'we_example_1', deleted: true };
  };
  return { sent, send };
}

test('the endpoint is made with its address and events, and its secret goes only to the keep', async () => {
  const { sent, send } = stripe();
  const kept = [];
  const answer = await registerWebhookEndpoint(ASKED, { send, keep: async input => { kept.push(input); } });
  assert.deepEqual(answer, { endpoint_id: 'we_example_1', kept_as: 'example-webhook-secret' });
  assert.deepEqual(kept, [{ name: 'example-webhook-secret', value: SECRET, hosts: ['app.example.test'] }]);
  const form = new URLSearchParams(sent[1].body);
  assert.equal(form.get('url'), URL_);
  assert.deepEqual(form.getAll('enabled_events[]'), ASKED.events);
  assert.ok(!JSON.stringify(answer).includes(SECRET));
});

test('an endpoint already registered for the address is refused before anything is made', async () => {
  const { sent, send } = stripe([{ id: 'we_old', url: URL_ }]);
  await assert.rejects(registerWebhookEndpoint(ASKED, { send, keep: async () => {} }), /already registered/);
  assert.deepEqual(sent.map(request => request.method), ['GET']);
});

test('a keep that fails deletes the endpoint it made, and the error names no secret', async () => {
  const { sent, send } = stripe();
  const error = await registerWebhookEndpoint(ASKED, { send, keep: async () => { throw new Error('the keep command exited 1'); } }).catch(caught => caught);
  assert.match(error.message, /exited 1; endpoint we_example_1 was deleted again/);
  assert.ok(!error.message.includes(SECRET));
  assert.deepEqual(sent.map(request => `${request.method} ${request.url}`).slice(1), ['POST https://api.stripe.com/v1/webhook_endpoints', 'DELETE https://api.stripe.com/v1/webhook_endpoints/we_example_1']);
});

test('the arguments are refused when one is missing or unknown', () => {
  assert.throws(() => argumentsOf(['--url', URL_, '--event', 'x', '--keep-as', 'n', '--hosts', 'h']), /after --/);
  assert.throws(() => argumentsOf(['--url', 'http://plain', '--event', 'x', '--keep-as', 'n', '--hosts', 'h', '--', 'cat']), /https/);
  assert.throws(() => argumentsOf(['--url', URL_, '--keep-as', 'n', '--hosts', 'h', '--', 'cat']), /--event/);
  assert.throws(() => argumentsOf(['--url', URL_, '--event', 'x', '--other', 'y', '--', 'cat']), /unknown argument --other/);
  assert.deepEqual(argumentsOf(['--url', URL_, '--event', 'a', '--event', 'b', '--keep-as', 'n', '--hosts', 'h1,h2', '--', 'keep', '-']),
    { url: URL_, events: ['a', 'b'], keep_as: 'n', hosts: ['h1', 'h2'], keep: ['keep', '-'] });
});

test('the keep command reads the secret on its stdin; a failing one is an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'register-webhook-'));
  const into = join(dir, 'kept.json');
  await keepWith([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(into)}, require('fs').readFileSync(0))`], { name: 'n', value: SECRET, hosts: ['h'] });
  assert.deepEqual(JSON.parse(readFileSync(into, 'utf8')), { name: 'n', value: SECRET, hosts: ['h'] });
  await assert.rejects(keepWith([process.execPath, '-e', 'process.exit(3)'], {}), /exited 3/);
});

test('run as a program, the key comes on stdin and the output is only the endpoint id and where the secret is kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'register-webhook-'));
  const into = join(dir, 'kept.json');
  const keeper = join(dir, 'keep.mjs');
  writeFileSync(keeper, `import { readFileSync, writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(into)}, JSON.stringify({ input: JSON.parse(readFileSync(0, 'utf8')), argv: process.argv.slice(2) }));`);
  // Stripe's address is replaced for this process only, by a loader that sends fetch to the stand-in.
  const seen = [];
  const stand = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    seen.push({ method: request.method, authorization: request.headers.authorization, body });
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(request.method === 'GET' ? { data: [] } : { id: 'we_example_2', secret: SECRET }));
  }).listen(0, '127.0.0.1');
  await new Promise(done => stand.once('listening', done));
  const redirect = join(dir, 'redirect.mjs');
  writeFileSync(redirect, `const real = globalThis.fetch; globalThis.fetch = (url, options) => real(String(url).replace('https://api.stripe.com', 'http://127.0.0.1:${stand.address().port}'), options);`);
  const program = fileURLToPath(new URL('../do-work/register-a-webhook-endpoint.mjs', import.meta.url));
  // spawn, not spawnSync: the stand-in answers on this process's own event loop.
  const run = await new Promise(done => {
    const child = spawn(process.execPath, ['--import', redirect, program, '--url', URL_, '--event', 'checkout.session.completed', '--keep-as', 'example-webhook-secret', '--hosts', 'app.example.test', '--', process.execPath, keeper, '-']);
    const out = { stdout: '', stderr: '' };
    child.stdout.on('data', chunk => { out.stdout += chunk; });
    child.stderr.on('data', chunk => { out.stderr += chunk; });
    child.on('exit', status => done({ ...out, status }));
    child.stdin.end('sk_test_scratch_key\n');
  });
  stand.close();
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { endpoint_id: 'we_example_2', kept_as: 'example-webhook-secret' });
  assert.ok(!run.stdout.includes(SECRET) && !run.stderr.includes(SECRET));
  const kept = JSON.parse(readFileSync(into, 'utf8'));
  assert.deepEqual(kept, { input: { name: 'example-webhook-secret', value: SECRET, hosts: ['app.example.test'] }, argv: ['-'] });
  assert.deepEqual(seen.map(request => request.authorization), ['Bearer sk_test_scratch_key', 'Bearer sk_test_scratch_key']);
});
