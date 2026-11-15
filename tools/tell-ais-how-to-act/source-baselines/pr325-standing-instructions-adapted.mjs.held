// tools/tell-ais-how-to-act/do-work/standing-instructions.mjs
//
// Moved from Trillion-X/trillion harness/standing-instructions.mjs; its rows are ../read-data/standing-instructions.json
// and ../read-data/harness-instruction-files.json (the src/harnesses.json rows it read).
//
// Keeps Trillion's standing instructions as ONE marked block in an AI harness's own global instruction file
// (read-data/standing-instructions.json: markers and text; read-data/harness-instruction-files.json rows: where each
// harness keeps its file).
// inspect reads, apply writes or replaces only the block, remove deletes only the block; every other byte of the file
// is left exactly as it was, and apply twice changes nothing. A harness with no file (a hosted app) is answered with the
// control it has, never written. Pure file work: the caller (do-work/keep-standing-instructions.mjs) may supply the current text.
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import rows from '../read-data/harness-instruction-files.json' with { type: 'json' };

export const standing = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'read-data', 'standing-instructions.json'), 'utf8'));
export const ACTIONS = ['inspect', 'apply', 'remove'];
const SCHEMA = 'trillion.standing-instructions-report/v1';
const expand = (path, home) => path.replace(/^~(?=\/|$)/, home);
const read = path => { try { return readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

export const harnessRow = id => rows.harnesses.find(row => row.id === id && row.standing_instructions) ?? null;
export const harnessIds = () => rows.harnesses.filter(row => row.standing_instructions).map(row => row.id);

/** The file a harness keeps its standing instructions in, or null for a harness that has none (a hosted app). */
export function instructionPath(row, { home = homedir(), env = process.env } = {}) {
  const where = row.standing_instructions;
  if (where.kind !== 'file') return null;
  const folder = env[where.home_variable] ? resolve(expand(env[where.home_variable], home)) : join(home, where.folder);
  return join(folder, where.file);
}

/** The block as written: start marker, text, end marker. */
export const blockOf = (text = standing.text, markers = standing.markers) => `${markers.start}\n${text.trim()}\n${markers.end}`;

/** Where the block sits in a file's text: { state: 'absent' } | { state: 'found', from, to } | { state: 'broken', why }. */
export function findBlock(content, markers = standing.markers) {
  const lines = [];
  let at = 0;
  for (const line of content.split('\n')) { lines.push({ text: line.replace(/\r$/, ''), at }); at += line.length + 1; }
  const starts = lines.filter(line => line.text.trim() === markers.start);
  const ends = lines.filter(line => line.text.trim() === markers.end);
  if (!starts.length && !ends.length) return { state: 'absent' };
  if (starts.length !== 1 || ends.length !== 1 || ends[0].at < starts[0].at) return { state: 'broken', why: 'The block markers are not one start followed by one end.' };
  const to = ends[0].at + ends[0].text.length;
  return { state: 'found', from: starts[0].at, to: content[to] === '\r' ? to + 1 : to };
}

/** The new file text for an action; the pure heart, so every byte outside the block is provably untouched. */
export function change(content, action, block = blockOf(), markers = standing.markers) {
  const found = findBlock(content ?? '', markers);
  if (found.state === 'broken') return { state: 'broken', why: found.why };
  const before = content ?? '';
  if (action === 'apply') {
    if (found.state === 'found') return { state: 'found', next: before.slice(0, found.from) + block + before.slice(found.to) };
    const lead = before === '' ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    return { state: 'absent', next: before + lead + block + '\n' };
  }
  if (found.state === 'absent') return { state: 'absent', next: before };
  let head = before.slice(0, found.from);
  let tail = before.slice(found.to);
  if (tail.startsWith('\r\n')) tail = tail.slice(2); else if (tail.startsWith('\n')) tail = tail.slice(1);
  if (tail === '' && head.endsWith('\n\n')) head = head.slice(0, -1);
  return { state: 'found', next: head + tail };
}

/** Writes through a symlink to its target, beside it and then renamed over it, keeping the file's mode. */
function writeFile(path, text) {
  let target = path;
  try { target = realpathSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; mkdirSync(dirname(path), { recursive: true }); }
  let mode = 0o644;
  try { mode = statSync(target).mode & 0o777; } catch { /* a new file */ }
  const temp = `${target}.trillion-${process.pid}-${Date.now()}.tmp`;
  try {
    writeFileSync(temp, text, { mode });
    chmodSync(temp, mode);
    const descriptor = openSync(temp, 'r'); try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temp, target);
  } catch (error) { try { unlinkSync(temp); } catch { /* already gone */ } throw error; }
}

/**
 * keepInstructions({ action, harness, text?, home?, env? }) -> report. `text` is the current standing text (a caller
 * may pass the service's); without it the copy in read-data is used. An unknown harness or action is refused.
 */
export function keepInstructions({ action = 'inspect', harness, text = standing.text, home = homedir(), env = process.env, markers = standing.markers } = {}) {
  const row = harnessRow(harness);
  if (!row) throw new Error(`No harness ${JSON.stringify(harness)} is supported. Supported: ${harnessIds().join(', ')}.`);
  if (!ACTIONS.includes(action)) throw new Error('Name inspect, apply or remove.');
  const report = { schema: SCHEMA, harness: row.id, name: row.app, action, text };
  const where = row.standing_instructions;
  if (where.kind !== 'file') {
    return { ...report, kind: 'host-control', control: where.control, status: 'use-host-control', changed: false,
      reason: `${row.app} has no instruction file to write. Put the text in ${where.control}.` };
  }
  const path = instructionPath(row, { home, env });
  const content = read(path);
  const block = blockOf(text, markers);
  const found = findBlock(content ?? '', markers);
  const current = found.state === 'found' ? content.slice(found.from, found.to).replace(/\r\n/g, '\n') : null;
  const status = found.state === 'broken' ? 'blocked' : found.state === 'absent' ? 'absent' : current === block ? 'present' : 'outdated';
  const base = { ...report, kind: 'file', path, file_exists: content !== null };
  if (found.state === 'broken') return { ...base, status, changed: false, reason: `${found.why} Nothing was changed.` };
  if (action === 'inspect') return { ...base, status, changed: false };
  const done = change(content, action, block, markers);
  if (done.next === content || (content === null && done.next === '')) return { ...base, status: action === 'apply' ? 'present' : 'absent', changed: false };
  writeFile(path, done.next);
  return { ...base, status: action === 'apply' ? 'present' : 'absent', previous: status, changed: true };
}
