// Immutable result transport only: the handoff keeps the parsed original result, never this descriptor.
import rules from './handoff-result-source.json' with { type: 'json' };
import { createByteIdentity } from '../browse-and-upload-my-files/do-work/byte-identity.mjs';
import { keepContentJson } from '../serialized-content/do-work/content-json.mjs';
export const HANDOFF_RESULT_SOURCE = rules;
// Prepare the stored representation before JSON.parse expands a large source into a graph. The weak association lets
// the finish owner persist the exact serialization and prepared payload without compressing it while that graph is live.
const serializedResults = new WeakMap();
const preparedResultContents = new WeakMap();
export const SOURCE_RESULT_JSON = Symbol('source-result-json');
export const SOURCE_RESULT_CONTENT = Symbol('source-result-content');
export const serializedResultFor = result => result && typeof result === 'object' ? serializedResults.get(result) ?? null : null;
export const preparedResultContentFor = result => result && typeof result === 'object' ? preparedResultContents.get(result) ?? null : null;
export const resultSourceCapability = () => ({ schema: rules.schema, format: rules.format, max_bytes: rules.max_bytes, retire_names: true });
export function checkedResultSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)
      || source.format !== rules.format || !/^1f:[0-9a-f]{64}$/.test(source.identity ?? '')
      || !Number.isSafeInteger(source.byte_length) || source.byte_length <= 0 || source.byte_length > rules.max_bytes)
    throw new Error(`result_source needs an immutable file identity, ${rules.format}, and byte_length from 1 to ${rules.max_bytes}.`);
  return source;
}
export async function readHandoffResultSource(source, { privateReach, admit, open, beforeDecode = null }) {
  if (!privateReach) throw Object.assign(new Error('This sign-in cannot read private result files.'), { status: 403 });
  checkedResultSource(source);
  // Admission checks holder, fence and pending effects without publishing a finish before bytes are read.
  admit();
  const file = await open(source.identity);
  if (file.byte_length !== source.byte_length) throw new Error('Result source length does not match the committed file.');
  const digest = await createByteIdentity();
  let reader = null;
  // Keep one bounded byte buffer; decoded chunk ropes needlessly overlap the parsed result and correction history.
  let content = null, bytes = 0, ended = false;
  try {
    reader = file.stream().getReader();
    content = new Uint8Array(source.byte_length);
    for (;;) {
      const part = await reader.read();
      if (part.done) { ended = true; break; }
      const next = bytes + part.value.byteLength;
      if (next > source.byte_length || next > rules.max_bytes) throw new Error('Result source exceeded its declared bound.');
      digest.update(part.value); content.set(part.value, bytes); bytes = next;
    }
    if (bytes !== source.byte_length) throw new Error('Result source ended before its declared length.');
    if (`1f:${digest.hex()}` !== source.identity) throw new Error('Result source bytes do not match their immutable identity.');
    let json = new TextDecoder('utf-8', { fatal: true }).decode(content);
    content = null;
    // A representation-only recovery can release old inline history before parsing the new result graph.
    beforeDecode?.();
    const serialized = json;
    const preparedContent = keepContentJson(serialized);
    const result = JSON.parse(json);
    json = null;
    if (result === null || (typeof result === 'string' && !result.trim())) throw new Error('Result source must contain the original nonempty result.');
    if (result && typeof result === 'object') {
      // When compression produced a distinct representation, retaining the source JSON here duplicates its full
      // backing string beside both the decoded result and the prepared payload. The payload already preserves the
      // exact serialization; keep the raw association only when it is itself the payload.
      if (preparedContent.json_encoding === undefined) serializedResults.set(result, serialized);
      preparedResultContents.set(result, preparedContent);
    }
    return result;
  } finally {
    try {
      if (reader) {
        if (!ended) void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } finally { digest.free(); }
  }
}

// Reuse the same plan/read admission as the authenticated Namespace HTTP byte route.
export async function checkAuthorizedHandoffResultSource(identity, { access, origin }) {
  const checked = await access(identity, `/mcp/api/namespace/bytes/${encodeURIComponent(identity)}`, origin, 'GET');
  if (checked.withheld) throw Object.assign(new Error(checked.withheld.error ?? 'This plan does not include reading result files.'),
    { status: 402, result_source_refusal: true, withheld: checked.withheld });
  return checked;
}
export async function openAuthorizedHandoffResultSource(identity, { access, open, origin }) {
  await checkAuthorizedHandoffResultSource(identity, { access, origin });
  return open(identity);
}
