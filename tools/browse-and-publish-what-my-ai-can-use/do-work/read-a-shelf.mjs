// tools/browse-and-publish-what-my-ai-can-use/do-work/read-a-shelf.mjs
//
// Rows of one kind as the Marketplace shelf shows them, by shelf-item.mjs shelfItem over ../marketplace-kinds.json:
// each row's title, what it does, who made it in the person's words, its price, runs and facts, whether it is the
// person's own and published, and what can be done with it (use, publish, withdraw).
//
// Input:  { kind: <a kind id in marketplace-kinds.json>, rows: [source row], published?: [id] }
//         published: the ids of that kind this account has published to the shared shelf.
// Answer: { items: [shelf item], kind: { id, one, icon }, kinds: [{ id, one }] }
// Refuses a kind the file does not list (naming the ones it does) and rows that are not a list of objects. It reads,
// publishes and withdraws nothing: the screen's routes do that with what this answers.
import kinds from '../marketplace-kinds.json' with { type: 'json' };
import { shelfItem } from './shelf-item.mjs';

export function readAShelf({ kind: kindId, rows, published = [] } = {}) {
  const kind = kinds.kinds.find(one => one.id === kindId);
  if (!kind) throw new Error(`Give kind: one of ${kinds.kinds.map(one => one.id).join(', ')}.`);
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Give rows: a list of the source rows of that kind, each an object.');
  if (!Array.isArray(published)) throw new Error('published is a list of the ids this account published.');
  return {
    items: rows.map(row => shelfItem(kind, row, new Set(published.map(String)))),
    kind: { id: kind.id, one: kind.one, icon: kind.icon },
    kinds: kinds.kinds.map(one => ({ id: one.id, one: one.one })),
  };
}
