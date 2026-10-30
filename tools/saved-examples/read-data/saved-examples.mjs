// tools/saved-examples/read-data/saved-examples.mjs
//
// Saved examples: posts, videos and pages other people made that worked, each kept with where it came from, its words,
// its pictures and why it worked, so a person and any AI can make their own work in a shape that is already proven.
// Each example is one record of the shared kind `saved-example` in the person's own records, read and written through
// the run's records door (tools/records-door):
//
//   { id: "example:<32 hex>", type: "saved-example",
//     value: { id, url, host, site, title, words, pictures: [url], why_it_worked, collection, added_from, added_at, updated_at } }
//
// Removing an example removes its record (value null); the records keep its history.
export const KIND = 'saved-example';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function current(door) {
  const examples = [];
  for await (const record of door.list({ type: KIND })) if (object(record.value) && typeof record.value.id === 'string') examples.push(record.value);
  return examples;
}

/** tool:list-saved-examples: every example, newest first, and how many. */
export async function listSavedExamples(_input, { door }) {
  const examples = (await current(door)).sort((a, b) => String(b.added_at).localeCompare(String(a.added_at)));
  return { examples, count: examples.length };
}

/** tool:remove-a-saved-example: removes one example by its id from the list. */
export async function removeASavedExample(input, { door }) {
  const id = object(input) && typeof input.id === 'string' ? input.id : '';
  const kept = id ? await door.read(KIND, id) : null;
  if (!object(kept)) throw new Error(`There is no saved example ${id || 'with no id'}. Read the list for the ids.`);
  // The same example, removed again from the same state, is the same write.
  await door.write([{ id, type: KIND, value: null }], { key: `saved-example:remove:${id}:${kept.updated_at ?? kept.added_at}` });
  return { id, removed: true };
}
