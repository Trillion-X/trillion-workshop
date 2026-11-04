// Read the immediate members of a JSON container from bounded stored chunks.
// Named nested containers are expanded one member at a time; their combined value is never parsed or held.
import { jsonExpansionBytes } from '../../../../json-expansion.mjs';

export function* jsonMembers(chunks, { expand = [], chars = 4_000_000, bytes = 32 * 1024 * 1024, container = null, strictWhitespace = false } = {}) {
  const source = chunks[Symbol.iterator]();
  let chunk = '', at = 0, ended = false;
  const peek = () => {
    while (at >= chunk.length && !ended) {
      const next = source.next();
      ended = next.done;
      chunk = ended ? '' : next.value;
      at = 0;
    }
    return ended ? '' : chunk[at];
  };
  const spaces = () => { while (peek() && (strictWhitespace ? /[ \t\r\n]/ : /\s/).test(peek())) at += 1; };
  const expect = char => { spaces(); if (peek() !== char) throw new Error('Stored JSON has an invalid container.'); at += 1; };
  const valueText = (key = false) => {
    spaces();
    const parts = [];
    let size = 0, depth = 0, quoted = false, escape = false, done = false;
    for (;;) {
      if (!peek()) break;
      const start = at;
      while (at < chunk.length) {
        const char = chunk[at];
        if (!quoted && depth === 0 && (char === ',' || char === ']' || char === '}')) break;
        at += 1;
        if (quoted) {
          if (escape) escape = false;
          else if (char === '\\') escape = true;
          else if (char === '"') { quoted = false; if (key) { done = true; break; } }
        } else if (char === '"') quoted = true;
        else if (char === '[' || char === '{') depth += 1;
        else if (char === ']' || char === '}') depth -= 1;
      }
      const text = chunk.slice(start, at);
      size += text.length;
      if (size > chars) throw Object.assign(new Error('One stored JSON member exceeds the bounded read limit.'), { code: 'record_too_large', status: 413 });
      parts.push(text);
      if (done || at < chunk.length) break;
    }
    const joined = parts.join('');
    const text = strictWhitespace ? joined.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') : joined.trim();
    if (!text || quoted || depth !== 0) throw new Error('Stored JSON has an incomplete value.');
    const sizeOf = bytes === Infinity ? null : jsonExpansionBytes(text, bytes);
    if (sizeOf && sizeOf.bytes > bytes) throw Object.assign(new Error('One stored JSON member exceeds the bounded expansion limit.'), { code: 'record_too_large', status: 413 });
    return { value: JSON.parse(text), chars: text.length };
  };
  function* members(path) {
    spaces();
    const open = peek();
    if (open !== '[' && open !== '{') throw new Error('Stored JSON needs a container.');
    if (!path.length && container === 'array' && open !== '[') throw new Error('Stored JSON needs an array.');
    const close = open === '[' ? ']' : '}';
    at += 1;
    let index = 0;
    spaces();
    while (peek() !== close) {
      let key = index++;
      if (open === '{') { key = valueText(true).value; if (typeof key !== 'string') throw new Error('Stored JSON has an invalid member name.'); expect(':'); }
      const memberPath = [...path, key];
      if (expand.some(named => JSON.stringify(named) === JSON.stringify(memberPath))) yield* members(memberPath);
      else yield { path: memberPath, ...valueText() };
      spaces();
      if (peek() === close) break;
      expect(',');
      spaces();
      if (peek() === close) throw new Error('Stored JSON has a trailing comma.');
    }
    expect(close);
  }
  try { yield* members([]); spaces(); if (peek()) throw new Error('Stored JSON has trailing text.'); }
  finally { source.return?.(); }
}
