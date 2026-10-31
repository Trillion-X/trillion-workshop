// tools/pull-from-connected-accounts/read-data/sources.mjs
//
// The source descriptions in read-data/sources/: one JSON file per service, holding the facts about that service's
// public interface (where it is, how a token is presented, how a list is paged, which field is an item's identity).
// A description may extend another: it takes every top-level key of the one it names and replaces the keys it sets.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const folder = join(import.meta.dirname, 'sources');
const LAYOUTS = new Set(['threads', 'items']);

/** The ids of every description shipped here. */
export const sourceIds = () => readdirSync(folder).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).sort();

/** What is wrong with a description, as plain sentences; an empty list means it can be pulled. */
export function problemsWith(source) {
  const problems = [];
  const need = (ok, words) => { if (!ok) problems.push(words); };
  need(typeof source.id === 'string' && source.id, 'it has no id');
  need(typeof source.base === 'string' && source.base.startsWith('https://'), 'its base is not an https address');
  need(typeof source.identity?.path === 'string' && source.identity.self_id !== undefined, 'it does not say how to learn who the token belongs to (identity.path and identity.self_id)');
  need(Array.isArray(source.walks) && source.walks.length > 0, 'it has no walk');
  for (const walk of source.walks ?? []) {
    need(typeof walk.name === 'string' && Array.isArray(walk.levels) && walk.levels.length > 0, 'a walk needs a name and at least one level');
    need(LAYOUTS.has(walk.fold?.layout), `walk ${walk.name}: fold.layout is threads or items`);
    need(Array.isArray(walk.fold?.key) && walk.fold.key.length > 0, `walk ${walk.name}: fold.key names at least one pointer`);
    if (walk.fold?.layout === 'threads') need(walk.fold.thread?.id !== undefined, `walk ${walk.name}: a threads fold needs thread.id`);
    if (walk.fold?.layout === 'items') need(typeof walk.fold.into === 'string', `walk ${walk.name}: an items fold needs into`);
    for (const level of walk.levels ?? []) need(typeof level.path === 'string', `walk ${walk.name}: every level needs a path`);
  }
  if (source.auth?.in === 'path') need(typeof source.auth.template === 'string' && source.auth.template.includes('{token}'), 'a path token needs a template with {token}');
  if (source.auth?.in === 'header') need(typeof source.auth.name === 'string', 'a header token needs the header name');
  return problems;
}

/** One description by id, with `extends` resolved. Throws with the problems when it cannot be pulled. */
export function loadSource(id) {
  if (!/^[a-z0-9-]+$/.test(String(id))) throw new Error(`There is no source called ${JSON.stringify(id)}; the sources are ${sourceIds().join(', ')}.`);
  let raw;
  try { raw = JSON.parse(readFileSync(join(folder, `${id}.json`), 'utf8')); } catch { throw new Error(`There is no source called ${id}; the sources are ${sourceIds().join(', ')}.`); }
  const { extends: parent, ...own } = raw;
  const source = parent ? { ...loadSource(parent), ...own } : own;
  const problems = problemsWith(source);
  if (problems.length) throw new Error(`Source ${id} cannot be pulled: ${problems.join('; ')}.`);
  return source;
}
