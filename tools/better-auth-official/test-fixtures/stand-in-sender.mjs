// A stand-in email provider on a loopback port, described the way a person describes their own (settings.json email.sender): it
// keeps each message it accepts and answers its id, and refuses a message whose auth header is not its key, or every message
// when started with `refuse`. Its key is a file in a scratch credentials folder, as systemd hands a unit its credentials.
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY = 'a-stand-in-sender-key-for-tests-only';

export async function startStandInSender({ refuse = false } = {}) {
  const accepted = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (refuse || request.headers.authorization !== `Bearer ${KEY}`) {
        response.statusCode = 403;
        response.end(JSON.stringify({ message: 'The stand-in sender refused this message' }));
        return;
      }
      accepted.push(JSON.parse(body));
      response.end(JSON.stringify({ id: `stand-in-${accepted.length}` }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const credentials = mkdtempSync(join(tmpdir(), 'stand-in-sender-'));
  writeFileSync(join(credentials, 'stand-in-sender-key'), KEY);
  const email = {
    from: 'Example <sign-in@example.test>',
    sender: {
      name: 'Stand-in sender',
      vault_key: 'stand-in-sender-key',
      request: {
        url: `http://127.0.0.1:${server.address().port}/emails`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        auth: { header: 'authorization', prefix: 'Bearer ' },
        body: { from: '{from}', to: ['{to}'], subject: '{subject}', text: '{text}' },
        timeout_ms: 5000,
      },
      message_id_at: 'id',
      error_at: 'message',
    },
  };
  // Each message as its reader gets it; `otp` is the code its first line ends with, when it carries one.
  const mail = () => accepted.map(message => ({ ...message, to: message.to[0], otp: message.text.split('\n')[0].match(/(\d+)$/)?.[1] }));
  return { email, credentials, mail, stop: () => server.close() };
}
