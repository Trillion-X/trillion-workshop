// tools/know-who-is-in-this/do-work/where-someone-appeared.mjs
//
// `tool:where-someone-appeared`, run as a function: every recording and time where a person was heard or seen, or every
// person kept for a recording, read from the person's appearances list through their records door. A read only.
//
//   whereSomeoneAppeared(input, { door }) -> { appearances, people, recordings }
//   input: { person?, recording?, how?, words?, include_superseded? }, at least one of person, recording or words.
//   `words` are asked of the person's own search over this list, so a name, a place or a spoken word finds its rows.
import { ROW_PREFIX, ROW_TYPE, STATUS } from '../read-data/appearances.mjs';

const refuse = words => { throw Object.assign(new Error(words), { code: 'bad_input' }); };

export async function whereSomeoneAppeared(input = {}, { door } = {}) {
  const { person, recording, how, words, include_superseded: all = false } = input ?? {};
  if (!person && !recording && !words) refuse('Give a person, a recording or words to look for.');
  const rows = new Map();
  if (words) {
    const answer = await door.search({ question: words, type: ROW_TYPE });
    for (const hit of answer.results ?? []) {
      const id = hit.address?.input?.id ?? hit.record;
      if (typeof id === 'string' && id.startsWith(ROW_PREFIX)) rows.set(id, null);
    }
    for (const id of rows.keys()) rows.set(id, await door.read(ROW_TYPE, id));
  } else {
    const where = { ...(person ? { person } : {}), ...(recording ? { recording } : {}), ...(how ? { how } : {}) };
    for await (const record of door.list({ type: ROW_TYPE, where })) if (record.id.startsWith(ROW_PREFIX)) rows.set(record.id, record.value);
  }
  const appearances = [...rows]
    .filter(([, value]) => value && (all || value.status !== STATUS.superseded))
    .filter(([, value]) => (!person || value.person === person) && (!recording || value.recording === recording) && (!how || value.how === how))
    .map(([id, value]) => ({ id: id.slice(ROW_PREFIX.length), ...value }))
    .sort((a, b) => String(a.recording_name).localeCompare(String(b.recording_name)) || a.start - b.start);
  const tally = (key, label) => {
    const seen = new Map();
    for (const row of appearances) if (row[key]) seen.set(row[key], { id: row[key], label: row[label] ?? row[key], appearances: (seen.get(row[key])?.appearances ?? 0) + 1 });
    return [...seen.values()];
  };
  return { appearances, people: tally('person', 'subject'), recordings: tally('recording', 'recording_name') };
}
