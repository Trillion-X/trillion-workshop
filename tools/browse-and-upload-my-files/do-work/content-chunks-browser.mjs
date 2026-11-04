// Browser entry for content-defined chunking. The caller supplies the compiled
// WebAssembly module; this file deliberately has no filesystem fallback.
import * as glue from '../built-stored-bytes/content-chunks/content_chunks.js';

let loaded = null;
export function loadChunking({ module } = {}) {
  if (loaded) return loaded;
  if (!(module instanceof WebAssembly.Module)) throw new TypeError('browser chunking needs a WebAssembly.Module');
  glue.initSync({ module });
  loaded = glue;
  return loaded;
}
