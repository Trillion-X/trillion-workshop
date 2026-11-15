// Test adapter for the immutable pre-adaptation captures; never used in production.
import { readFile } from 'node:fs/promises';
const address = new URL('../../refuse-requests-to-private-addresses/public-address.mjs', import.meta.url).href;
const prelude = `import { NotPublicAddress, fetchPublic, publicAddress } from ${JSON.stringify(address)};
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const MAX_SAVED_BYTES = 20 * 1024 * 1024;
const bytesToHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
`;
// The encoding capture starts at line 337 inside formPairs. These preceding
// lines are the original source's 334–336, not a substitute body encoder.
const encodingStart = `const formPairs = (node, prefix = '') => {
  if (Array.isArray(node)) return node.flatMap((item, index) => formPairs(item, prefix ? \`\${prefix}[\${index}]\` : String(index)));
  if (object(node)) return Object.entries(node).flatMap(([key, item]) => formPairs(item, prefix ? \`\${prefix}[\${key}]\` : key));
`;
export async function invocationBaseline() {
  const read = name => readFile(new URL(`../source-baselines/${name}.mjs.held`, import.meta.url), 'utf8');
  const [renderer, encoding, executor] = await Promise.all(['workshop-invocation-renderer', 'workshop-invocation-encoding', 'workshop-http-json'].map(read));
  return import(`data:text/javascript;base64,${Buffer.from(prelude + renderer + encodingStart + encoding + executor).toString('base64')}`);
}
