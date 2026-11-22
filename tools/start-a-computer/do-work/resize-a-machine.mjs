// tools/start-a-computer/do-work/resize-a-machine.mjs
//
// The resize verb for a rented machine: `node resize-a-machine.mjs LEASE_FILE SIZE`, with the provider's API key on stdin
// (piped, never argv). The lease names the provider description (`providerFile`), so the key reaches only the calls that
// description declares. Writes the answer as one JSON line on stdout; a refusal or a failed resize writes its message to
// stderr and exits 1 (2 for a usage error). A disk is always kept (`resizeMachine`, keep_disk).
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { fileStore, providerClient, readLease, readProvider, resizeMachine } from './rent-a-machine.mjs';

/** The key on stdin, bounded; trimmed, and never echoed. */
async function stdinKey() {
  let text = '';
  for await (const bytes of process.stdin) { text += bytes; if (text.length > 4096) throw new Error('The key on stdin exceeds its bound.'); }
  return text.trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [leaseFile, size, extra] = process.argv.slice(2);
  try {
    if (!leaseFile || !size || extra) throw Object.assign(new Error('usage: resize-a-machine.mjs LEASE_FILE SIZE (the provider key on stdin)'), { exit: 2 });
    const store = fileStore(resolvePath(leaseFile)), provider = readProvider((await readLease(store)).providerFile);
    const answer = await resizeMachine({ request: providerClient(provider, await stdinKey()), store, provider, size });
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exit ?? 1;
  }
}
