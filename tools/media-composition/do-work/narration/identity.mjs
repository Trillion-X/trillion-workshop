// Python narration caches use the repository's one exact-byte identity owner.
import { makeHashCodeHexFromBytes } from '../../../content-identity/read-data/identity.mjs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
process.stdout.write(makeHashCodeHexFromBytes(Buffer.concat(chunks)).slice(3));
