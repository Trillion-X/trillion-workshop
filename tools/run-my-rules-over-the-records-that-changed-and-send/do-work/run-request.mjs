// tools/run-my-rules-over-the-records-that-changed-and-send/do-work/run-request.mjs
//
// Run by the Workshop row tool:evaluate-rules-over-records in the tool container:
//   node do-work/run-request.mjs < <the request as JSON>
// Prints { result } as JSON on its last line, or { error } and why. The trigger engine is the committed web module of
// tools/build-engine-modules-for-web-hosts (built-stored-bytes/trigger-engine), run by src/rules-over-records.mjs with
// no host, so nothing is sent: every send the rules make comes back in `fires` for the caller to run.
import { readFileSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { makeRulesOverRecords } from '../src/rules-over-records.mjs';

const BUILT = new URL('../../build-engine-modules-for-web-hosts/built-stored-bytes/trigger-engine/', import.meta.url);

async function triggerEngine() {
  const bindings = await import(new URL('trigger_engine_web.js', BUILT).href);
  bindings.initSync({ module: new WebAssembly.Module(readFileSync(new URL('trigger_engine_web_bg.wasm', BUILT))) });
  return bindings;
}

try {
  const { evaluateRulesOverRecords } = makeRulesOverRecords(triggerEngine);
  console.log(JSON.stringify({ result: await evaluateRulesOverRecords(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
