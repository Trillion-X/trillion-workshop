// Purpose: load the content-chunks module (crates/content-chunks, built by scripts/build-content-chunks.mjs into
// ../built-stored-bytes/content-chunks/) and hand back its bindings: `Chunker` (content-defined boundaries),
// `Identity` (streaming BLAKE3) and `digest_hex` (BLAKE3 of one buffer).
//
// Where the compiled bytes come from, in order: a module the caller already compiled (a page fetches it from beside
// its own script); the bytes a served single-file uploader has written in (EMBEDDED_CONTENT_CHUNKS_WASM, base64);
// otherwise the file beside this one, read from disk.
import * as glue from '../built-stored-bytes/content-chunks/content_chunks.js';

let loaded = null;
export async function loadChunking({ module = null } = {}) {
  if (loaded) return loaded;
  const compiled = module ?? new WebAssembly.Module(typeof EMBEDDED_CONTENT_CHUNKS_WASM === 'string'
    ? Uint8Array.from(atob(EMBEDDED_CONTENT_CHUNKS_WASM), character => character.charCodeAt(0))
    : await (await import('node:fs/promises')).readFile(new URL('../built-stored-bytes/content-chunks/content_chunks_bg.wasm', import.meta.url)));
  glue.initSync({ module: compiled });
  loaded = glue;
  return loaded;
}
