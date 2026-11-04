// A shared file's stable reference can be kept in a namespace-file input.
// Execution opens it through its current Space/item grant and uses the existing
// staging placement; no transferable lease belongs in a durable task input.
import { sharedReference } from '../parts/live-namespace/do-work/shared-file-reference.mjs';
import { inputPlacement, NAMESPACE_IDENTITY } from './repo-explorer.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = new Set(['identity', 'space_id', 'item_id']);
const fail = message => Object.assign(new Error(message), { status: 400 });

export function sharedNamespaceFileInput(value) {
  if (!object(value) || !Object.hasOwn(value, 'identity')
    || !Object.hasOwn(value, 'space_id') && !Object.hasOwn(value, 'item_id')) return null;
  const reference = sharedReference(value);
  if (!NAMESPACE_IDENTITY.test(value.identity ?? '') || Object.keys(value).some(key => !fields.has(key)))
    throw fail('A shared file input needs only its exact identity, space_id and item_id.');
  return { identity: value.identity, ...reference };
}

export function sharedNamespaceFileSource(identity, reference) {
  const selected = sharedReference(reference);
  if (!selected) throw fail('Name the shared file by its exact Space and item.');
  return sharedNamespaceFileInput({ identity, ...selected });
}

export async function placeSharedNamespaceFileInput(value, files, placements) {
  const source = sharedNamespaceFileInput(value);
  if (!source) return null;
  if (typeof files?.openShared !== 'function')
    throw Object.assign(new Error('This execution owner has no admitted shared file supply.'), { status: 503 });
  const opened = await files.openShared(source);
  if (opened?.identity !== source.identity || !Number.isSafeInteger(opened.byte_length) || opened.byte_length < 0
    || typeof opened.stream !== 'function') throw fail('The current shared source did not confirm this exact file.');
  const placement = inputPlacement(source.identity, opened);
  if (!placements.some(row => row.path === placement.path)) placements.push(placement);
  return placement.path;
}
