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
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const UPGRADE_ACCEPTED = 101;

export function upgradeRequestText({ host, path, key }) {
  return [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n');
}

/** The first line carries the whole verdict, and the rest of the answer is not
 * read: a body here would be an error page, which says nothing the status line
 * has not already said. */
export function statusFromAnswer(text) {
  const firstLine = String(text).split('\r\n')[0] ?? '';
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(firstLine);
  if (!match) return { status: null, first_line: firstLine };
  return { status: Number(match[1]), first_line: firstLine };
}

export async function checkLiveUpdateLane(address, { path = '/ws', timeoutMs = 20000 } = {}) {
  const url = new URL(address);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('address must be http or https');
  const secure = url.protocol === 'https:';
  const port = Number(url.port || (secure ? 443 : 80));
  const key = randomBytes(16).toString('base64');

  return await new Promise((resolveCheck) => {
    const connect = secure ? tls.connect : net.connect;
    const socket = connect(
      secure ? { host: url.hostname, port, servername: url.hostname } : { host: url.hostname, port },
      () => socket.write(upgradeRequestText({ host: url.host, path, key })),
    );
    const done = (result) => {
      socket.destroy();
      clearTimeout(timer);
      resolveCheck(result);
    };
    const timer = setTimeout(() => done({
      lane: 'no answer',
      reached: false,
      detail: `no answer within ${timeoutMs}ms`,
    }), timeoutMs);
    socket.once('data', (chunk) => {
      const { status, first_line } = statusFromAnswer(chunk.toString('utf8'));
      done({
        lane: status === UPGRADE_ACCEPTED ? 'open' : 'refused',
        reached: true,
        status,
        first_line,
      });
    });
    // A closed connection with no answer at all is the shape a destroyed
    // upgrade takes, and it is a REFUSAL by the app rather than an unreachable
    // host, so it is named as one.
    socket.once('close', () => done({ lane: 'refused', reached: true, detail: 'closed without answering' }));
    socket.once('error', (error) => done({ lane: 'unreachable', reached: false, detail: String(error?.message ?? error) }));
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
