// Move only the wire representation of a completed answer; its durable original remains until accepted finish.
import { HANDOFF_RESULT_SOURCE } from './handoff-result-source.mjs';
import { makeHashCodeHexFromBytes } from '../content-identity/read-data/identity.mjs';
import { bearerControl, namespaceClient } from '../browse-and-upload-my-files/do-work/namespace-client.mjs';
import { loadChunking } from '../browse-and-upload-my-files/do-work/content-chunks.mjs';
import { NamespaceRefused, sendFile } from '../browse-and-upload-my-files/do-work/send-a-file-to-a-namespace.mjs';
export function nativeResultUploader({ origin, key, fetchImpl = fetch }) {
  let client, chunking;
  return async ({ bytes, identity, name }) => {
    client ??= namespaceClient({ origin, fetchImpl, control: bearerControl({ origin, fetchImpl, authorization: async () => `Bearer ${key}` }) });
    chunking ??= await loadChunking();
    return sendFile({ client, chunking, source: { size: bytes.byteLength, readAt: async (offset, length) => bytes.subarray(offset, offset + length) },
      name, mediaType: 'application/json' });
  };
}
export function nativeResultRetirer({ origin, key, fetchImpl = fetch }) {
  let client;
  return async source => {
    client ??= namespaceClient({ origin, fetchImpl, control: bearerControl({ origin, fetchImpl, authorization: async () => `Bearer ${key}` }) });
    if (!/^\/Made by tools\/Native results\/[0-9a-f]{64}\.json$/.test(source.transport_name ?? '')) throw refused('Result transport name is not an owned native alias.');
    const answer = await client.putNames([{ name: source.transport_name, expected_identity: source.identity, retire: true }]);
    if (![...(answer.retired ?? []), ...(answer.repeated ?? [])].includes(source.transport_name)) throw refused('Namespace did not acknowledge transport-name retirement.');
    return answer;
  };
}
export const needsResultSource = row => JSON.stringify(row.finish).length > HANDOFF_RESULT_SOURCE.inline_request_characters;
const refused = message => Object.assign(new Error(message), { status: 422, path: '/handoffs/finish', local_result_transport: true });
export async function prepareNativeResultSource(row, { capability, upload, persist }) {
  if (capability?.schema !== HANDOFF_RESULT_SOURCE.schema || capability.format !== HANDOFF_RESULT_SOURCE.format || capability.retire_names !== true
      || !Number.isSafeInteger(capability.max_bytes) || capability.max_bytes <= 0)
    throw refused('This service does not support complete result-source transport.');
  const bytes = new TextEncoder().encode(JSON.stringify(row.finish.result));
  if (!bytes.byteLength || bytes.byteLength > Math.min(HANDOFF_RESULT_SOURCE.max_bytes, capability.max_bytes))
    throw Object.assign(refused(`The complete native result exceeds the supported ${Math.min(HANDOFF_RESULT_SOURCE.max_bytes, capability.max_bytes)}-byte decode bound; its original answer remains retained.`), { result_transport_reason: 'result_bytes_exceed_capability', result_bytes: bytes.byteLength, supported_max_bytes: Math.min(HANDOFF_RESULT_SOURCE.max_bytes, capability.max_bytes) });
  const identity = makeHashCodeHexFromBytes(bytes);
  const name = `/Made by tools/Native results/${makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify([row.handoff_id, row.generation, identity]))).slice(3)}.json`;
  if (row.result_source?.identity !== identity || row.result_source.byte_length !== bytes.byteLength || row.result_source.format !== capability.format || row.result_source.transport_name !== name) {
    let kept;
    try { kept = await upload({ bytes, identity, name }); }
    catch (error) {
      if (error instanceof NamespaceRefused) throw Object.assign(refused(error.message), { cause: error });
      if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status))
        error.local_result_transport = true;
      throw error;
    }
    if (kept?.identity !== identity) throw refused('The uploaded result identity was not confirmed; the original answer remains retained.');
    row = { ...row, result_source: { identity, byte_length: bytes.byteLength, format: capability.format, transport_name: name } };
    await persist(row); // Save receipt before finish so a lost finish reply never resends the original large envelope.
  }
  const { result, ...finish } = row.finish;
  const { transport_name, ...result_source } = row.result_source;
  return { row, wire: { ...finish, result_source } };
}
