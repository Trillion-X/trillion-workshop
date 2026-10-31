// A small bridge for callers that cannot import the ESM identity library directly.
// It reads exact bytes from stdin, writes one canonical identity, and reads no file.
import { makeHashCodeHexFromBytes } from '../read-data/identity.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const bytes = Buffer.concat(chunks);
process.stdout.write(`${makeHashCodeHexFromBytes(bytes)}\n`);
