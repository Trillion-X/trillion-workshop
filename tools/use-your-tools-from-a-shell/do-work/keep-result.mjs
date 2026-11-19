// tools/use-your-tools-from-a-shell/do-work/keep-result.mjs
//
// Purpose
//   One road for every result an AI gives a task, of any size: a result is a row (the task row's `result`), and where its
//   bytes physically sit is the store's business, never the AI's choice (the person's standing rule that
//   every output is a row of the task that made it). A result that fits the door's own limit for the field goes on the task row as it
//   is. A larger one is kept as one file of the person's files under a name derived here from the task's id, and the task
//   row's result says which file (a line a program can read back: command.json keep.pointer / keep.pointer_pattern).
//   `{cli} work ID --result` reads either form whole through one call.
//
// Non-negotiable invariants
//   1. The inline limit is read from the door at run time: the `maxLength` of the `result` input of the Workshop tool that
//      finishes tasks (tools:list {tool}). Nothing here types a number; a door that states none refuses.
//   2. The file's name is {keep.folder}/<task id>/result, never given by the caller. Its upload token is the BLAKE3 of the
//      task id and the content, so a retried keep resumes the same upload and the same bytes are kept once.
//   3. The task is finished only after the kept file reads back with the identity and size of the bytes sent.
//   4. A read-back checks every page against the identity the file was kept under, and answers nothing when it differs.
import { makeHashCodeHexFromBytes } from './packs/read-data/identity.mjs';

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => (values[name] === undefined ? whole : String(values[name])));

export class KeepRefused extends Error {}

/** The most characters the door takes inline for a task's result, from the finishing tool's own schema. */
export async function inlineLimit(client, rules) {
  const tool = await client.op(rules.engine.tools, rules.engine.tools_list, { tool: rules.tasks.tools.finish }, { idempotent: true });
  const limit = tool?.input_schema?.properties?.result?.maxLength;
  if (!Number.isInteger(limit) || limit < 1) throw new KeepRefused(fill(rules.keep.words.no_limit, { tool: rules.tasks.tools.finish }));
  return limit;
}

const nameFor = (id, rules) => `${rules.keep.folder}/${id.replace(/[^A-Za-z0-9._-]+/g, '-')}/result`;

/** The text to record as task `id`'s result for `bytes`: the text itself when it fits the door's limit, else the line that
 *  names the file the bytes were kept in. */
export async function keepResult(client, id, bytes, rules) {
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(bytes) && text.length <= await inlineLimit(client, rules)) return text;
  const identity = makeHashCodeHexFromBytes(bytes);
  const name = nameFor(id, rules);
  const upload_id = makeHashCodeHexFromBytes(Buffer.from(`${rules.keep.token_prefix}\0${id}\0${identity}`)).slice('1f:'.length, '1f:'.length + 32);
  const media_type = Buffer.from(text, 'utf8').equals(bytes) ? rules.keep.text_type : rules.keep.binary_type;
  const files = rules.engine.files;
  const started = await client.op(files, 'write_file_start', { upload_id, name, byte_length: bytes.length, media_type });
  if (started?.state === 'open') {
    for (let offset = 0; offset < bytes.length; offset += rules.keep.piece_bytes) {
      await client.op(files, 'write_file_piece', { upload_id, name, offset, content_base64: bytes.subarray(offset, offset + rules.keep.piece_bytes).toString('base64') });
    }
    await client.op(files, 'write_file_finish', { upload_id, name });
  } else if (started?.state !== 'finished') {
    throw new KeepRefused(fill(rules.keep.words.not_started, { name, state: started?.state ?? 'unknown' }));
  }
  const found = await client.op(files, 'find_file', { name_or_identity: name }, { idempotent: true });
  if (found?.identity !== identity || found?.byte_length !== bytes.length) throw new KeepRefused(fill(rules.keep.words.mismatch, { name }));
  return fill(rules.keep.pointer, { name, bytes: bytes.length, identity, id });
}

/** The whole result of a task as bytes: the file a pointer names (every page checked against the identity the pointer
 *  carries), or the text itself. */
export async function readResult(client, result, rules) {
  const pointer = new RegExp(rules.keep.pointer_pattern, 'm').exec(result);
  if (!pointer) return Buffer.from(result, 'utf8');
  const [, name, size, identity] = pointer;
  const parts = [];
  let offset = 0;
  while (offset < Number(size)) {
    const page = await client.op(rules.engine.files, 'read_file', { name_or_identity: name, offset, length: rules.keep.read_bytes, encoding: 'base64' }, { idempotent: true });
    const bytes = Buffer.from(typeof page?.content === 'string' ? page.content : '', 'base64');
    if (page?.identity !== identity || !bytes.length || bytes.length !== page.bytes_returned) throw new KeepRefused(fill(rules.keep.words.read_broken, { name, offset }));
    parts.push(bytes);
    offset += bytes.length;
  }
  const whole = Buffer.concat(parts);
  if (whole.length !== Number(size) || makeHashCodeHexFromBytes(whole) !== identity) throw new KeepRefused(fill(rules.keep.words.read_broken, { name, offset }));
  return whole;
}
