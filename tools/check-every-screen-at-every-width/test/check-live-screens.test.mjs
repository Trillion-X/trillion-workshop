// test/check-live-screens.test.mjs
// tools/check-every-screen-at-every-width/check-live-screens.mjs measures a live page. This serves four fixture pages from a
// tiny local server (a page that answers and taps, a page that is busy before it is usable, a page that logs an error and
// asks for a missing file, a page that stays blank for a while) and asserts the numbers each one should give, and the
// refusals of a bad input, which open no browser at all.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { after, before } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { addressOf, checkLiveScreens, cookieOfSetCookie, keepPicture, planOf, signInWithEmailCode } from '../check-live-screens.mjs';
import { windowPicture } from '../window-picture.mjs';

const pageOf = (body, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>fixture</title></head><body style="margin:0;padding:16px;font:16px sans-serif"><main id="app">${body}</main><script>${script}</script></body></html>`;

const FIXTURES = {
  '/answers': pageOf('<h1>Members</h1><button id="show">Show</button><p id="empty"></p>',
    `document.getElementById('show').addEventListener('click', () => { const note = document.createElement('p'); note.id = 'done'; note.textContent = 'Opened'; document.getElementById('app').append(note); });`),
  '/busy': pageOf('<h1 id="ready">Ready</h1>', 'const until = performance.now() + 800; while (performance.now() < until) { /* a long task */ }'),
  '/broken': pageOf('<h1>Broken</h1><img src="/missing.png" alt="">', `console.error('the fixture failed on purpose');`),
  '/late': pageOf('<h1 id="late" hidden>Late</h1>', `setTimeout(() => { document.getElementById('late').hidden = false; }, 1200);`),
};

let server;
let origin;

before(async () => {
  server = createServer((request, response) => {
    const body = FIXTURES[new URL(request.url, 'http://fixture').pathname];
    if (request.url === '/missing.png') { response.writeHead(404); response.end(); return; }
    if (!body) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise(done => server.close(done)));

// A keep that writes nothing: it records the names the pictures would have had in the person's Files.
function recorder() {
  const kept = [];
  const keep = async (name, bytes) => {
    kept.push({ name, size: bytes.length });
    return { picture: `1f:${'0'.repeat(64)}`, picture_kept: true };
  };
  return { kept, keep };
}

test('a page list is checked before any browser opens: a missing url, a bad address, an unknown view and a bad expect are refused', () => {
  assert.throws(() => planOf({}), /Give pages/);
  assert.throws(() => planOf({ pages: [{ id: 'a' }] }), /needs url/);
  assert.throws(() => planOf({ pages: [{ id: 'a', url: 'file:///etc/passwd' }] }), /full address \(http or https\)/);
  assert.throws(() => planOf({ pages: [{ id: 'a', url: origin }], views: ['watch'] }), /views is a list of/);
  assert.throws(() => planOf({ pages: [{ id: 'a', url: origin, taps: [{ name: 'x', selector: 'button', expect: { shown: true } }] }] }), /expect names/);
  assert.throws(() => planOf({ pages: [{ id: 'a', url: origin, sign_in: { cookies: [{ name: 'session' }] } }] }), /needs a name and a value/);
  assert.throws(() => planOf({ pages: [{ id: 'a', url: origin }, { id: 'A', url: origin }] }), /another page has the name/);
});

test('the phone view is the phone width with its throttle, the desktop view has none', () => {
  const plan = planOf({ pages: [{ id: 'a', url: origin }] });
  const phone = plan.views.find(view => view.id === 'phone');
  const desktop = plan.views.find(view => view.id === 'desktop');
  assert.equal(phone.throttle.cpu_rate, 4);
  assert.equal(desktop.throttle, null);
});

test('the address in a report has no query, so a sign-in token in it is not printed', () => {
  assert.equal(addressOf('https://ethosschooloftennis.com/members?token=secret#top'), 'https://ethosschooloftennis.com/members');
});

test('a page that answers is measured, pictured, and its tap is worked when the expected text appears', async () => {
  const { kept, keep } = recorder();
  const answer = await checkLiveScreens({
    pages: [{ id: 'answers', url: `${origin}/answers`, ready: '#show', taps: [
      { name: 'show the note', selector: '#show', expect: { appears: '#done', text: 'Opened' } },
      { name: 'a control that is not there', selector: '#nothing', expect: { appears: '#done' } },
    ] }],
    views: ['desktop'],
  }, undefined, { keep });
  const view = answer.pages[0].views[0];
  assert.equal(view.view, 'desktop');
  assert.equal(view.new.status, 200);
  assert.equal(typeof view.new.usable_ms, 'number');
  assert.ok(view.new.blank_ms !== null && view.new.blank_ms <= view.new.usable_ms, 'the page showed something before it was usable');
  assert.equal(view.new.picture, `1f:${'0'.repeat(64)}`);
  assert.equal(view.new.picture_kept, true);
  assert.equal(view.taps[0].worked, true);
  assert.equal(typeof view.taps[0].ms, 'number');
  assert.equal(view.taps[1].worked, false);
  assert.match(view.taps[1].detail, /did not happen/);
  assert.equal(kept.length, 3, 'one picture of the page and one of each tap');
  assert.match(kept[0].name, /^\/live-screens\/[0-9a-f-]+\/answers-desktop-new\.png$/);
});

test('a page busy with a long task is usable only after the task and the idle time, and its longest task is reported', async () => {
  const { keep } = recorder();
  const answer = await checkLiveScreens({ pages: [{ id: 'busy', url: `${origin}/busy`, ready: '#ready' }], views: ['desktop'] }, undefined, { keep });
  const side = answer.pages[0].views[0].new;
  assert.ok(side.longest_task_ms >= 700, `longest task ${side.longest_task_ms} ms`);
  assert.ok(side.usable_ms >= 800 + 500 - 100, `usable at ${side.usable_ms} ms`);
});

test('a screen that shows its content late is blank until it does', async () => {
  const { keep } = recorder();
  const answer = await checkLiveScreens({ pages: [{ id: 'late', url: `${origin}/late` }], views: ['desktop'] }, undefined, { keep });
  const side = answer.pages[0].views[0].new;
  assert.ok(side.blank_ms >= 1000, `blank for ${side.blank_ms} ms`);
});

test('console errors and failed requests are listed by name, and a failed picture request counts', async () => {
  const { keep } = recorder();
  const answer = await checkLiveScreens({ pages: [{ id: 'broken', url: `${origin}/broken` }], views: ['desktop'] }, undefined, { keep });
  const side = answer.pages[0].views[0].new;
  assert.ok(side.console_errors.some(text => text.includes('the fixture failed on purpose')));
  assert.ok(side.failed_requests.some(text => text.endsWith('/missing.png 404')));
  assert.equal(side.failed_request_count, side.failed_requests.length);
});

test('a page that does not open reports its error and does not stop the other pages', async () => {
  const { keep } = recorder();
  const answer = await checkLiveScreens({ pages: [{ id: 'gone', url: 'http://127.0.0.1:9/nothing' }, { id: 'answers', url: `${origin}/answers` }], views: ['desktop'] }, undefined, { keep });
  assert.ok(answer.pages[0].views[0].new.error, 'the failure is named');
  assert.equal(answer.pages[1].views[0].new.status, 200);
});

test('a view that begins after until is answered as skipped and never opened', async () => {
  const { kept, keep } = recorder();
  const answer = await checkLiveScreens({ pages: [{ id: 'answers', url: `${origin}/answers` }], views: ['phone', 'desktop'], until: Date.now() - 1000 }, undefined, { keep });
  assert.deepEqual(answer.pages[0].views, [{ view: 'phone', skipped: 'until' }, { view: 'desktop', skipped: 'until' }]);
  assert.equal(kept.length, 0);
});

test('a picture that cannot be kept is returned inline when it is small, and says why it was not kept', async () => {
  const small = Buffer.from('small picture');
  const kept = await keepPicture(undefined, '/live-screens/x/a.png', small);
  assert.equal(kept.picture_kept, false);
  assert.equal(kept.png_base64, small.toString('base64'));
  assert.match(kept.picture, /^1f:[0-9a-f]{64}$/);
  const large = Buffer.alloc(200 * 1024);
  const big = await keepPicture(undefined, '/live-screens/x/b.png', large);
  assert.equal(big.png_base64, undefined);
  assert.ok(big.reason);
});

test('window is true or false, and the window picture is asked only then', () => {
  assert.throws(() => planOf({ pages: [{ id: 'a', url: origin }], window: 'yes' }), /window is true or false/);
  assert.equal(planOf({ pages: [{ id: 'a', url: origin }], window: true }).window, true);
  assert.equal(planOf({ pages: [{ id: 'a', url: origin }] }).window, false);
});

test('the window picture is the widest on-screen main window, captured by its id and kept by the same keep path', async () => {
  const calls = [];
  const exec = async (program, args) => {
    calls.push([program, args]);
    if (program.endsWith('python3')) {
      return { stdout: JSON.stringify([
        { id: 77, name: '', layer: 101, width: 400, height: 560, onscreen: true },
        { id: 54, name: 'Trillion', layer: 0, width: 1232, height: 748, onscreen: true },
        { id: 9, name: '', layer: 0, width: 1728, height: 33, onscreen: false },
      ]) };
    }
    const file = args.at(-1);
    await writeFile(file, Buffer.from('png bytes'));
    return { stdout: '' };
  };
  const kept = [];
  const answer = await windowPicture({ owner: 'Trillion', name: '/live-screens/r/window.png', keep: async (name, bytes) => { kept.push([name, bytes.toString()]); return { picture: '1f:x', picture_kept: true }; } }, { exec });
  assert.equal(answer.window.id, 54);
  assert.deepEqual(calls[1][1].slice(0, 4), ['-x', '-o', '-l', '54']);
  assert.deepEqual(kept, [['/live-screens/r/window.png', 'png bytes']]);
  assert.equal(answer.picture_kept, true);
});

test('a window the window server refuses to capture is answered with its reason, not a picture', async () => {
  const exec = async program => {
    if (program.endsWith('python3')) return { stdout: JSON.stringify([{ id: 54, name: 'Trillion', layer: 0, width: 1232, height: 748, onscreen: true }]) };
    throw Object.assign(new Error('Command failed'), { stderr: 'could not create image from window\nmore\n' });
  };
  const answer = await windowPicture({ owner: 'Trillion' }, { exec });
  assert.equal(answer.error, 'capture_refused');
  assert.equal(answer.reason, 'could not create image from window');
});

test('an owner with no window on screen is answered as no_window', async () => {
  const exec = async () => ({ stdout: '[]' });
  assert.deepEqual(await windowPicture({ owner: 'Trillion' }, { exec }).then(answer => answer.error), 'no_window');
});

test('sign_in is a list of cookies or one email code; reach is a list of taps and waits', () => {
  const page = (extra) => planOf({ pages: [{ id: 'a', url: origin, ...extra }] }).pages[0];
  assert.deepEqual(page({ sign_in: { kind: 'email-code', origin: 'https://app.ethosschooloftennis.com', email: 'x@agentmail.to', code: '123456' } }).signIn,
    { kind: 'email-code', origin: 'https://app.ethosschooloftennis.com', email: 'x@agentmail.to', code: '123456' });
  assert.throws(() => page({ sign_in: { kind: 'email-code', origin: 'https://a.example', email: 'x@agentmail.to', code: '12' } }), /six-digit code/);
  assert.throws(() => page({ sign_in: { kind: 'email-code', origin: 'file:///x', email: 'x@agentmail.to', code: '123456' } }), /full address/);
  assert.equal(page({ sign_in: { cookies: [{ name: 'session', value: 'v' }] } }).signIn.kind, 'cookies');
  assert.deepEqual(page({ reach: [{ tap: '#billing' }, { wait: '#billing-panel' }] }).reach, [{ tap: '#billing' }, { wait: '#billing-panel' }]);
  assert.deepEqual(page({}).reach, []);
  assert.throws(() => page({ reach: [{ tap: '#a', wait: '#b' }] }), /reach\[0\] is/);
  assert.throws(() => page({ reach: 'billing' }), /reach is a list/);
});

test('a Set-Cookie line becomes a cookie for the origin host, with its path and flags', () => {
  assert.deepEqual(cookieOfSetCookie('__Secure-session=abc.def; Path=/; HttpOnly; Secure; SameSite=Lax', 'app.ethosschooloftennis.com'),
    { name: '__Secure-session', value: 'abc.def', domain: 'app.ethosschooloftennis.com', path: '/', httpOnly: true, secure: true });
});

test('an email code is exchanged for the session cookies with the page origin, and a refused code names only its status', async () => {
  const seen = [];
  const cookieLines = ['sid=one; Path=/; HttpOnly', 'other=two; Path=/'];
  const okFetch = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, headers: { getSetCookie: () => cookieLines } }; };
  const cookies = await signInWithEmailCode({ origin: 'https://app.ethosschooloftennis.com', email: 'x@agentmail.to', code: '654321' }, { fetchImpl: okFetch });
  assert.equal(cookies.length, 2);
  assert.equal(seen[0].url, 'https://app.ethosschooloftennis.com/api/auth/sign-in/email-otp');
  assert.equal(seen[0].init.headers.origin, 'https://app.ethosschooloftennis.com');
  assert.deepEqual(JSON.parse(seen[0].init.body), { email: 'x@agentmail.to', otp: '654321' });
  const refused = async () => ({ ok: false, status: 400, headers: { getSetCookie: () => [] } });
  await assert.rejects(signInWithEmailCode({ origin: 'https://app.ethosschooloftennis.com', email: 'x@agentmail.to', code: '654321' }, { fetchImpl: refused }), error => {
    assert.equal(error.code, 'sign_in_refused');
    assert.ok(!error.message.includes('654321'), 'the code is never in a message');
    assert.match(error.message, /status 400/);
    return true;
  });
});
