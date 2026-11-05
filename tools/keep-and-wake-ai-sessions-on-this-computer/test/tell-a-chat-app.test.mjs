// harness/tell-a-chat-app.mjs in a headless browser: a chat page served here stands in for a chat app, reached over the
// Chrome DevTools protocol. The suite never drives the person's own browser: a test that opened its page in their Arc put
// a stray 127.0.0.1:<port>/c/appears tab in front of them on every run. The message is typed and sent, a send button that shows only once text is in the
// box is found, a signed-out page and a send that leaves the message in the box are reported as not sent, ways that
// cannot reach a browser are skipped with the reason said, and every browser host row carries what the sender reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { launchChromium } from 'trillion-workshop/tools/headless-browser/launch.mjs';
import { tellChatApp } from '../harness/tell-a-chat-app.mjs';
import rules from '../harness/work-consumer.json' with { type: 'json' };

// One chat page: a box and a send button that posts the words to the chat's thread (kept here in `heard`), a page with a
// sign-in button only, and a page whose send button does nothing.
const pages = {
  '/c/thread-1': '<!doctype html><title>chat</title><div id="box" contenteditable="true"></div><button id="send" onclick="fetch(\'/said/thread-1\',{method:\'POST\',body:box.textContent}).then(()=>{box.textContent=\'\'})">Send</button>',
  '/': '<!doctype html><title>new chat</title><textarea id="box"></textarea><button id="send" onclick="fetch(\'/said/new\',{method:\'POST\',body:box.value}).then(()=>{box.value=\'\'})">Send</button>',
  '/signed-out': '<!doctype html><title>chat</title><button data-login-button>Log in</button>',
  '/c/send-shows': '<!doctype html><title>chat</title><div id="box" contenteditable="true" role="textbox"></div><button id="send" hidden onclick="fetch(\'/said/send-shows\',{method:\'POST\',body:box.textContent}).then(()=>{box.textContent=\'\';send.hidden=true})">Send</button><script>box.addEventListener(\'input\',()=>{send.hidden=!box.textContent.trim()})</script>',
  '/stuck': '<!doctype html><title>chat</title><div id="box" contenteditable="true"></div><button id="send">Send</button>',
};

const testLifetime = { timeout: 90_000 };

async function withChat(t, run) {
  t.signal.throwIfAborted();
  const heard = [];
  const server = createServer((request, response) => {
    if (request.method === 'POST') {
      let body = '';
      request.on('data', chunk => { body += chunk; }).on('end', () => { heard.push([request.url, body]); response.end('ok'); });
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(pages[request.url] ?? pages['/']);
  });
  let browser;
  const closeOnAbort = () => {
    void browser?.close().catch(() => {});
    server.closeAllConnections();
  };
  t.signal.addEventListener('abort', closeOnAbort, { once: true });
  try {
    server.listen({ port: 0, host: '127.0.0.1', signal: t.signal });
    await once(server, 'listening', { signal: t.signal });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const port = 9300 + Math.floor(Math.random() * 500);
    browser = await launchChromium({
      args: [`--remote-debugging-port=${port}`],
      admission: { signal: t.signal, timeoutMs: 30_000 },
      timeout: 20_000,
    });
    t.signal.throwIfAborted();
    await run({ origin, cdp: `http://127.0.0.1:${port}`, heard });
  } finally {
    t.signal.removeEventListener('abort', closeOnAbort);
    try {
      await browser?.close();
    } finally {
      await new Promise((resolve, reject) => {
        server.close(error => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
        server.closeAllConnections();
      });
    }
  }
}

const row = (origin, routes = [{ kind: 'cdp' }]) => ({ routes, open: `${origin}/c/{session}`, open_new: `${origin}/`, composer: ['#prompt-textarea', '#box'], send: { buttons: ['#send:not([hidden])'], key: 'Enter' }, signed_out: ['[data-login-button]'], wait_ms: 5000 });

test('the message is typed into the chat and sent, in an existing chat and in a new one', testLifetime, async t => {
  await withChat(t, async ({ origin, cdp, heard }) => {
    const said = 'You have work waiting in Trillion: look into my goal. Call take_work.';
    const sent = await tellChatApp({ browser: row(origin), cdp, session: 'thread-1', message: said });
    assert.deepEqual(sent, { started: true, how: `sent in ${new URL(origin).host} through cdp` });
    const fresh = await tellChatApp({ browser: row(origin), cdp, message: said });
    assert.equal(fresh.started, true);
    assert.deepEqual(heard, [['/said/thread-1', said], ['/said/new', said]]);
  });
});

test('a signed-out chat and a message left in the box are reported as not sent, in plain words', testLifetime, async t => {
  await withChat(t, async ({ origin, cdp }) => {
    const out = await tellChatApp({ browser: { ...row(origin), open: `${origin}/{session}` }, cdp, session: 'signed-out', message: 'hi' });
    assert.equal(out.started, false);
    assert.match(out.why, /signed out in that browser; sign in there once/);
    const stuck = await tellChatApp({ browser: { ...row(origin), open: `${origin}/{session}`, wait_ms: 1500 }, cdp, session: 'stuck', message: 'hi' });
    assert.equal(stuck.started, false);
    assert.match(stuck.why, /still in the box/);
  });
});

test('a send button that shows only once text is typed is found and pressed', testLifetime, async t => {
  await withChat(t, async ({ origin, cdp, heard }) => {
    const said = 'Work waits in Trillion: look into my goal.';
    const sent = await tellChatApp({ browser: row(origin), cdp, session: 'send-shows', message: said });
    assert.equal(sent.started, true);
    assert.deepEqual(heard, [['/said/send-shows', said]]);
  });
});

test('ways that cannot reach a browser are skipped and each reason is said; a way named nowhere is said too', testLifetime, async () => {
  const out = await tellChatApp({ browser: row('http://127.0.0.1:9', [{ kind: 'cdp', cdp: 'http://127.0.0.1:9' }, { kind: 'apple-events', app: 'No Such Browser Here' }, { kind: 'carrier-pigeon' }]), message: 'hi' });
  assert.equal(out.started, false);
  assert.match(out.why, /^Not sent: no browser answers at http:\/\/127\.0\.0\.1:9; /);
  assert.match(out.why, process.platform === 'darwin' ? /No Such Browser Here is not installed on this computer/ : /this computer has no AppleScript/);
  assert.match(out.why, /this program has no way called carrier-pigeon\.$/);
});

test('--check says which way reaches a browser', testLifetime, async t => {
  await withChat(t, async ({ cdp }) => {
    const [id] = Object.entries(rules.hosts).find(([, host]) => host.browser);
    const ran = spawnSync('node', ['harness/tell-a-chat-app.mjs', '--host', id, '--check', '--cdp', cdp], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
    assert.equal(ran.status, 0);
    assert.match(ran.stdout, /^reachable through cdp/);
  });
});
