#!/usr/bin/env node
// A stand-in for Chromium in devtools-pipe.test.mjs. It speaks only the pipe: it reads NUL-ended JSON messages on
// descriptor 3 and answers on descriptor 4, and it opens no port and shows no page. What it does with the command line
// is chosen by STAND_IN_MODE: "answer" (the default) answers Target.getTargets, Target.attachToTarget and Page.enable,
// and answers Runtime.evaluate with the switches it was started with; "silent" never answers; "exit" ends at start.
import { createReadStream, createWriteStream } from 'node:fs';

const mode = process.env.STAND_IN_MODE ?? 'answer';
if (mode === 'exit') {
  process.stderr.write('stand-in browser refused to start\n');
  process.exit(7);
}
const input = createReadStream(null, { fd: 3, encoding: 'utf8' });
const output = createWriteStream(null, { fd: 4 });
const reply = message => output.write(`${JSON.stringify(message)}\0`);
let heard = '';
input.on('data', chunk => {
  if (mode === 'silent') return;
  heard += chunk;
  for (let end = heard.indexOf('\0'); end >= 0; end = heard.indexOf('\0')) {
    const call = JSON.parse(heard.slice(0, end));
    heard = heard.slice(end + 1);
    if (call.method === 'Target.getTargets') reply({ id: call.id, result: { targetInfos: [{ type: 'page', targetId: 'stand-in-page' }] } });
    else if (call.method === 'Target.attachToTarget') reply({ id: call.id, result: { sessionId: 'stand-in-session' } });
    else if (call.method === 'Runtime.evaluate') {
      // Two messages in one write, the second split from its end, to prove the reader frames by NUL.
      const answer = JSON.stringify({ id: call.id, result: { result: { value: process.argv.slice(2) } } });
      output.write(`${JSON.stringify({ method: 'Page.loadEventFired', params: {}, sessionId: call.sessionId })}\0${answer.slice(0, 20)}`);
      setTimeout(() => output.write(`${answer.slice(20)}\0`), 20);
    } else reply({ id: call.id, error: { code: -32601, message: `no such method ${call.method}` } });
  }
});
