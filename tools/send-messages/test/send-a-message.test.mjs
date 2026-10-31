// tools/send-messages/test/send-a-message.test.mjs
//
// The sending seam against the provider adapters, with no network: each adapter runs as its own process with a
// stand-in fetch preloaded (test/stub-fetch.mjs) that records the request it would have sent. Carried cases:
//   - from the email sender's send tests: bounded thread headers are forwarded and the provider's receipt id comes
//     back; header injection is refused before anything is sent; a non-2xx reply is an error, not a hang; the
//     provider's own status and reason are in the error (never a generic "rejected").
//   - from the Messages sender's tests: the body rides as its own argument, a permission refusal fails closed with
//     what to allow, a non-zero exit or a missing success marker is a rejection, an unknown channel is refused with
//     no first-match fallback, the command is built from DATA, the denial match ignores case.
// New at the seam: the provider rows agree with the tool rows, the keys come on private descriptors and appear
// nowhere else, a list is answered per recipient, and the Amazon SES signature matches the published AWS test vector.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { MessageRejectedError } from '../read-data/check-message-headers.ts';
import { buildSendInvocation, isTccDenial } from '../read-data/render-a-send.ts';
import { MessageBlockedError, heldKeys, providerOf, providers, runAdapter, sendMessage } from '../do-work/send-a-message.mjs';

const folder = fileURLToPath(new URL('..', import.meta.url));
const stub = fileURLToPath(new URL('./stub-fetch.mjs', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'send-messages-test-'));
after(() => rmSync(work, { recursive: true, force: true }));

let counter = 0;
// Runs the real adapter script with the stand-in fetch; returns what it would have sent.
function stubbed(reply = { status: 200, body: '{}' }) {
  const log = join(work, `requests-${counter += 1}.jsonl`);
  writeFileSync(log, '');
  const run = (provider, input, env) => runAdapter(provider, input, {
    ...env, NODE_OPTIONS: `--import=${stub}`, STUB_LOG: log, STUB_REPLY: JSON.stringify(reply),
  });
  const requests = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { run, requests };
}

const resendKey = { RESEND_API_KEY: 'test-key-resend' };
const sender = 'An Installer <mail@installer.test>';
const base = { recipients: ['someone@recipient.test'], from: sender, subject: 'Hello', html: '<p>Hi</p>', text: 'Hi' };

describe('email through Resend (carried from the email sender)', () => {
  it('sends one message per recipient and gives back the provider receipt id', async () => {
    const { run, requests } = stubbed({ status: 200, body: JSON.stringify({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }) });
    const answer = await sendMessage({ ...base, recipients: ['a@recipient.test', 'b@recipient.test'] }, { providerId: 'resend', credentials: resendKey, run });
    assert.deepEqual(answer.sent.map(item => item.recipient), ['a@recipient.test', 'b@recipient.test']);
    assert.equal(answer.sent[0].messageId, '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794');
    const [first, second] = requests();
    assert.equal(first.url, 'https://api.resend.com/emails');
    assert.equal(first.headers.authorization, 'Bearer test-key-resend');
    assert.deepEqual(JSON.parse(first.body).to, ['a@recipient.test']);
    assert.deepEqual(JSON.parse(second.body).to, ['b@recipient.test']);
    assert.equal(JSON.parse(first.body).from, sender);
    assert.match(answer.said, /Sent to 2 of 2 through Resend/);
  });

  it('renders a template with the installer\'s own sender', async () => {
    const { run, requests } = stubbed({ status: 200, body: '{"id":"m1"}' });
    await sendMessage({ to: 'someone@recipient.test', template: 'account-onboarding', variables: { loginUrl: 'https://app.installer.test/' }, from: sender }, { providerId: 'resend', credentials: resendKey, run });
    const body = JSON.parse(requests()[0].body);
    assert.equal(body.subject, 'Welcome — your access is now active');
    assert.equal(body.from, sender);
    assert.ok(body.html.includes('href="https://app.installer.test/"'));
  });

  it('refuses a template with no sender instead of sending as someone else', async () => {
    const { run, requests } = stubbed();
    await assert.rejects(sendMessage({ to: 'someone@recipient.test', template: 'account-onboarding', variables: { loginUrl: 'https://x.test/' } }, { providerId: 'resend', credentials: resendKey, run }), /from is required/);
    assert.equal(requests().length, 0);
  });

  it('forwards bounded thread headers and the idempotency key', async () => {
    const { run, requests } = stubbed({ status: 200, body: '{"id":"m2"}' });
    await sendMessage({
      ...base, idempotencyKey: 'course-1:0',
      headers: { 'In-Reply-To': '<root@example.com>', References: '<first@example.com> <root@example.com>' },
    }, { providerId: 'resend', credentials: resendKey, run });
    const [request] = requests();
    assert.deepEqual(JSON.parse(request.body).headers, { 'In-Reply-To': '<root@example.com>', References: '<first@example.com> <root@example.com>' });
    assert.equal(request.headers['idempotency-key'], 'course-1:0');
  });

  it('rejects header injection before anything is sent', async () => {
    const { run, requests } = stubbed();
    await assert.rejects(
      sendMessage({ ...base, headers: { 'In-Reply-To': '<root@example.com>\r\nBcc: attacker@example.com' } }, { providerId: 'resend', credentials: resendKey, run }),
      /line break/i,
    );
    assert.equal(requests().length, 0);
  });

  it('answers an error for a non-2xx reply and does not hang', async () => {
    const { run } = stubbed({ status: 500, body: '' });
    const answer = await sendMessage(base, { providerId: 'resend', credentials: resendKey, run });
    assert.match(answer.sent[0].error, /Resend 500/);
    assert.match(answer.said, /Sent to 0 of 1/);
  });

  it('surfaces the provider\'s actual status and reason (diagnosable, not generic)', async () => {
    const { run } = stubbed({ status: 401, body: '{"message":"API key is invalid"}' });
    const answer = await sendMessage(base, { providerId: 'resend', credentials: resendKey, run });
    assert.match(answer.sent[0].error, /Resend 401: API key is invalid/);
  });

  it('answers each recipient on its own: one failing does not hide the others', async () => {
    const answers = [{ status: 422, body: '{"message":"bad address"}' }, { status: 200, body: '{"id":"m3"}' }];
    const { run: first } = stubbed(answers[0]);
    const { run: second } = stubbed(answers[1]);
    const one = await sendMessage({ ...base, recipients: ['bad@recipient.test'] }, { providerId: 'resend', credentials: resendKey, run: first });
    const two = await sendMessage({ ...base, recipients: ['good@recipient.test'] }, { providerId: 'resend', credentials: resendKey, run: second });
    assert.match(one.sent[0].error, /422: bad address/);
    assert.equal(two.sent[0].messageId, 'm3');
  });
});

describe('text through Twilio and email through Amazon SES (carried adapters)', () => {
  it('sends a text with the account id, number and held token', async () => {
    const { run, requests } = stubbed({ status: 201, body: '{"sid":"SM0001"}' });
    const answer = await sendMessage({ recipients: ['+15550100'], from: '+15550199', account_sid: 'AC0000example', text: 'Running late' }, { providerId: 'twilio-sms', credentials: { TWILIO_AUTH_TOKEN: 'test-token-twilio' }, run });
    assert.equal(answer.sent[0].messageId, 'SM0001');
    const [request] = requests();
    assert.equal(request.url, 'https://api.twilio.com/2010-04-01/Accounts/AC0000example/Messages.json');
    assert.equal(request.headers.authorization, `Basic ${Buffer.from('AC0000example:test-token-twilio').toString('base64')}`);
    assert.equal(new URLSearchParams(request.body).get('Body'), 'Running late');
    assert.equal(new URLSearchParams(request.body).get('To'), '+15550100');
  });

  it('sends an email through the SES query API, signed', async () => {
    const { run, requests } = stubbed({ status: 200, body: '<SendEmailResponse><SendEmailResult><MessageId>ses-1</MessageId></SendEmailResult></SendEmailResponse>' });
    const answer = await sendMessage({ ...base, region: 'us-east-1' }, { providerId: 'amazon-ses', credentials: { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'test-secret-ses' }, run });
    assert.equal(answer.sent[0].messageId, 'ses-1');
    const [request] = requests();
    assert.equal(request.url, 'https://email.us-east-1.amazonaws.com/');
    const form = new URLSearchParams(request.body);
    assert.equal(form.get('Action'), 'SendEmail');
    assert.equal(form.get('Source'), sender);
    assert.equal(form.get('Destination.ToAddresses.member.1'), 'someone@recipient.test');
    assert.equal(form.get('Message.Subject.Data'), 'Hello');
    assert.equal(form.get('Message.Body.Text.Data'), 'Hi');
    assert.match(request.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
  });

  it('reads the reason out of an SES error', async () => {
    const { run } = stubbed({ status: 403, body: '<ErrorResponse><Error><Message>Email address is not verified.</Message></Error></ErrorResponse>' });
    const answer = await sendMessage({ ...base, region: 'us-east-1' }, { providerId: 'amazon-ses', credentials: { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'test-secret-ses' }, run });
    assert.match(answer.sent[0].error, /SES 403: Email address is not verified\./);
  });

  it('signs the way AWS publishes (its Signature Version 4 get-vanilla test vector)', () => {
    const { signV4 } = createRequire(import.meta.url)('../do-work/send-via-amazon-ses.cjs');
    const authorization = signV4({
      method: 'GET', path: '/', headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' }, body: '',
      region: 'us-east-1', service: 'service', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', amzDate: '20150830T123600Z',
    });
    assert.equal(authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });
});

describe('Messages on this Mac (carried from the Messages sender)', () => {
  const fake = (reply) => {
    const calls = [];
    return { calls, runCommand: async (argv, timeout) => { calls.push({ argv, timeout }); return typeof reply === 'function' ? reply(argv) : reply; } };
  };
  const request = { recipients: ['+15550100'], text: 'hello from the sender' };

  it('runs the script directly and passes the recipient and body as their own arguments', async () => {
    const { calls, runCommand } = fake({ code: 0, stdout: 'SENT\n', stderr: '' });
    const answer = await sendMessage(request, { providerId: 'messages-on-this-mac', runCommand });
    assert.deepEqual(answer.sent, [{ recipient: '+15550100' }]);
    const [{ argv }] = calls;
    assert.equal(argv[0], 'osascript');
    assert.ok(argv.includes('+15550100'));
    assert.ok(argv.includes('hello from the sender'));
    assert.ok(!argv.some(word => word.includes('hello from the sender') && word.includes('tell application')), 'the body is not woven into the script');
  });

  it('fails CLOSED with what to allow when macOS refuses the event', async () => {
    const { runCommand } = fake({ code: 1, stdout: '', stderr: 'execution error: Not authorized to send Apple events to Messages. (-1743)' });
    await assert.rejects(sendMessage(request, { providerId: 'messages-on-this-mac', runCommand }), error => {
      assert.ok(error instanceof MessageBlockedError);
      assert.equal(error.code, 'blocked_needs_grant');
      assert.match(error.message, /Automation control of "Messages"/);
      return true;
    });
  });

  it('answers an error on a non-zero exit with no success marker', async () => {
    const { runCommand } = fake({ code: 2, stdout: '', stderr: 'some other failure' });
    const answer = await sendMessage(request, { providerId: 'messages-on-this-mac', runCommand });
    assert.match(answer.sent[0].error, /rejected the send: some other failure/);
  });

  it('answers an error when the exit is 0 but the success marker is absent', async () => {
    const { runCommand } = fake({ code: 0, stdout: 'nothing useful', stderr: '' });
    const answer = await sendMessage(request, { providerId: 'messages-on-this-mac', runCommand });
    assert.match(answer.sent[0].error, /rejected the send/);
  });

  it('answers each recipient of a list on its own', async () => {
    const { runCommand } = fake(argv => (argv.includes('+15550101') ? { code: 2, stdout: '', stderr: 'no such buddy' } : { code: 0, stdout: 'SENT', stderr: '' }));
    const answer = await sendMessage({ recipients: ['+15550100', '+15550101'], text: 'hi' }, { providerId: 'messages-on-this-mac', runCommand });
    assert.equal(answer.sent[0].error, undefined);
    assert.match(answer.sent[1].error, /no such buddy/);
  });

  it('rejects an unknown provider with no first-match fallback', async () => {
    await assert.rejects(sendMessage(request, { providerId: 'no-such-provider' }), /Unsupported provider: no-such-provider/);
    assert.throws(() => providerOf('ghost'), MessageRejectedError);
  });

  const row = { process: { interpreter_argv: ['osascript', '-l', 'AppleScript', '-e', 'on run argv\nreturn "SENT"\nend run'], timeout_ms: 30000, success_stdout_marker: 'SENT', tcc_denial: { stderr_patterns: ['-1743', 'Not authorized to send Apple events'], remediation: 'Grant Automation control of "Messages" to the sending process, then retry.' } } };

  it('builds the command from DATA: recipient and body follow the script as arguments', () => {
    const call = buildSendInvocation(row, { recipient: '+15550100', body: 'hi' });
    assert.deepEqual(call.argv.slice(0, 5), row.process.interpreter_argv);
    assert.deepEqual(call.argv.slice(5), ['+15550100', 'hi']);
    assert.equal(call.timeout_ms, 30000);
    assert.equal(call.success_stdout_marker, 'SENT');
  });

  it('matches a permission denial without regard to case', () => {
    const patterns = row.process.tcc_denial.stderr_patterns;
    assert.equal(isTccDenial('error (-1743)', patterns), true);
    assert.equal(isTccDenial('NOT AUTHORIZED TO SEND APPLE EVENTS', patterns), true);
    assert.equal(isTccDenial('recipient offline', patterns), false);
  });
});

describe('the keys and the rows', () => {
  const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);

  it('each provider\'s row mounts exactly the secrets the provider\'s DATA names, one descriptor each', () => {
    for (const provider of providers()) {
      const row = rows.find(item => item.invoke.argv?.includes(provider.id) && item.invoke.argv.at(-1) === provider.id);
      if (provider.kind === 'process') {
        assert.equal(provider.credentials.length, 0);
        assert.equal(rows.find(item => item.invoke.kind === 'computer').invoke.capabilities.length, 1);
        continue;
      }
      assert.deepEqual(row.invoke.credential_mounts, provider.credentials.map(({ secret_name, fd }) => ({ secret_name, fd })), provider.id);
      assert.equal(row.invoke.internet, true);
    }
  });

  it('a missing key is refused in words before anything runs', async () => {
    await assert.rejects(sendMessage(base, { providerId: 'resend', credentials: {} }), /No resend-api-key was handed to this run/);
  });

  it('heldKeys reads each key from its descriptor and a missing one as empty', () => {
    const provider = providerOf('amazon-ses');
    assert.deepEqual(heldKeys(provider, descriptor => (descriptor === 3 ? 'key-id' : (() => { throw new Error('closed'); })())), { AWS_ACCESS_KEY_ID: 'key-id', AWS_SECRET_ACCESS_KEY: '' });
  });

  it('the command takes the key from a private descriptor and it appears nowhere else', async () => {
    const log = join(work, 'cli-requests.jsonl');
    writeFileSync(log, '');
    const keyFile = join(work, 'key');
    writeFileSync(keyFile, 'test-key-descriptor');
    const stdio = ['pipe', 'pipe', 'pipe', openSync(keyFile, 'r')];
    const child = spawn(process.execPath, [join(folder, 'do-work', 'send-a-message.mjs'), 'resend'], {
      stdio, env: { ...process.env, NODE_OPTIONS: `--import=${stub}`, STUB_LOG: log, STUB_REPLY: '{"status":200,"body":"{\\"id\\":\\"m9\\"}"}' },
    });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stdin.end(JSON.stringify(base));
    await new Promise(done => child.on('close', done));
    const answer = JSON.parse(out.trim().split("\n").at(-1)).result;
    assert.equal(answer.sent[0].messageId, 'm9');
    assert.ok(!out.includes('test-key-descriptor'), 'the key is not in the answer');
    const [request] = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(request.headers.authorization, 'Bearer test-key-descriptor');
    assert.ok(!JSON.stringify(request.argv).includes('test-key-descriptor'), 'the key is not in the adapter\'s argv');
  });

  it('the adapter files named in the DATA are in the folder', () => {
    for (const provider of providers().filter(item => item.kind === 'adapter')) {
      assert.ok(readFileSync(join(folder, 'do-work', provider.adapter), 'utf8').length > 0, provider.adapter);
    }
  });
});
