// Immutable, bounded file metadata pages for a public app. Bytes remain in the
// existing BLAKE3 blob store; an installation points at one completed root.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkedPublicAppFile } from '../../shared-code/src/public-app-files.mjs';

const SCHEMA = 'trillion.public-app-file-index';
const PAGE_KEY = 'public-app/file-index/v1/';
const MAX_PAGE_BYTES = 65_536;
const MAX_ROWS = 128;
const MERGE_WIDTH = 32;
export const MAX_INDEX_FILES = 100_000;
export const MAX_INDEX_BYTES = 10_000_000_000;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const text = new TextEncoder();

function checkedIndex(index) {
  if (index?.schema !== SCHEMA || index.version !== 1 || !/^[a-f0-9]{64}$/.test(index.root ?? '') ||
      !Number.isSafeInteger(index.file_count) || index.file_count < 1 ||
      !Number.isSafeInteger(index.byte_count) || index.byte_count < 0 ||
      !Number.isSafeInteger(index.page_count) || index.page_count < 1) {
    throw new Error('This site file index is invalid.');
  }
  return index;
}

async function keepPage(env, page) {
  const bytes = text.encode(JSON.stringify(page));
  if (bytes.byteLength > MAX_PAGE_BYTES) throw new Error('A site file index page is too large.');
  const hash = bytesToHex(blake3(bytes));
  await env.HOSTED_STATE.put(`${PAGE_KEY}${hash}`, bytes, { httpMetadata: { contentType: 'application/json' } });
  return hash;
}

async function readPage(env, hash) {
  if (!/^[a-f0-9]{64}$/.test(hash ?? '')) throw new Error('A site file index page is invalid.');
  const object = await env.HOSTED_STATE.get(`${PAGE_KEY}${hash}`);
  if (!object) throw new Error('A site file index page is unavailable.');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength > MAX_PAGE_BYTES || bytesToHex(blake3(bytes)) !== hash) throw new Error('A site file index page changed.');
  const page = JSON.parse(new TextDecoder().decode(bytes));
  if (!page || !['leaf', 'branch'].includes(page.kind) || !Array.isArray(page.rows ?? page.children)) {
    throw new Error('A site file index page is invalid.');
  }
  return page;
}

function fits(kind, entries) {
  return entries.length <= MAX_ROWS && text.encode(JSON.stringify(kind === 'leaf'
    ? { kind, rows: entries } : { kind, children: entries })).byteLength <= MAX_PAGE_BYTES;
}

async function leaf(env, rows) {
  if (!rows.length || !fits('leaf', rows)) throw new Error('A site file index leaf is invalid.');
  const hash = await keepPage(env, { kind: 'leaf', rows });
  return { hash, first: rows[0].path, last: rows.at(-1).path,
    file_count: rows.length, byte_count: rows.reduce((n, row) => n + row.size, 0),
    page_count: rows.filter(row => row.path.endsWith('.html')).length };
}

async function branch(env, children) {
  if (!children.length || !fits('branch', children)) throw new Error('A site file index branch is invalid.');
  const hash = await keepPage(env, { kind: 'branch', children });
  return { hash, first: children[0].first, last: children.at(-1).last,
    file_count: children.reduce((n, row) => n + row.file_count, 0),
    byte_count: children.reduce((n, row) => n + row.byte_count, 0),
    page_count: children.reduce((n, row) => n + row.page_count, 0) };
}

function checkedRow(path, entry) {
  const file = checkedPublicAppFile(path, { blob_ref: entry?.blob_ref, media_type: entry?.media_type, size: entry?.size });
  if (!file.blob_ref) throw new Error(`The ${path} file needs its stored bytes.`);
  return { path, blob_ref: file.blob_ref, media_type: file.media_type, size: file.size };
}

async function mergeRuns(env, runs) {
  const readers = await Promise.all(runs.map(async run => ({ pages: run, page: await readPage(env, run[0].hash), pageAt: 0, rowAt: 0 })));
  const output = [];
  let rows = [];
  const flush = async () => { if (rows.length) { output.push(await leaf(env, rows)); rows = []; } };
  while (true) {
    let winner = -1;
    for (let i = 0; i < readers.length; i++) {
      const current = readers[i].page?.rows?.[readers[i].rowAt];
      if (current && (winner < 0 || compare(current.path, readers[winner].page.rows[readers[winner].rowAt].path) < 0)) winner = i;
    }
    if (winner < 0) break;
    const reader = readers[winner];
    const row = reader.page.rows[reader.rowAt++];
    if (rows.length && !fits('leaf', [...rows, row])) await flush();
    if (!fits('leaf', [row])) throw new Error(`The ${row.path} file path is too long for this site.`);
    rows.push(row);
    if (reader.rowAt === reader.page.rows.length) {
      reader.pageAt++;
      reader.page = reader.pageAt < reader.pages.length ? await readPage(env, reader.pages[reader.pageAt].hash) : null;
      reader.rowAt = 0;
    }
  }
  await flush();
  return output;
}

export function createPublicAppFileIndexBuilder(env) {
  let buffered = [];
  let runs = [];
  let count = 0;
  let bytes = 0;
  let home = false;
  let closed = false;
  const flush = async () => {
    if (!buffered.length) return;
    buffered.sort((a, b) => compare(a.path, b.path));
    runs.push([await leaf(env, buffered)]);
    buffered = [];
  };
  return {
    async add(path, entry) {
      if (closed) throw new Error('This site file index is finished.');
      const row = checkedRow(path, entry);
      if (count + 1 > MAX_INDEX_FILES || bytes + row.size > MAX_INDEX_BYTES) {
        throw new Error('This site is larger than its file budget.');
      }
      if (buffered.length && !fits('leaf', [...buffered, row])) await flush();
      if (!fits('leaf', [row])) throw new Error(`The ${path} file path is too long for this site.`);
      buffered.push(row);
      count++;
      bytes += row.size;
      if (path === 'index.html') home = true;
    },
    async finish() {
      if (closed) throw new Error('This site file index is finished.');
      closed = true;
      if (!count || !home) throw new Error('The site needs index.html.');
      await flush();
      while (runs.length > 1) {
        const next = [];
        for (let at = 0; at < runs.length; at += MERGE_WIDTH) next.push(await mergeRuns(env, runs.slice(at, at + MERGE_WIDTH)));
        runs = next;
      }
      let level = runs[0];
      let previous = null;
      for (const meta of level) {
        const page = await readPage(env, meta.hash);
        for (const row of page.rows) {
          if (previous === row.path) throw new Error(`The ${row.path} file path is repeated.`);
          previous = row.path;
        }
      }
      while (level.length > 1) {
        const next = [];
        for (let at = 0; at < level.length;) {
          const children = [];
          while (at < level.length && fits('branch', [...children, level[at]])) children.push(level[at++]);
          if (!children.length) throw new Error('A site file index branch is too large.');
          next.push(await branch(env, children));
        }
        level = next;
      }
      const root = level[0];
      return checkedIndex({ schema: SCHEMA, version: 1, root: root.hash,
        file_count: root.file_count, byte_count: root.byte_count, page_count: root.page_count });
    },
  };
}

export async function buildPublicAppFileIndex(env, entries) {
  const builder = createPublicAppFileIndexBuilder(env);
  for await (const row of entries) await builder.add(row.path, row);
  return builder.finish();
}

export async function getPublicAppFileIndexEntry(env, index, path) {
  checkedIndex(index);
  let hash = index.root;
  while (true) {
    const page = await readPage(env, hash);
    if (page.kind === 'leaf') {
      const row = page.rows.find(row => row.path === path);
      return row ? { blob_ref: row.blob_ref, media_type: row.media_type, size: row.size } : null;
    }
    const child = page.children.find(row => row.first <= path && row.last >= path);
    if (!child) return null;
    hash = child.hash;
  }
}

export async function listPublicAppFileIndex(env, index, { prefix = '', cursor = null, limit = 100 } = {}) {
  checkedIndex(index);
  if (typeof prefix !== 'string' || typeof cursor !== 'string' && cursor !== null) throw new Error('This site file list is invalid.');
  const maximum = Math.min(100, Math.max(1, Number(limit) || 100));
  const rows = [];
  const visit = async hash => {
    const page = await readPage(env, hash);
    if (page.kind === 'leaf') {
      for (const row of page.rows) {
        if (row.path.startsWith(prefix) && (!cursor || row.path > cursor)) rows.push(row);
        if (rows.length > maximum) return;
      }
      return;
    }
    for (const child of page.children) {
      if (cursor && child.last <= cursor || prefix && (child.last < prefix || child.first > `${prefix}\uffff`)) continue;
      await visit(child.hash);
      if (rows.length > maximum) return;
    }
  };
  await visit(index.root);
  const hasMore = rows.length > maximum;
  const selected = rows.slice(0, maximum);
  return { rows: selected, cursor: hasMore ? selected.at(-1).path : null };
}

/** Copy only the pages on one file's search path; the caller swaps the root after its revision check. */
export async function changePublicAppFileIndex(env, index, path, entry) {
  checkedIndex(index);
  if (path === 'index.html' && entry === null) throw new Error('The site needs index.html.');
  const replacement = entry === null ? null : checkedRow(path, entry);
  const before = await getPublicAppFileIndexEntry(env, index, path);
  if (!before && entry === null) return index;
  const nextCount = index.file_count + (before ? 0 : 1) - (entry === null ? 1 : 0);
  const nextBytes = index.byte_count - (before?.size ?? 0) + (replacement?.size ?? 0);
  if (nextCount > MAX_INDEX_FILES || nextBytes > MAX_INDEX_BYTES) throw new Error('This site is larger than its file budget.');
  const pack = async (kind, rows) => {
    const groups = [];
    let current = [];
    for (const row of rows) {
      if (current.length && !fits(kind, [...current, row])) {
        groups.push(kind === 'leaf' ? await leaf(env, current) : await branch(env, current));
        current = [];
      }
      if (!fits(kind, [row])) throw new Error('A site file index page is too large.');
      current.push(row);
    }
    if (current.length) groups.push(kind === 'leaf' ? await leaf(env, current) : await branch(env, current));
    return groups;
  };
  const change = async hash => {
    const page = await readPage(env, hash);
    if (page.kind === 'leaf') {
      const rows = page.rows.filter(row => row.path !== path);
      if (replacement) rows.push(replacement);
      rows.sort((a, b) => compare(a.path, b.path));
      return pack('leaf', rows);
    }
    const found = page.children.findIndex(child => child.last >= path);
    const at = found < 0 ? page.children.length - 1 : found;
    const selected = page.children[at] ?? page.children.at(-1);
    const children = page.children.flatMap((child, n) => n === at ? [] : [child]);
    const changed = await change(selected.hash);
    children.splice(at, 0, ...changed);
    return pack('branch', children);
  };
  let level = await change(index.root);
  while (level.length > 1) level = await pack('branch', level);
  const root = level[0];
  return checkedIndex({ schema: SCHEMA, version: 1, root: root.hash, file_count: root.file_count,
    byte_count: root.byte_count, page_count: root.page_count });
}
