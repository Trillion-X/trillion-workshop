import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const idFor = input => `block:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([input.source_id, input.start ?? null, input.end ?? null, input.title, input.parent_id ?? null])))).slice(0, 24)}`;

export function recordBlock(eeaf, input = {}, { resolveReference = id => eeaf.read(id) } = {}) {
  const source_id = text(input.source_id), title = text(input.title);
  if (!source_id || !title) throw new Error('source_id and title are required.');
  const source = resolveReference(source_id);
  if (!source) throw new Error('The source record was not found.');
  if ((input.start === undefined) !== (input.end === undefined)) throw new Error('Choose both the start and end of the source words.');
  if (input.start !== undefined) {
    if (!Number.isSafeInteger(input.start) || input.start < 0 || !Number.isSafeInteger(input.end) || input.end <= input.start) throw new Error('Choose a valid source word range.');
    if (typeof source.text !== 'string' || input.end > source.text.length || !source.text.slice(input.start, input.end).trim()) throw new Error('Those words are not in the source record.');
  }
  const sources = input.sources ?? [];
  if (!Array.isArray(sources) || !sources.every(link => {
    if (!link || !text(link.source_id)) return false;
    const record = resolveReference(link.source_id);
    if (!record) return false;
    if ((link.start === undefined) !== (link.end === undefined)) return false;
    return link.start === undefined || (Number.isSafeInteger(link.start) && Number.isSafeInteger(link.end)
      && link.start >= 0 && link.end > link.start && typeof record.text === 'string'
      && link.end <= record.text.length && Boolean(record.text.slice(link.start, link.end).trim()));
  })) throw new Error('Every extra source must exist, with an exact word range when one is given.');
  const parent_id = text(input.parent_id);
  if (parent_id) {
    const parent = eeaf.read(parent_id);
    if (!parent || (parent.source_id !== source_id && !(parent.sources ?? []).some(link => link.source_id === source_id))) throw new Error('The parent block must belong to this source.');
  }
  const proof = input.proof ?? [];
  if (!Array.isArray(proof) || !proof.every(item => item && typeof item === 'object' && text(item.kind) && text(item.id) && resolveReference(item.id))) throw new Error('Every proof link must name an existing record.');
  const id = idFor(input);
  if (input.id !== undefined && input.id !== id) throw new Error('The block ID does not match its source and title.');
  const existing = eeaf.read(id);
  const state = text(input.state) ?? existing?.state ?? 'open';
  if (!['open', 'in_progress', 'blocked', 'done'].includes(state)) throw new Error('Choose a valid block state.');
  const progress = input.progress;
  if (progress !== undefined && (!Number.isInteger(progress) || progress < 0 || progress > 100)) throw new Error('Progress must be a whole percentage from 0 to 100.');
  const nextProgress = progress ?? existing?.progress;
  if ((state === 'done' || nextProgress === 100) && !(proof.length || existing?.proof?.length)) throw new Error('A completed block needs a linked result.');
  if (state === 'done' && nextProgress !== undefined && nextProgress !== 100) throw new Error('A completed block must show 100% progress.');
  if (state !== 'done' && nextProgress === 100) throw new Error('A block at 100% must be marked done.');
  if (existing) {
    const updated = { ...existing, ...(input.state === undefined ? {} : { state }), ...(progress === undefined ? {} : { progress }), ...(proof.length ? { proof: [...new Map([...(existing.proof ?? []), ...proof].map(item => [`${item.kind}:${item.id}`, item])).values()] } : {}), ...(sources.length ? { sources: [...new Map([...(existing.sources ?? []), ...sources].map(link => [`${link.source_id}:${link.start ?? ''}:${link.end ?? ''}`, link])).values()] } : {}) };
    if (updated.state === 'done' && !updated.proof?.length) throw new Error('A completed block needs a linked result.');
    if (JSON.stringify(updated) === JSON.stringify(existing)) return { block: { id, ...existing }, repeated: true };
    updated.updated_at = new Date().toISOString();
    eeaf.write([{ id, type: 'block', value: updated }], { actor: { by: 'person' } });
    return { block: { id, ...updated }, repeated: false };
  }
  const value = { source_id, title, state, ...(progress === undefined ? {} : { progress }), ...(input.start === undefined ? {} : { start: input.start, end: input.end }), ...(sources.length ? { sources } : {}), ...(parent_id ? { parent_id } : {}), ...(proof.length ? { proof } : {}), ...(Array.isArray(input.contributors) ? { contributors: input.contributors } : {}), ...(Array.isArray(input.about) ? { about: input.about } : {}), at: new Date().toISOString() };
  eeaf.write([{ id, type: 'block', value }], { actor: { by: 'person' } });
  return { block: { id, ...value }, repeated: false };
}

export function readBlocks(eeaf) {
  return eeaf.ids('block', { limit: 1000 }).map(id => { const value = eeaf.read(id); return value ? { id, ...value } : null; }).filter(Boolean);
}
