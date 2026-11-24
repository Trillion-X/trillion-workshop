// Resolves the imports of upload.ts to stand-ins, so saveTextVersion runs in Node against a fake files door. The save
// logic itself and files-door.mjs (putFile) are the real modules; the documents and failure words are their real files.
const stand = new URL('./stub-modules.mjs', import.meta.url).href;
const words = new URL('./stub-documents.mjs', import.meta.url).href;
const failures = new URL('../../../workspace-screens/web/src/workspace/failure-words.json', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (!context.parentURL?.endsWith('/workspace/upload.ts')) return nextResolve(specifier, context);
  if (specifier === './documents-words.json') return { url: words, shortCircuit: true };
  if (specifier === './failure-words.json') return { url: failures, importAttributes: { type: 'json' }, shortCircuit: true };
  if (specifier === './files-door.mjs') return nextResolve(specifier, context);
  return { url: stand, shortCircuit: true };
}
