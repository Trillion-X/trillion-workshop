// test-helpers/import-source-for-tests.mjs
//
// Purpose: run JavaScript a test built in memory (an esbuild bundle of a screen module, a part) as a module under a short
// name. Tests used to import such text as a `data:` URL, and that URL, the whole bundle, became the file name of every
// stack frame: one error eight frames deep inside a 31 MB bundle held a 360 MB string outside the JavaScript heap, and
// every error caught, logged or reported multiplied that, so test files grew to 5-29 GB of resident memory and nearly
// stopped the computer (2026-10-05). Here the text is kept once and its module is named `source-for-tests:<n>.mjs`.
//
// Non-negotiable invariants
//   1. The same text is the same module (as a `data:` URL of it was); `copy` names a separate instance of it.
//   2. A module imported this way resolves its own imports (node builtins, packages) the way a test file does, and its
//      relative imports (`./x.mjs`) against the folder its text came from: this folder, unless `from` names another.
//   3. Nothing is written to disk.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { registerHooks } from 'node:module';

// Esbuild's binary loader emits Uint8Array.fromBase64 for bundled WASM. Older Node lacks that built-in even though the
// bundle works under newer Node. Keep the test host compatible without changing the bundled product code.
if (typeof Uint8Array.fromBase64 !== 'function') {
  Uint8Array.fromBase64 = value => new Uint8Array(Buffer.from(value, 'base64'));
}

const SCHEME = 'source-for-tests:';
const named = new Map(); // text -> its module's name
const texts = new Map(); // name -> text
const bases = new Map(); // name -> the address its relative imports resolve against
const SOURCE = new URL('./', import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(SCHEME)) return { url: specifier, shortCircuit: true };
    if (context.parentURL?.startsWith(SCHEME)) {
      const base = bases.get(context.parentURL.replace(/[#?].*$/, ''));
      return next(/^\.{1,2}\//.test(specifier) ? new URL(specifier, base).href : specifier, { ...context, parentURL: import.meta.url });
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith(SCHEME)) return next(url, context);
    return { format: 'module', source: texts.get(url.replace(/[#?].*$/, '')), shortCircuit: true };
  },
});

/**
 * Imports `text` as a module; `copy` (any value) imports a separate instance of the same text. `from` is the folder (or
 * file) address its relative imports resolve against, this folder when left out; the same text keeps the address it was
 * first imported with.
 */
export function importSource(text, copy, { from = SOURCE } = {}) {
  if (!named.has(text)) {
    const name = `${SCHEME}${named.size + 1}.mjs`;
    named.set(text, name);
    texts.set(name, text);
    bases.set(name, String(from));
  }
  const name = named.get(text);
  return import(copy === undefined ? name : `${name}#${encodeURIComponent(String(copy))}`);
}
