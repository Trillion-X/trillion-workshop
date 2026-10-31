// Optional document content in the same rows as their metadata. The original document row keeps its id; text larger
// than one bounded piece is continued in stable linked child rows. Joining every numbered piece reconstructs the
// exact UTF-8 bytes, including frontmatter. A cursor pins an unfinished document's identity so pieces of two edits
// can never be combined. No document kind or corpus is named here.
import data from './document-properties.json' with { type: 'json' };
import { say } from './document-properties.mjs';
import { splitDocuments } from './split.mjs';

const CURSOR = 'document-content:';
const encoder = new TextEncoder();
// A BOM is an original source character, including when a text piece happens to begin at one in the middle of a
// document. The decoder must retain it so joining bounded text pieces preserves every original UTF-8 byte.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const cursorText = value => CURSOR + Buffer.from(JSON.stringify(value)).toString('base64url');

function cursorOf(after) {
  if (!after || !String(after).startsWith(CURSOR)) return { after: after ?? null };
  try {
    const value = JSON.parse(Buffer.from(after.slice(CURSOR.length), 'base64url').toString('utf8'));
    if (!object(value) || typeof value.document !== 'string' || !Number.isSafeInteger(value.part) || value.part < 1 || typeof value.identity !== 'string') throw Error();
    return value;
  } catch { throw say('bad_input', { what: 'The document content cursor is not valid.' }); }
}

function optionsOf(content) {
  if (content !== true && !object(content)) throw say('bad_input', { what: 'content is true or a document-content options object.' });
  const allowed = new Set(Object.keys(data.content));
  if (object(content) && Object.keys(content).some(key => !allowed.has(key))) throw say('bad_input', { what: 'content names only its text/link/part fields and part_bytes.' });
  const options = { ...data.content, ...(content === true ? {} : content) };
  if (!Array.isArray(options.omit_fields) || options.omit_fields.some(field => typeof field !== 'string' || !data.content_omittable_fields.includes(field)) || options.omit_fields.includes(options.field)) {
    throw say('bad_input', { what: 'content.omit_fields names only declared derived file caches; source/frontmatter fields and the content text field cannot be omitted.' });
  }
  if (!Number.isSafeInteger(options.part_bytes) || options.part_bytes < 4 || options.part_bytes > data.limits.bytes_per_document) {
    throw say('bad_input', { what: `content.part_bytes is 4 to ${data.limits.bytes_per_document} bytes.` });
  }
  const fields = ['field', 'parent_field', 'index_field', 'count_field', 'complete_field', 'source_field', 'section_field', 'offset_field'];
  if (fields.some(key => typeof options[key] !== 'string' || !options[key]) || new Set(fields.map(key => options[key])).size !== fields.length) {
    throw say('bad_input', { what: 'The document-content field names must be different non-empty texts.' });
  }
  return options;
}

const metadataOf = (row, options) => Object.fromEntries(Object.entries(row.values).filter(([field]) => !options.omit_fields.includes(field)));

// A nominal byte boundary moves forward to the next UTF-8 leading byte. Adjacent pieces use this same boundary,
// so a multi-byte character appears once, without replacement characters or lost bytes.
const boundary = (bytes, at) => {
  while (at < bytes.length && (bytes[at] & 0xc0) === 0x80) at += 1;
  return at;
};

async function pieceOf(files, row, part, options, span = null) {
  const total = span ? span.after_byte - span.from_byte : Number(row.values['file.size']);
  if (!Number.isSafeInteger(total) || total < 0) throw say('bad_input', { what: `${row.id} has no complete byte length.` });
  const count = Math.max(1, Math.ceil(total / options.part_bytes));
  if (part >= count) return { count, row: null };
  const nominal = part * options.part_bytes;
  const from = Math.max(0, nominal - 3);
  const until = Math.min(total, nominal + options.part_bytes + 3);
  const read = span ? { identity: row.identity, bytes: span.bytes.subarray(from, until) }
    : await files.readSlice(row.identity, from, until - from, row.id);
  if (read.identity !== row.identity) throw say('document_changed', { document: row.id, expected: row.identity, current: read.identity });
  const bytes = read.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.length !== until - from) throw say('bad_input', { what: `${row.id} did not answer its complete requested byte range.` });
  const start = boundary(bytes, nominal - from);
  const end = boundary(bytes, Math.min(bytes.length, nominal + options.part_bytes - from));
  let text;
  try { text = decoder.decode(bytes.subarray(start, end)); }
  catch { throw say('bad_input', { what: `${row.id} is not a complete UTF-8 document.` }); }
  const id = part === 0 ? row.id : `${row.id}#text-part-${String(part + 1).padStart(8, '0')}`;
  return { count, row: { ...row, id, title: part === 0 ? row.title : `${row.title} (part ${part + 1} of ${count})`, values: { ...metadataOf(row, options),
    [options.field]: text, [options.parent_field]: row.id,
    [options.index_field]: part + 1, [options.count_field]: count,
    [options.complete_field]: count === 1 ? 'complete' : 'part of document',
    [options.offset_field]: (span?.from_byte ?? 0) + from + start,
  } } };
}

async function* rowsOfParent(files, parent, options, firstPart = 0) {
  if (!options.sections) {
    // A body cursor already names its next byte piece. Start there instead of reading and discarding every earlier
    // piece again on each cursor page of a long document. Section cursors still follow the parser's emitted rows.
    for (let part = firstPart; ; part += 1) {
      const piece = await pieceOf(files, parent, part, options);
      if (!piece.row) return;
      yield piece.row;
    }
  }
  const length = Number(parent.values['file.size']);
  const read = await files.readSlice(parent.identity, 0, length, parent.id);
  if (read.identity !== parent.identity || read.bytes.length !== length) throw say('document_changed', { document: parent.id, expected: parent.identity, current: read.identity });
  let text;
  try { text = decoder.decode(read.bytes); }
  catch { throw say('bad_input', { what: `${parent.id} is not a complete UTF-8 document.` }); }
  const sourceName = options.sections.sources?.[0]?.name ?? 'document';
  const split = await splitDocuments({ ...options.sections, sources: [{ name: sourceName, file: parent.id }], raw_segments: true }, async () => text);
  yield { ...parent, values: { ...metadataOf(parent, options),
    [options.field]: '', [options.parent_field]: parent.id, [options.source_field]: parent.id,
    [options.index_field]: 0, [options.count_field]: 0, [options.offset_field]: 0,
    [options.complete_field]: 'sectioned document; text is in linked rows',
  } };
  const occurrences = new Map();
  for (const span of split.segments) {
    const semantic = span.id === null ? `remainder-${span.from_byte}` : `section-${encodeURIComponent(span.id)}`;
    const seen = (occurrences.get(semantic) ?? 0) + 1; occurrences.set(semantic, seen);
    const id = `${parent.id}#${semantic}${seen > 1 ? `-occurrence-${String(seen).padStart(8, '0')}` : ''}`;
    const row = { ...parent, id, title: span.fields.title ?? (span.id === null ? `${parent.title}: source remainder` : span.id),
      values: { ...parent.values, [options.source_field]: parent.id, [options.section_field]: span.id ?? 'remainder' } };
    const bytes = encoder.encode(span.text);
    for (let part = 0; ; part += 1) {
      const piece = await pieceOf(files, row, part, options, { ...span, bytes });
      if (!piece.row) break;
      yield piece.row;
    }
  }
}

/** One bounded page of content-bearing document rows. `read` is the existing metadata/source reader. */
export async function contentRows(files, read, { folder, match, exclude, paths, paths_file, text_extensions, after, limit, backlinks, most_bytes, content }) {
  if (typeof files.readSlice !== 'function') throw say('bad_input', { what: 'This files owner does not support bounded document-content reads.' });
  const options = optionsOf(content), cursor = cursorOf(after);
  if (!(Number.isSafeInteger(limit) && limit >= 1 && limit <= data.limits.page_rows_most)) throw say('bad_page', { most: data.limits.page_rows_most });
  if (most_bytes !== undefined && (!Number.isSafeInteger(most_bytes) || most_bytes < 1)) throw say('bad_input', { what: 'most_bytes must be a whole number of bytes from 1.' });
  const source = { of: folder, match, exclude, paths, paths_file, text_extensions };
  const continued = cursor.document ? (await read({ source, row_ids: [cursor.document], limit, backlinks })).rows : [];
  if (cursor.document && (!continued.length || continued[0].identity !== cursor.identity)) {
    throw say('document_changed', { document: cursor.document, expected: cursor.identity, current: continued[0]?.identity ?? 'missing' });
  }
  const page = await read({ source, cursor: cursor.document ?? cursor.after, limit, backlinks });
  const parents = [...continued, ...page.rows];
  const rows = [];
  let next = after ?? null;
  for (const parent of parents) {
    const firstPart = parent.id === cursor.document ? cursor.part : 0;
    const start = options.sections ? 0 : firstPart;
    const pieces = rowsOfParent(files, parent, options, start)[Symbol.asyncIterator]();
    let piece = await pieces.next();
    for (let part = start; !piece.done; part += 1) {
      const row = piece.value;
      piece = await pieces.next();
      if (part < firstPart) continue;
      const moreParts = !piece.done;
      const following = moreParts ? cursorText({ document: parent.id, identity: parent.identity, part: part + 1 }) : parent.id;
      const candidate = { rows: [...rows, row], next: following };
      if (most_bytes !== undefined && encoder.encode(JSON.stringify(candidate)).length > most_bytes) {
        if (!rows.length) throw say('bad_input', { what: `the first document content piece is bigger than most_bytes (${most_bytes}); use a smaller content.part_bytes.` });
        return { rows, next };
      }
      rows.push(row); next = following;
      if (rows.length === limit) {
        const moreParents = parent !== parents.at(-1) || page.next_cursor;
        return { rows, next: moreParts || moreParents ? next : null };
      }
    }
  }
  return { rows, next: page.next_cursor ? next : null };
}
