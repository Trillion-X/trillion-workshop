// tools/check-a-folder-against-my-rules/do-work/check-an-archive.mjs
//
// The rules a person wrote, run over the files of one gzip tar archive at an https address (a repository's commit as
// its host serves it), so a change can be judged as it was pushed, never as some checkout on this computer happens to
// be. Run by the Workshop tool `tool:check-an-archive-against-my-rules`:
//
//   node do-work/check-an-archive.mjs < <the input as JSON>
//
// The input is { archive, rules, under?, recorded?, credential_name? }: `archive` the https address of a .tar.gz, and the rest as
// check-my-folder.mjs takes them. The archive's regular files are written into a private folder of this run (one
// shared top folder, as a host's commit archive has, is dropped from every path), judged by the same checkRepository,
// and the folder is removed before the answer. Bounds are DATA (read-data/archive-limits.json). It prints { result }
// on its last line, or { error } and a non-zero status when it cannot report honestly.
//
// `subjects_from` names subjects a rule can collect from (`collected.from_subject`) that this folder cannot hold,
// computed every run, never listed: { <name>: { was, now, path_matches, pattern, capture?, moved? } } is each value
// `pattern` captures in the files of archive `was` that `path_matches` names, less every value it captures in
// archive `now`, one per line (the ids one repository stopped declaring, judged in another). `moved`, a pattern with
// groups `from` and `to` over `now`'s same files, names a value's new home; a finding whose evidence holds that value
// says it.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { checkRepository, RunRefusal } from './run-check-source-files-against-declared-rules.mjs';
import { ruleCoversPath } from './check-source-files-against-declared-rules.mjs';

const LIMITS = JSON.parse(readFileSync(new URL('../read-data/archive-limits.json', import.meta.url), 'utf8'));

/** The entries of a tar (ustar, with pax `path` records and GNU long names): [{ name, type, body }]. */
export function tarEntries(bytes) {
  const entries = [];
  const field = (block, start, length) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  let offset = 0;
  let longName = null;
  while (offset + 512 <= bytes.length) {
    const block = bytes.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const size = parseInt(field(block, 124, 12).trim() || '0', 8);
    const type = field(block, 156, 1) || '0';
    const prefix = field(block, 345, 155);
    const body = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const found = body.toString('utf8').match(/^\d+ path=(.*)$/m);
      if (found) longName = found[1];
      continue;
    }
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'g') continue;
    const name = longName ?? (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    longName = null;
    entries.push({ name, type, body });
  }
  return entries;
}

/** The paths of `entries` with one top folder every entry shares dropped, as a host's commit archive has. */
function withoutSharedTop(entries) {
  const tops = new Set(entries.map((entry) => entry.name.split('/')[0]));
  const shared = tops.size === 1 && entries.every((entry) => entry.name.includes('/') || entry.type === '5');
  return entries
    .map((entry) => ({ ...entry, name: shared ? entry.name.split('/').slice(1).join('/') : entry.name }))
    .filter((entry) => entry.name !== '');
}

/** Write the archive's regular files under `root`, within the DATA bounds; answers how many were written, and each file
 *  skipped as { path, bytes, why }. */
export async function writeEntries(root, bytes, limits = LIMITS) {
  let written = 0, total = 0;
  const skipped = [];
  for (const entry of withoutSharedTop(tarEntries(gunzipSync(bytes)))) {
    if (entry.type !== '0' && entry.type !== '7') continue;
    const name = path.normalize(entry.name);
    if (path.isAbsolute(name) || name.split(path.sep).includes('..')) throw new RunRefusal(`the archive names a path outside itself: ${entry.name}`);
    if (entry.body.length > limits.most_file_bytes) { skipped.push({ path: name, bytes: entry.body.length, why: `larger than ${limits.most_file_bytes} bytes` }); continue; }
    if (total + entry.body.length > limits.most_written_bytes) { skipped.push({ path: name, bytes: entry.body.length, why: `the run already wrote ${total} of ${limits.most_written_bytes} bytes` }); continue; }
    await mkdir(path.join(root, path.dirname(name)), { recursive: true });
    await writeFile(path.join(root, name), entry.body);
    total += entry.body.length;
    written += 1;
  }
  return { written, skipped };
}

/** The secret the engine hands this run on descriptor 3 when the input names one (`credential_name`), else ''. */
const HELD_DESCRIPTOR = 3;
const held = () => {
  try { return readFileSync(HELD_DESCRIPTOR, 'utf8').trim(); } catch { return ''; }
};

/** The archive at `address`. A held secret is sent as a bearer token only to `sendTo`'s host (the archive's own), so a
 *  private repository's archive can be read and no other host ever sees the secret. */
export async function fetchArchive(address, limits = LIMITS, secret = '', sendTo = null, fetchImpl = fetch) {
  let url;
  try { url = new URL(address); } catch { throw new RunRefusal('give archive: the https address of a .tar.gz'); }
  if (url.protocol !== 'https:') throw new RunRefusal('the archive address must be https');
  const headers = secret && sendTo !== null && url.host === sendTo ? { authorization: `Bearer ${secret}` } : {};
  const response = await fetchImpl(url, { redirect: 'follow', headers });
  if (!response.ok) throw new RunRefusal(`the archive address answered ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limits.most_archive_bytes) throw new RunRefusal(`the archive is larger than ${limits.most_archive_bytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The files of `bytes` whose path `pathMatches` names, as text, never written to disk. */
function filesOf(bytes, pathMatches) {
  const named = new RegExp(pathMatches);
  return withoutSharedTop(tarEntries(gunzipSync(bytes)))
    .filter((entry) => entry.type === '0' && named.test(entry.name))
    .map((entry) => entry.body.toString('utf8'));
}

function captured(texts, pattern, capture) {
  const values = new Set();
  for (const text of texts) for (const found of text.matchAll(new RegExp(pattern, 'g'))) {
    const value = found.groups?.[capture] ?? found[capture];
    if (typeof value === 'string' && value !== '') values.add(value);
  }
  return values;
}

/** Each subject `subjects_from` names: { subjects: {name: text}, counts: {name: n}, moves: Map(value -> new home) }. */
export async function subjectsFrom(given, bytesOfAddress) {
  const subjects = {}, counts = {}, moves = new Map();
  for (const [name, spec] of Object.entries(given ?? {})) {
    for (const key of ['was', 'now', 'path_matches', 'pattern']) {
      if (typeof spec?.[key] !== 'string' || spec[key] === '') throw new RunRefusal(`subjects_from.${name} needs ${key}`);
    }
    const capture = spec.capture ?? 1;
    const nowFiles = filesOf(await bytesOfAddress(spec.now), spec.path_matches);
    const wasFiles = filesOf(await bytesOfAddress(spec.was), spec.path_matches);
    // Nothing declared in either archive is a wrong address or pattern, never "nothing retired".
    if (nowFiles.length === 0 || wasFiles.length === 0) {
      throw new RunRefusal(`subjects_from.${name}: no file of ${nowFiles.length === 0 ? spec.now : spec.was} matches ${spec.path_matches}`);
    }
    const now = captured(nowFiles, spec.pattern, capture);
    const gone = [...captured(wasFiles, spec.pattern, capture)].filter((value) => !now.has(value)).sort();
    subjects[name] = gone.join('\n');
    counts[name] = gone.length;
    if (typeof spec.moved === 'string') {
      for (const text of nowFiles) for (const found of text.matchAll(new RegExp(spec.moved, 'g'))) {
        if (found.groups?.from && found.groups?.to && gone.includes(found.groups.from)) moves.set(found.groups.from, found.groups.to);
      }
    }
  }
  return { subjects, counts, moves };
}

/** `violations` with `moved_to` on each whose evidence names a value `moves` knows the new home of. */
function withMoves(violations, moves) {
  if (moves.size === 0) return violations;
  const edge = (value) => new RegExp(`(?<![0-9A-Za-z_-])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Za-z_-])`);
  const known = [...moves].map(([from, to]) => ({ from, to, test: edge(from) }));
  return violations.map((found) => {
    const move = known.find(({ test }) => test.test(found.evidence ?? ''));
    return move ? { ...found, moved_to: move.to, said: `${move.from} moved to ${move.to}` } : found;
  });
}

const said = ({ violations, files, rules, no_applicable_rule: none, ratchet }, archive) => {
  if (none) return `${rules} rule(s) judged nothing in ${archive}: no file received an applicable rule, so this is not a pass.`;
  const against = ratchet ? ` Against the recorded set: ${ratchet.appeared.length} appeared, ${ratchet.fixed.length} fixed but still recorded.` : '';
  return `${violations.length} finding(s) from ${rules} rule(s) over ${files} file(s) of ${archive}.${against}`;
};

/** The whole run for one input; `bytesOf` reads the archive (fetchArchive, or a test's own bytes), within `limits`. */
export async function checkAnArchive(input, bytesOf = fetchArchive, limits = LIMITS, secret = '') {
  if (typeof input.archive !== 'string') throw new RunRefusal('give archive: the https address of a .tar.gz');
  if (!Array.isArray(input.rules)) throw new RunRefusal('give rules: a list of source-file-rule rows, each { kind: "source-file-rule", id, why, scope?, violation, ... }');
  const rules = input.rules.map((rule) => (rule?.payload ?? rule));
  // One fetch per address, though the judged archive and a subject's archive may be the same commit.
  const fetched = new Map();
  const bytesOfAddress = (address) => {
    if (!fetched.has(address)) fetched.set(address, bytesOf(address, limits, secret, new URL(input.archive).host));
    return fetched.get(address);
  };
  const { subjects, counts, moves } = await subjectsFrom(input.subjects_from, bytesOfAddress);
  const root = await mkdtemp(path.join(tmpdir(), 'archive-'));
  try {
    const { written, skipped } = await writeEntries(root, await bytesOfAddress(input.archive), limits);
    const { summary, failed } = checkRepository({ repoRoot: root, rules, under: input.under ?? null, recorded: input.recorded ?? null, subjects });
    const violations = withMoves(summary.violations, moves);
    const subjectCounts = Object.keys(counts).length ? { subjects: counts } : {};
    // A file a rule covers that was never written was never judged: the run cannot say it holds, so it is not a pass.
    const unjudged = skipped.filter(({ path: skippedPath }) => rules.some((rule) => ruleCoversPath(rule, skippedPath)));
    const notJudged = unjudged.length ? ` ${unjudged.length} file(s) a rule covers were not judged: ${unjudged.map(({ path: p, why }) => `${p} (${why})`).join(', ')}.` : '';
    return { passed: !failed && unjudged.length === 0, said: `${said(summary, input.archive)}${notJudged}`, archive: input.archive, written,
      skipped: skipped.length, skipped_paths: skipped, unjudged_paths: unjudged.map(({ path: p }) => p), ...summary, violations, ...subjectCounts, scanned_from: 'archive' };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  const secret = held();
  try {
    const input = JSON.parse((await text(process.stdin)) || '{}');
    console.log(JSON.stringify({ result: await checkAnArchive(input, fetchArchive, LIMITS, input.credential_name ? secret : '') }));
  } catch (error) {
    console.log(JSON.stringify({ error: secret ? error.message.split(secret).join('[held]') : error.message }));
    process.exitCode = error instanceof RunRefusal ? 2 : 1;
  }
}
