// tools/read-a-list-view/read-data/copy-readable.mjs
//
// Purpose: whether an agent may read a list's file copy now, read-only. The list is the original and agents read it
// from the person's store; its folder is a copy that only the list-copy sync writes. When every holder of the account is
// unreachable, the copy is the only place the text can be read, so it may be read then, and only then: when the caller's
// reading of the list says it could not be reached, never when the list answered. A copy guard (a person's hook, a check
// row) asks this before it refuses a read of a copy, and hands in its reading of the list.
//
// Non-Negotiable Invariants:
//   1. Readable only on an unavailable reading. Any answer from the list, with or without rows, means the list is the
//      place to read, so the copy is not readable. A reading that is neither (a refusal, a bad request) is not
//      "unavailable" either: the copy stays closed and the answer says why.
//   2. A guard that hands in no reading of the list is refused, never read as unavailable: the copy stays closed.
//   3. Reading only. Nothing here writes the list or the folder; the answer is advice to the guard.
//   4. Which codes count as unavailable is DATA (list-view.json `copies_when_unreachable`), not code.
//
//   copyReadable({ names, list, reading }) → { readable, list, because, code? }
//     names: { list_type, list_record } as list-view.mjs takes them
//     reading: { answered: true } | { unreachable: true } | { code: "<the list's refusal code>" }, the caller's reading of
//     the list in its store
import data from './list-view.json' with { type: 'json' };

const rule = data.copies_when_unreachable;

export function copyReadable(input) {
  const { names, list, reading } = input ?? {};
  if (typeof list !== 'string' || !list || typeof names?.list_type !== 'string' || typeof names?.list_record !== 'string') {
    throw Object.assign(new Error('copyReadable takes { names: { list_type, list_record }, list, reading }.'), { code: 'bad_input' });
  }
  if (!reading || typeof reading !== 'object' || Array.isArray(reading)) {
    return { readable: false, list, code: 'not_checked', because: 'the caller gave no reading of the list; the copy stays closed' };
  }
  if (reading.answered === true) return { readable: false, list, because: 'the list answers; read it from the store, not its copy' };
  if (reading.unreachable === true) {
    if (rule.transport_failures === true) {
      return { readable: true, list, code: 'unreachable',
        because: 'the list cannot be reached, so its file copy may be read, read-only, until it answers again' };
    }
    return { readable: false, list, code: 'unreachable', because: 'the list cannot be reached, and this list does not read its copy then' };
  }
  const code = reading.code;
  if (typeof code === 'string' && rule.answers.includes(code)) {
    return { readable: true, list, code, because: 'the list is unavailable now, so its file copy may be read, read-only, until it answers again' };
  }
  return { readable: false, list, code: typeof code === 'string' && code ? code : 'refused',
    because: `the list answered, though not with a list (${typeof code === 'string' ? code : 'no code'}); the copy stays closed` };
}
