// tools/send-messages/test/stub-fetch.mjs
//
// Preloaded into an adapter process with NODE_OPTIONS=--import=<this file>. It replaces the global fetch with one
// that writes each request (url, method, headers, body, and the process's own argv) as a JSON line to the file named
// by STUB_LOG, and answers with STUB_REPLY ({ "status": 200, "body": "text" }). Nothing leaves the machine. A call to
// this computer's loopback (a stand-in records door) goes to it as it is.
import { appendFileSync } from 'node:fs';

const loopback = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith('http://127.0.0.1:')) return loopback(url, init);
  const reply = JSON.parse(process.env.STUB_REPLY ?? '{"status":200,"body":"{}"}');
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
  appendFileSync(process.env.STUB_LOG, `${JSON.stringify({ url: String(url), method: init.method, headers, body: String(init.body ?? ''), argv: process.argv })}\n`);
  return new Response(reply.body, { status: reply.status });
};
