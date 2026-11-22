import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { text } from 'node:stream/consumers';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

export async function hashContent(input, folder) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['text', 'path'].includes(key)) ||
      Object.hasOwn(input, 'text') === Object.hasOwn(input, 'path')) {
    throw new Error('Give exactly one of text or path.');
  }
  let bytes;
  if (Object.hasOwn(input, 'text')) {
    if (typeof input.text !== 'string') throw new Error('text must be a string.');
    bytes = new TextEncoder().encode(input.text);
  } else {
    if (typeof input.path !== 'string' || !input.path || path.isAbsolute(input.path)) {
      throw new Error('path must name a file relative to the granted Files folder.');
    }
    if (!folder || !path.isAbsolute(folder)) throw new Error('A granted Files folder is required for path.');
    const root = await realpath(folder);
    const inside = target => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
    const requested = path.resolve(root, input.path);
    if (!inside(requested)) throw new Error('path must stay inside the granted Files folder.');
    const target = await realpath(requested);
    if (!inside(target)) throw new Error('path must stay inside the granted Files folder.');
    const file = await open(target, 'r');
    try {
      if (!(await file.stat()).isFile()) throw new Error('path must name a regular file.');
      bytes = await file.readFile();
    } finally { await file.close(); }
  }
  const identity = makeHashCodeHexFromBytes(bytes);
  return { blake3: identity.slice(3), identity, bytes: bytes.byteLength };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    const input = JSON.parse(await text(process.stdin));
    console.log(JSON.stringify({ result: await hashContent(input, process.argv[2]) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 2;
  }
}
