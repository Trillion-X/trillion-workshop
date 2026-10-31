// tools/records-door/read-data/byte-pages.mjs
//
// Purpose: the whole answer of a door call that came back as pages of its own bytes. The door answers within one
// bounded message, so a record (or a list's first row) too big to fit alone is answered as
// { byte_page: { total, blake3, offset, length, base64, next_after_byte } }: the same call with `after_byte` set to
// `next_after_byte` answers the next page, until it is null (trillion-rust src/mcp.rs byte_page, record_value/door.rs).
// The pages' bytes are joined, checked against `total` and the BLAKE3 every page carries, and parsed into the answer
// the call would have had. Pure: no file, network or process access, so a page bundles it as a computer runs it.
//
// Non-Negotiable Invariants:
//   1. Each page must start where the bytes so far end, and every page must name the same total and BLAKE3; a page that
//      does not, or joined bytes whose length or BLAKE3 differ (the value changed between calls), is refused.
//   2. An answer with no byte_page is the whole answer and is returned as it is.
//
//   wholeAnswer(answer, again) → the whole answer, where again(after_byte) → the next page's answer.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const say = (code, words) => Object.assign(new Error(words), { code });

function bytesOf(base64) {
  const text = atob(base64);
  return Uint8Array.from(text, character => character.charCodeAt(0));
}

export async function wholeAnswer(answer, again) {
  let page = answer?.byte_page;
  if (!page) return answer;
  const { total, blake3 } = page;
  const parts = [];
  let joined = 0;
  for (;;) {
    if (page.offset !== joined || page.total !== total || page.blake3 !== blake3) {
      throw say('byte_pages_changed', `The door's byte pages do not follow on (offset ${page.offset} after ${joined} bytes).`);
    }
    const part = bytesOf(page.base64);
    parts.push(part);
    joined += part.length;
    if (page.next_after_byte === null || page.next_after_byte === undefined) break;
    page = (await again(page.next_after_byte))?.byte_page;
    if (!page) throw say('byte_pages_changed', 'The door stopped answering byte pages before the last one.');
  }
  const whole = new Uint8Array(joined);
  parts.reduce((at, part) => { whole.set(part, at); return at + part.length; }, 0);
  if (joined !== total || makeHashCodeHexFromBytes(whole) !== `1f:${blake3}`) {
    throw say('byte_pages_changed', 'The joined byte pages are not the answer the door hashed; the value changed between calls.');
  }
  return JSON.parse(new TextDecoder().decode(whole));
}
