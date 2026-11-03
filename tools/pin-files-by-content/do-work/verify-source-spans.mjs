#!/usr/bin/env node
// tools/pin-files-by-content/do-work/verify-source-spans.mjs
//
// Literal evidence only: checking bindings, and locating the literal pieces of a text in a source (literalPieces).
// This cannot authenticate a speaker or judge meaning.
import {readFileSync, writeFileSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {makeHashCodeHexFromBytes} from '../../content-identity/read-data/identity.mjs';

// The BLAKE3 of each byte buffer, in order, as the bare hex b3sum prints, from the one content-identity owner.
export function hashBuffers(buffers) {
  if (!Array.isArray(buffers) || buffers.some(bytes => !Buffer.isBuffer(bytes))) throw new TypeError('BLAKE3 inputs must be byte buffers');
  return buffers.map(bytes => makeHashCodeHexFromBytes(bytes).split(':')[1]);
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const hash = bytes => hashBuffers([bytes])[0];

export function verifySourceSpans(data) {
  const failures = [];
  const invalid = kind => ({schema: 'source-span-readback-v1', status: 'invalid', passed: false,
    sources: [], quotes: [], failures: [{kind}], scope: 'Literal byte evidence only; no speaker, factual, meaning or author approval.'});
  if (!record(data) || data.schema !== 'synthetic-d245bc86d584' || !Array.isArray(data.sources)
      || !data.sources.length || !Array.isArray(data.quotes) || !data.quotes.length) return invalid('invalid_manifest');
  const declared = new Map(), ids = new Set();
  for (const source of data.sources) {
    if (!record(source) || !nonempty(source.id) || declared.has(source.id) || !nonempty(source.path)
        || !isAbsolute(source.path) || !/^[a-f0-9]{64}$/.test(source.blake3 ?? '')) return invalid('invalid_source_binding');
    declared.set(source.id, source);
  }
  for (const quote of data.quotes) {
    if (!record(quote) || !nonempty(quote.id) || ids.has(quote.id) || !declared.has(quote.source_id)
        || !nonempty(quote.text) || !Number.isSafeInteger(quote.byte_start) || !Number.isSafeInteger(quote.byte_end)
        || quote.byte_start < 0 || quote.byte_end <= quote.byte_start) return invalid('invalid_quote_binding');
    ids.add(quote.id);
  }
  const snapshots = new Map(), sources = [], quotes = [], readable = [];
  const sourceIndexes = new Map(data.sources.map((source, index) => [source.id, index]));
  // Keep a literal BOM too; TextDecoder's default silently strips it.
  const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
  for (const [source_index, source] of data.sources.entries()) {
    let bytes;
    try { bytes = readFileSync(source.path); }
    catch { failures.push({kind: 'source_unreadable', source_index}); continue; }
    readable.push({source_index, source, bytes});
  }
  let actualHashes = null;
  try { actualHashes = hashBuffers(readable.map(row => row.bytes)); }
  catch {
    for (const row of readable) failures.push({kind: 'source_hash_unavailable', source_index: row.source_index});
  }
  if (actualHashes) for (const [readable_index, {source_index, source, bytes}] of readable.entries()) {
    const actual = actualHashes[readable_index];
    const row = {source_index, expected_blake3: source.blake3,
      actual_blake3: actual, bytes: bytes.length, hash_matches: actual === source.blake3};
    sources.push(row);
    if (!row.hash_matches) { failures.push({kind: 'source_hash_mismatch', source_index}); continue; }
    let text;
    try { text = decoder.decode(bytes); }
    catch { failures.push({kind: 'source_invalid_utf8', source_index}); continue; }
    snapshots.set(source.id, {bytes, text});
  }
  for (const [quote_index, quote] of data.quotes.entries()) {
    const snapshot = snapshots.get(quote.source_id);
    const row = {quote_index, source_index: sourceIndexes.get(quote.source_id), byte_start: quote.byte_start,
      byte_end: quote.byte_end, passed: false};
    quotes.push(row);
    if (!snapshot) { failures.push({kind: 'quote_source_unavailable', quote_index}); continue; }
    if (quote.byte_end > snapshot.bytes.length) { failures.push({kind: 'quote_range_outside_source', quote_index}); continue; }
    let literal;
    try { literal = decoder.decode(snapshot.bytes.subarray(quote.byte_start, quote.byte_end)); }
    catch { failures.push({kind: 'quote_splits_utf8', quote_index}); continue; }
    row.passed = literal === quote.text;
    if (!row.passed) failures.push({kind: 'quote_literal_mismatch', quote_index,
      literal_present_elsewhere: snapshot.text.includes(quote.text)});
  }
  return {schema: 'source-span-readback-v1', status: failures.length ? 'failed' : 'passed', passed: !failures.length,
    sources, quotes, failures, scope: 'Exact BLAKE3 of bytes read and literal UTF-8 slices. No normalization or automatic offset repair. Does not authenticate speakers, facts, meaning, coverage or author approval. Source/quote indexes are zero-based manifest positions. Paths, IDs and bodies are omitted from this report.'};
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/**
 * The literal pieces of `text` in `sourceBytes`, in the source's own order: each piece is the longest run of the text's
 * words, with the exact characters between them, that occurs in the source after the previous piece, as { text,
 * byte_start, byte_end }; a word not found there is listed in `unbound`. Locating only: a text with no unbound word is
 * the source's own words in the source's order, with words cut out at most.
 */
export function literalPieces(text, sourceBytes) {
  const words = [...text.matchAll(WORD)].map(match => ({ start: match.index, end: match.index + match[0].length }));
  const pieces = [], unbound = [];
  let after = 0;
  const at = (from, to) => sourceBytes.indexOf(Buffer.from(text.slice(words[from].start, words[to].end), 'utf8'), after);
  for (let i = 0; i < words.length;) {
    if (at(i, i) < 0) { unbound.push(text.slice(words[i].start, words[i].end)); i += 1; continue; }
    let j = i;
    while (j + 1 < words.length && at(i, j + 1) >= 0) j += 1;
    const piece = text.slice(words[i].start, words[j].end), byte_start = at(i, j);
    pieces.push({ text: piece, byte_start, byte_end: byte_start + Buffer.byteLength(piece) });
    after = byte_start + Buffer.byteLength(piece);
    i = j + 1;
  }
  return { pieces, unbound };
}

function main() {
  const args = process.argv.slice(2);
  const arg = key => args.includes(key) ? args[args.indexOf(key) + 1] : null;
  const input = arg('--data'), output = arg('--out');
  if (!input || !output) { console.error('usage: node tools/pin-files-by-content/do-work/verify-source-spans.mjs --data bindings.json --out readback.json'); return 2; }
  let data, raw;
  try { raw = readFileSync(resolve(input)); data = JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(raw)); }
  catch { console.error('Cannot read or parse source-span manifest.'); return 2; }
  const result = verifySourceSpans(data);
  try { result.input_blake3 = hash(raw); }
  catch { result.passed = false; result.status = 'failed'; result.failures.push({kind: 'manifest_hash_unavailable'}); }
  try { writeFileSync(resolve(output), JSON.stringify(result, null, 2) + '\n', {flag: 'wx', mode: 0o600}); }
  catch { console.error('Cannot create readback; existing reports are never replaced.'); return 2; }
  console.log(JSON.stringify({status: result.status, sources: result.sources.length, quotes: result.quotes.length,
    failures: result.failures.length}));
  return result.passed ? 0 : result.status === 'invalid' ? 2 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
