// computer/script-sandbox-worker.mjs
//
// The side of computer/script-sandbox.mjs that runs inside the worker thread. It builds the script's context here: a global
// with a null prototype, `pm` made INSIDE the context from one host call that moves only strings, so nothing the script can
// reach is an object of this thread (no Function constructor of this thread, no process, no require).
import vm from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';

const pending = new Map();
let next = 1;
parentPort.on('message', message => {
  const waiting = pending.get(message.id);
  if (!waiting) return;
  pending.delete(message.id);
  waiting(message.reply);
});

// The only function the context ever holds: strings in, one string out through a callback.
function hostCall(request, callback) {
  const id = next++;
  pending.set(id, reply => callback(JSON.stringify(reply)));
  parentPort.postMessage({ call: { id, request: JSON.parse(request) } });
}

const BOOT = `(function (call, libraries, input) {
  'use strict';
  const ask = (kind, args) => new Promise((resolve, reject) => {
    call(JSON.stringify({ kind, args }), text => {
      const reply = JSON.parse(text);
      if (reply.error) reject(new Error(reply.error)); else resolve(reply.value);
    });
  });
  const pm = Object.create(null);
  pm.input = input;
  pm.sendRequest = request => ask('send_request', request);
  pm.files = Object.create(null);
  pm.files.read = path => ask('files_read', { path });
  pm.cookies = Object.create(null);
  pm.cookies.get = (domain, name) => ask('cookies_get', { domain, name });
  pm.cookies.set = (domain, name, value) => ask('cookies_set', { domain, name, value });
  pm.require = name => ask('require', { name });
  const global = globalThis;
  global.pm = pm;
  for (const [name, source] of Object.entries(libraries)) global[name] = (0, eval)(source);
})`;

const context = Object.create(null);
vm.createContext(context, { codeGeneration: { strings: true, wasm: false } });
try {
  vm.runInContext(BOOT, context)(hostCall, workerData.libraries ?? {}, workerData.input ?? null);
  const body = vm.runInContext(`(async function () { 'use strict';\n${workerData.code}\n})()`, context, { timeout: workerData.wall_ms });
  body.then(
    value => parentPort.postMessage({ done: { value: JSON.stringify(value === undefined ? null : value) } }),
    error => parentPort.postMessage({ done: { error: String(error?.message ?? error) } }),
  );
} catch (error) {
  parentPort.postMessage({ done: { error: String(error?.message ?? error) } });
}
