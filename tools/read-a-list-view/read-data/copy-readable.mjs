// tools/read-a-list-view/read-data/copy-readable.mjs
//
// Purpose: whether an agent may read a list's file copy now, read-only. The list is the original and agents read it
// through the person's door; its folder is a copy that only the list-copy sync writes. When every holder of the
// account is unreachable, the copy is the only place the text can be read, so it may be read then, and only then:
// when the list answers "unavailable" (or the door cannot be reached at all), never when it answers with a list.
// A copy guard (a person's hook, a check row) asks this before it refuses a read of a copy.
//
// Non-Negotiable Invariants:
//   1. Readable only on an unavailable answer. Any answer from the list, with or without rows, means the list is the
//      place to read, so the copy is not readable. An answer that is neither (a refusal, a bad request) is not
//      "unavailable" either: the copy stays closed and the answer says why.
//   2. Reading only. Nothing here writes the list or the folder; the answer is advice to the guard.
//   3. Which answers count as unavailable is DATA (list-view.json `copies_when_unreachable`), not code.
//
//   copyReadable({ names, list }, door) → { readable, list, because, code? }
//     names: { list_type, list_record } as list-view.mjs takes them; door: read-data/door.mjs (only read is used)
import data from './list-view.json' with { type: 'json' };

const rule = data.copies_when_unreachable;

/** True when an error is the door or the list answering that it cannot answer now. */
function unavailable(error) {
  if (rule.answers.includes(error?.code)) return true;
  // fetch() fails with a TypeError when nothing listens or the network is down: no holder answered at all.
  return rule.transport_failures === true && error?.code === undefined && error?.name === 'TypeError';
}

export async function copyReadable(input, door) {
  const { names, list } = input ?? {};
  if (typeof list !== 'string' || !list || typeof names?.list_type !== 'string' || typeof names?.list_record !== 'string') {
    throw Object.assign(new Error('copyReadable takes { names: { list_type, list_record }, list }.'), { code: 'bad_input' });
  }
  const id = names.list_record.replace('{list_id}', list);
  try {
    await door.read(names.list_type, id);
  } catch (error) {
    if (unavailable(error)) {
      return { readable: true, list, code: error.code ?? 'unreachable',
        because: 'the list is unavailable now, so its file copy may be read, read-only, until it answers again' };
    }
    return { readable: false, list, code: error.code ?? 'refused',
      because: `the list answered, though not with a list (${String(error.message).slice(0, 200)}); the copy stays closed` };
  }
  return { readable: false, list, because: 'the list answers; read it through the door, not its copy' };
}
