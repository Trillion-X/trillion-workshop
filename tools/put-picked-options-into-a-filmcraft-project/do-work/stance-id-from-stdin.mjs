// tools/put-picked-options-into-a-filmcraft-project/do-work/stance-id-from-stdin.mjs
//
// A small bridge for pick_gate.py, which cannot import the ESM stance library: the id of the stance record that keeps
// the person's stand on each option, and the option's identity, made by tools/where-a-person-stands itself
// (artifact-ref.mjs artifactRef and foldWith, where-a-person-stands.mjs stanceRecordId), so the fold and the hash have
// one owner. It reads one JSON request on stdin, { kind, fold, texts: [option id] }, and writes one line,
// { ids: { <option id>: { id, artifact } } }, or { error }. It reads no file and no record.
import { artifactRef, foldWith } from '../../where-a-person-stands/do-work/artifact-ref.mjs';
import { stanceRecordId } from '../../where-a-person-stands/do-work/where-a-person-stands.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const { kind, fold, texts } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!Array.isArray(texts) || texts.some(text => typeof text !== 'string')) throw new Error('texts is a list of option ids (text).');
  const folded = foldWith(fold);
  const ids = {};
  for (const text of texts) {
    const artifact = artifactRef({ text }, folded);
    ids[text] = { id: stanceRecordId(kind, artifact), artifact };
  }
  process.stdout.write(`${JSON.stringify({ ids })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
}
