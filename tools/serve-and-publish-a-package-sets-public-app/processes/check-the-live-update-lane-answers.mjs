#!/usr/bin/env node
// Ask a public host whether its LIVE UPDATE LANE completes a protocol upgrade.
//
// WHY THIS IS A SEPARATE CHECK FROM READING A PAGE. A host can serve a complete,
// current page and still be useless, because the page is a shell that fills
// itself over a second lane. When that lane is refused, the shell renders,
// reports every slot booted, and then fails waiting for its first snapshot, so
// the person sees a permanently empty surface while every ordinary check says
// the site is up. Reading the page cannot detect it: the page is FINE.
//
// It is also the check that a same-process engine request cannot stand in for.
// The request tools in this corpus talk plain HTTP, so they prove the entry
// server is alive and prove NOTHING about the upgrade path, which is a
// different handler with its own routing and its own refusal (an upgrade with
// no resolvable workspace is DESTROYED rather than answered, deliberately,
// because a socket has no page to redirect to). Treating an HTTP success as
// evidence about the socket is the mistake this file exists to stop.
//
// A refusal is reported as a REFUSAL, never as a failure to connect, because
// those two have opposite causes: one is the app deciding, the other is the
// network or the machine.
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const UPGRADE_ACCEPTED = 101;

// The request is node's own http/https client carrying the Upgrade headers, so
// no framing is written or parsed here: 'upgrade' is a 101, 'response' is any
// other status (the body is never read, because an error page says nothing the
// status line has not already said), and a socket that closes with no answer
// surfaces as ECONNRESET ("socket hang up").
export async function checkLiveUpdateLane(address, { path = '/ws', timeoutMs = 20000 } = {}) {
  const url = new URL(address);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('address must be http or https');
  const client = url.protocol === 'https:' ? https : http;

  return await new Promise((resolveCheck) => {
    let request;
    const done = (result) => {
      clearTimeout(timer);
      request.destroy();
      resolveCheck(result);
    };
    const timer = setTimeout(() => done({
      lane: 'no answer',
      reached: false,
      detail: `no answer within ${timeoutMs}ms`,
    }), timeoutMs);
    request = client.request(url, {
      path,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
    });
    const answered = (response) => done({
      lane: response.statusCode === UPGRADE_ACCEPTED ? 'open' : 'refused',
      reached: true,
      status: response.statusCode,
      first_line: `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}`,
    });
    request.once('upgrade', answered);
    request.once('response', answered);
    request.once('error', (error) => done(error?.code === 'ECONNRESET'
      ? { lane: 'refused', reached: true, detail: 'closed without answering' }
      : { lane: 'unreachable', reached: false, detail: String(error?.message ?? error) }));
    request.end();
  });
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('check-the-live-update-lane-answers.mjs')) {
  const address = process.argv[2];
  if (!address) {
    process.stderr.write('usage: check-the-live-update-lane-answers.mjs <https address> [path]\n');
    process.exit(1);
  }
  const result = await checkLiveUpdateLane(address, { path: process.argv[3] ?? '/ws' });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.lane === 'open' ? 0 : 1;
}
