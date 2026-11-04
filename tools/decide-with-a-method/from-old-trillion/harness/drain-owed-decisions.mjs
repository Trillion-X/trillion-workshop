#!/usr/bin/env node
// harness/drain-owed-decisions.mjs
//
// Purpose
//   Empties the owed file. While the decisions' own server cannot keep a decision (its store full, busy, broken),
//   decide-before-building.mjs lets a turn that ran the method on this computer change files and appends one row per
//   change to the owed file, so that change is decided in Trillion once the server answers. Nothing read that file, so
//   it only grew (1,348 rows by 2026-10-06). This drain posts each owed turn to the person's Trillion when the server
//   answers again: a turn whose case is already decided is settled, a row naming a case already open in Trillion is
//   left to that case, and every other turn becomes an owed decision (start_decision with the person's words as its
//   goal and the change, the method steps run here and any answers kept on this computer as its evidence). Finished
//   rows move to a dated archive.
//
// Non-negotiable invariants
//   1. A run starts only after trillionDown says the server can keep a decision, and it sizes itself from how fast the
//      store answers: the batch it reads (`pace.rows`, kept beside the owed file) grows by `pace.grow_by` after a run
//      whose every answer, the opening light read included, came within `pace.fast_ms`, shrinks by `pace.shrink_by`
//      after a busy, failed or slow answer, and never leaves `pace.least_rows`..`pace.most_rows`. While the light read
//      is slower than `pace.healthy_ms` a run reads only `pace.least_rows`. Calls are bounded by `pace.calls_per_row`
//      of the batch. The first down, failed or slower-than-`pace.slow_ms` answer ends the run with every unfinished
//      row kept. A drain can therefore never be what loads the store.
//   2. The owed file is never rewritten under its writer. A run renames it to `<owed><draining_suffix>` (atomic; the
//      hook's next append makes a new owed file) only when no draining file is left, and then works on the draining
//      file alone, rewriting it with the rows still owed. One drain runs at a time per computer (the lock beside the
//      owed file; a lock whose process is gone or older than `lock_stale_minutes` is taken over).
//   3. A row leaves the draining file only after its archive line is written, so a row is never lost; a run cut off
//      between the two posts the row again, and start_decision returns the same case for the same source_id and
//      content, so it is never decided twice.
//   4. One turn is one decision: rows are grouped by transcript and the person's message they answer. Rows written
//      before the hook kept the person's words are matched to their turn by reading the transcript from its end, one
//      block at a time, never whole (transcripts pass 400 MB).
//   4b. Only a turn the person started becomes a decision. Whether a transcript row is the person speaking is decided
//      once, by the message recorder's rules (record-every-message.json: injected text, peer prompts, generated context,
//      headless sessions), and read from the transcript every time; a row whose transcript is gone, or whose turn began
//      with words nobody typed (an instruction file, a teammate's prompt, context a harness added), is archived as
//      `not_person` and never posted.
//   4a. A turn whose source already has a case (start_decision answers `existing_case_answer`, as when a file of answers
//      kept on this computer changed between two posts of the same turn) is left to that case, never retried forever.
//   5. Nothing here names a person, product or harness. Which server and key, which words count as down, and where the
//      owed file is come from decide-before-building.json; limits, words, options and the archive from
//      drain-owed-decisions.json.
//
// Run
//   As a handler of harness/wake-sessions.mjs (exports start, takes no events): every `every_minutes`.
//   By hand: node harness/drain-owed-decisions.mjs --once [--dry] [--owed <file>] [--origin <https://...>] [--key-stdin]
//   (the key is read from the keychain item in decide-before-building.json unless --key-stdin gives it on stdin).
//
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { casesToConfirm, downAnswer, eventsOf, exportShowsDecided, localMethodSteps, settings as deciding, trillionCaller, trillionDown } from './decide-before-building.mjs';
import { collectGarbage, messagesOf, personSpeaksIn, sessionOfTranscript } from './record-every-message.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const readRules = () => JSON.parse(readFileSync(join(HERE, 'drain-owed-decisions.json'), 'utf8'));
const expand = path => path.replace(/^~(?=\/|$)/, homedir());
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole));
/** The batch the next run reads, from the last one and how its answers came. → rows */
export function nextRows(rows, { pace, read, slowest = 0, backedOff = false }) {
  const bounded = value => Math.min(pace.most_rows, Math.max(pace.least_rows, Math.round(value)));
  if (backedOff || slowest > pace.slow_ms) return bounded(rows / pace.shrink_by);
  if (slowest <= pace.fast_ms && read >= rows) return bounded(rows * pace.grow_by);
  return bounded(rows);
}
const paceAt = (path, pace) => {
  try { const rows = JSON.parse(readFileSync(path, 'utf8')).rows; if (Number.isFinite(rows)) return Math.min(pace.most_rows, Math.max(pace.least_rows, rows)); } catch {}
  return pace.first_rows;
};
const clip = (text, chars) => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);

/** Takes the drain's lock, or answers null while another live drain holds it. → release() */
export function holdLock(path, { staleMs, pid = process.pid, now = Date.now(), alive = isAlive } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, JSON.stringify({ pid, at: new Date(now).toISOString() }), { flag: 'wx', mode: 0o600 });
      return () => { try { if (JSON.parse(readFileSync(path, 'utf8')).pid === pid) unlinkSync(path); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let held = null;
      try { held = JSON.parse(readFileSync(path, 'utf8')); } catch {}
      const stale = !held || !alive(held.pid) || now - (Date.parse(held.at) || 0) > staleMs;
      if (!stale) return null;
      try { unlinkSync(path); } catch {}
    }
  }
  return null;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/**
 * A file's lines newest first, read in blocks from its end; the file is never held whole. A line longer than
 * `mostLineBytes` is left out without being decoded or carried from block to block: one tool output of hundreds of
 * megabytes held the drain at 400 MB (2026-10-22). After each `collectEveryBytes` read the garbage the lines made is
 * collected: a 1.8 GB transcript left the drain at 300 MB with 8 MB of it still in use.
 */
export function* linesFromTheEnd(path, blockBytes = 4 * 1024 * 1024, mostLineBytes = Infinity, collectEveryBytes = Infinity) {
  const handle = openSync(path, 'r');
  try {
    let position = statSync(path).size;
    let carry = Buffer.alloc(0);
    // Set while the bytes before the next newline are the rest of a line that already passed mostLineBytes.
    let skipping = false;
    let sinceCollect = 0;
    const block = Buffer.alloc(Math.min(blockBytes, position));
    while (position > 0) {
      const length = Math.min(blockBytes, position);
      position -= length;
      readSync(handle, block, 0, length, position);
      sinceCollect += length;
      if (sinceCollect >= collectEveryBytes) { sinceCollect = 0; collectGarbage(); }
      const read = block.subarray(0, length);
      const joined = carry.length ? Buffer.concat([read, carry]) : read;
      let end = joined.length;
      for (let index = joined.length - 1; index >= 0; index -= 1) {
        if (joined[index] !== 10) continue;
        if (!skipping && end - index - 1 <= mostLineBytes) {
          const line = joined.subarray(index + 1, end).toString('utf8');
          if (line.trim()) yield line;
        }
        skipping = false;
        end = index;
      }
      skipping ||= end > mostLineBytes;
      // A copy: the next read overwrites `block`.
      carry = skipping || end === 0 ? Buffer.alloc(0) : Buffer.from(joined.subarray(0, end));
    }
    if (!skipping && carry.length <= mostLineBytes) {
      const first = carry.toString('utf8');
      if (first.trim()) yield first;
    }
  } finally { closeSync(handle); }
}

// Only what the decision needs from a call: its name and the inputs casesToConfirm and localMethodSteps read.
const slim = event => (event.kind !== 'call' ? null : {
  kind: 'call', name: event.name,
  input: Object.fromEntries(['case_id', 'command', 'cmd', 'text'].filter(field => typeof event.input?.[field] === 'string' || Array.isArray(event.input?.[field])).map(field => [field, typeof event.input[field] === 'string' ? event.input[field].slice(0, 4000) : event.input[field]])),
});

/** The person's own words in one transcript row, by the message recorder's rules; '' for a row the person did not type. */
export function personWordsIn(row, harness) {
  if (!harness) return '';
  return messagesOf([row], harness, { sessionId: 'owed' }).messages.filter(message => message.speaker === 'person').map(message => message.text).join('\n').trim();
}

/**
 * The turn each of several times falls in, read from one transcript's end in a single pass. `person` says whether the
 * message that began it is the person speaking (`harness` and `personSpeaks` from the message recorder's rules).
 * → Map(time → { asked: { text, at, person } | null, turn: [call events in order] })
 */
export function turnsAt(path, times, { blockBytes, mostLineBytes = Infinity, collectEveryBytes = Infinity, harness = null, personSpeaks = false } = {}) {
  const pending = [...new Set(times)].map(time => ({ time, ms: Date.parse(time), entered: false, calls: [], asked: null }));
  const found = new Map();
  if (!pending.length) return found;
  const settle = target => {
    found.set(target.time, { asked: target.asked, turn: target.calls.reverse() });
    pending.splice(pending.indexOf(target), 1);
  };
  for (const line of linesFromTheEnd(path, blockBytes, mostLineBytes, collectEveryBytes)) {
    // A line this long is a tool's output, never a person's message or a call that names a case.
    if (line.length > mostLineBytes) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const ms = Date.parse(row?.timestamp ?? '');
    const events = eventsOf(row);
    const asked = events.find(event => event.kind === 'asked');
    const calls = events.map(slim).filter(Boolean).reverse();
    // A note the harness wrote beside the person's message (an image's path) carries the message's own time: a turn
    // that begins with words nobody typed is settled only once a row from before that time is reached.
    for (const target of pending.filter(item => item.asked && Number.isFinite(ms) && ms < item.askedMs)) settle(target);
    for (const target of pending) {
      if (!target.entered && Number.isFinite(ms) && ms <= target.ms) target.entered = true;
      if (!target.entered) continue;
      target.calls.push(...calls);
      if (asked) {
        const words = personSpeaks ? personWordsIn(row, harness) : '';
        if (!target.asked || words) {
          target.asked = { text: words || (asked.text ?? ''), at: asked.at ?? row.timestamp ?? null, person: Boolean(words) };
          target.askedMs = ms;
        }
      }
    }
    for (const target of pending.filter(item => item.asked?.person)) settle(target);
    if (!pending.length) break;
  }
  for (const target of [...pending]) settle(target);
  return found;
}

/** The owed rows of a file's text, in order: { line, row } (row is null for a line that is not a readable row). */
export function rowsOf(text) {
  return text.split('\n').filter(line => line.trim()).map(line => {
    try { const row = JSON.parse(line); return { line, row: row && typeof row === 'object' ? row : null }; } catch { return { line, row: null }; }
  });
}

/** A kept answers file's words: the named text fields of a JSON object, else nothing. */
function keptText(path, rules, read) {
  try {
    if (/[*?]/.test(path)) return '';
    const text = read(expand(path), rules.kept_file_most_bytes);
    const value = JSON.parse(text);
    return rules.kept_file_text_fields.map(field => (typeof value?.[field] === 'string' ? `${field}: ${value[field]}` : '')).filter(Boolean).join('; ');
  } catch { return ''; }
}

function readSome(path, most) {
  const handle = openSync(path, 'r');
  try { const buffer = Buffer.alloc(most); const got = readSync(handle, buffer, 0, most, 0); return buffer.subarray(0, got).toString('utf8'); } finally { closeSync(handle); }
}

/**
 * The owed turns in a batch of rows: one group per transcript and person's message.
 * → [{ key, rows: [{ line, row }], asked, turn, transcript }]
 */
export function groupsOf(batch, { rules, turnsOf = turnsAt } = {}) {
  const needed = new Map();
  for (const { row } of batch) {
    if (!row || !row.transcript || !existsSync(row.transcript)) continue;
    if (!needed.has(row.transcript)) needed.set(row.transcript, []);
    needed.get(row.transcript).push(row.at);
  }
  const recovered = new Map();
  for (const [path, times] of needed) {
    try {
      const harness = sessionOfTranscript(path)?.harness ?? null;
      const personSpeaks = Boolean(harness) && personSpeaksIn(path, harness);
      recovered.set(path, turnsOf(path, times, { blockBytes: rules.read_block_bytes, mostLineBytes: rules.most_line_bytes, collectEveryBytes: rules.collect_every_bytes, harness, personSpeaks }));
    } catch { recovered.set(path, new Map()); }
  }
  const groups = new Map();
  for (const item of batch) {
    const { row } = item;
    const found = recovered.get(row.transcript)?.get(row.at) ?? { asked: null, turn: [] };
    const askedKey = found.asked ? (found.asked.at ?? clip(found.asked.text, 80)) : null;
    // A transcript with no message from the person (a lane driven by another AI) is one turn, as the hook reads it.
    const key = row.transcript ? `${row.transcript}|${askedKey ?? 'no message'}` : `${row.agent ?? 'unnamed'}|${row.at}`;
    if (!groups.has(key)) groups.set(key, { key, rows: [], asked: found.asked, turns: [], transcript: row.transcript ?? null });
    const group = groups.get(key);
    group.rows.push(item);
    if (found.turn) group.turns.push(found.turn);
  }
  return [...groups.values()];
}

/** The cases a group's turn or rows name, in order, once each. */
export function casesOf(group) {
  const cases = [];
  const add = id => { if (typeof id === 'string' && id && !cases.includes(id)) cases.push(id); };
  for (const { row } of group.rows) { add(row.case_id); for (const id of row.cases ?? []) add(id); }
  for (const turn of group.turns) for (const id of casesToConfirm(turn)) add(id);
  return cases;
}

/** The start_decision arguments for one owed turn, every word from the settings. */
export function decisionOf(group, rules, { read = readSome } = {}) {
  const rows = group.rows.map(item => item.row);
  const changes = [...new Set(rows.flatMap(row => (Array.isArray(row.changes) ? row.changes : [])).map(String))];
  const times = rows.map(row => row.at).filter(Boolean).sort();
  const steps = [...new Set([...rows.flatMap(row => row.method_steps ?? []), ...group.turns.flatMap(turn => localMethodSteps(turn))])];
  const tools = [...new Set(rows.map(row => row.tool_name).filter(Boolean))];
  const agents = [...new Set(rows.map(row => row.agent).filter(Boolean))];
  const kept = rows.flatMap(row => rules.kept_file_fields.map(field => row[field]).filter(value => typeof value === 'string'));
  const keptWords = kept.map(path => ({ path, text: keptText(path, rules, read) }));
  const asked = clip(group.asked.text.replace(/\s+/g, ' ').trim(), rules.asked_chars);
  const listed = changes.slice(0, rules.changes_listed).join(', ') + (changes.length > rules.changes_listed ? ` and ${changes.length - rules.changes_listed} more` : '');
  const values = { asked, changes: listed || 'files', count: changes.length, when: times[0] ?? '', first_at: times[0] ?? '', last_at: times.at(-1) ?? '', tool: tools.join(', ') || 'A tool', steps: steps.join(', ') };
  const claim = text => clip(text, rules.claim_chars);
  const evidence = [];
  evidence.push({ ref: 'asked', claim: claim(fill(rules.evidence.asked, values)) });
  evidence.push({ ref: 'changes', claim: claim(fill(rules.evidence.changes, values)) });
  evidence.push({ ref: 'method', claim: claim(steps.length ? fill(rules.evidence.method, values) : rules.evidence.no_method) });
  for (const agent of agents) evidence.push({ ref: `agent-${evidence.length}`, claim: claim(fill(rules.evidence.agent, { agent })) });
  for (const item of keptWords) evidence.push({ ref: `kept-${evidence.length}`, claim: claim(fill(rules.evidence.kept, { path: item.path, text: item.text || '(not readable here)' })) });
  // The first owed row's time is in the source, so a turn whose rows fall in two runs makes two decisions, never one
  // source asked twice with different words; a run cut off and run again posts the same rows with the same words.
  const anchor = `${group.transcript ? basename(group.transcript) : agents[0] ?? 'row'}:${times[0]}`;
  return {
    source_id: `${rules.source_prefix}${anchor}`,
    goal: fill(rules.goal, values),
    evidence,
    options: rules.options,
  };
}

const caseIdIn = text => {
  try { const value = JSON.parse(text); if (typeof value?.case_id === 'string') return value.case_id; } catch {}
  return /"case_id"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null;
};

/**
 * One drain run. Every outside effect can be handed in, so it is tested without a server or this computer's files.
 * → { ran: boolean, why?, read, settled, in_trillion, posted, unreadable, kept, stopped? }
 */
export async function drainOnce({
  rules = readRules(), owed = expand(deciding.when_trillion_is_down.owed_file), confirm = deciding.confirm_with,
  down = deciding.when_trillion_is_down, key = null, request = fetch, now = () => new Date(), dry = false,
  isDown = trillionDown, turnsOf = turnsAt, read = readSome, log = () => {}, clock = () => performance.now(),
} = {}) {
  const draining = `${owed}${rules.draining_suffix}`;
  const release = holdLock(`${owed}.drain.lock`, { staleMs: rules.lock_stale_minutes * 60_000 });
  if (!release) return { ran: false, why: 'another drain is running' };
  try {
    if (!existsSync(draining) && !(existsSync(owed) && statSync(owed).size > 0)) return { ran: false, why: 'nothing owed' };
    const asked = { ...confirm, timeout_ms: rules.timeout_ms };
    const { pace } = rules;
    const paceFile = `${owed}.pace`;
    const paced = paceAt(paceFile, pace);
    const probed = clock();
    const downNow = await isDown(asked, down, { request, key });
    const probeMs = clock() - probed;
    const keepPace = (rows) => { if (!dry) writeFileSync(paceFile, JSON.stringify({ rows, at: now().toISOString() }), { mode: 0o600 }); return rows; };
    if (downNow) { keepPace(nextRows(paced, { pace, read: 0, backedOff: true })); return { ran: false, why: 'Trillion cannot keep a decision yet' }; }
    const healthy = probeMs <= pace.healthy_ms;
    const rows = healthy ? paced : pace.least_rows;
    const mostCalls = Math.max(1, Math.ceil(rows * pace.calls_per_row));
    let slowest = probeMs;
    // A dry run reads where the rows are and moves nothing.
    if (!dry && !existsSync(draining)) renameSync(owed, draining);
    const all = rowsOf(readFileSync(existsSync(draining) ? draining : owed, 'utf8'));
    const batch = all.slice(0, rows);
    const finished = new Map();
    const at = now().toISOString();
    for (const item of batch) if (!item.row) finished.set(item, { state: 'unreadable' });
    const tool = trillionCaller(asked, { request, key });
    if (!tool) return { ran: false, why: 'no key for Trillion' };
    let calls = 0;
    let stopped = null;
    const ask = async (name, args) => {
      calls += 1;
      const began = clock();
      const answer = await tool(name, args);
      const took = clock() - began;
      slowest = Math.max(slowest, took);
      if (answer.status >= 500 || downAnswer(answer.text, down)) throw Object.assign(new Error(clip(answer.text || String(answer.status), 200)), { down: true });
      if (took > pace.slow_ms) stopped = `the store took ${Math.round(took)} ms to answer`;
      return answer;
    };
    for (const group of groupsOf(batch.filter(item => item.row), { rules, turnsOf })) {
      if (calls >= mostCalls) { stopped = 'call budget used'; break; }
      if (!group.asked?.person) { for (const item of group.rows) finished.set(item, { state: 'not_person' }); continue; }
      try {
        const cases = casesOf(group);
        let outcome = null;
        for (const caseId of cases) {
          if (calls >= mostCalls) break;
          if (exportShowsDecided((await ask('export_decision', { case_id: caseId })).text)) { outcome = { state: 'settled', case_id: caseId }; break; }
        }
        if (!outcome && calls >= mostCalls) { stopped = 'call budget used'; break; }
        const named = group.rows.map(item => item.row.case_id).find(id => typeof id === 'string');
        if (!outcome && named) outcome = { state: 'in_trillion', case_id: named };
        if (!outcome) {
          const args = decisionOf(group, rules, { read });
          if (dry) outcome = { state: 'posted', case_id: null, dry: true, source_id: args.source_id, goal: args.goal };
          else {
            const answer = await ask('start_decision', args);
            const caseId = caseIdIn(answer.text);
            // A turn posted before with other evidence (a kept answer file changed since) already has its case.
            const earlier = caseId ? null : new RegExp(rules.existing_case_answer).exec(answer.text)?.[1];
            if (!caseId && !earlier) throw new Error(`start_decision answered without a case: ${clip(answer.text, 200)}`);
            outcome = earlier ? { state: 'in_trillion', case_id: earlier, source_id: args.source_id } : { state: 'posted', case_id: caseId, source_id: args.source_id };
          }
        }
        for (const item of group.rows) finished.set(item, outcome);
        if (stopped) break;
      } catch (error) {
        stopped = error.message;
        log(`drain-owed-decisions: stopped: ${error.message}`);
        break;
      }
    }
    const counts = { settled: 0, in_trillion: 0, posted: 0, unreadable: 0, not_person: 0 };
    for (const outcome of finished.values()) counts[outcome.state] += 1;
    if (!dry && finished.size) {
      const folder = expand(rules.archive_folder);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const archived = [...finished].map(([item, outcome]) => JSON.stringify({ ...(item.row ?? { line: item.line }), drained: { ...outcome, at, why: rules.states[outcome.state] } })).join('\n');
      appendFileSync(join(folder, `${at.slice(0, 10)}.jsonl`), `${archived}\n`, { mode: 0o600 });
      const left = all.filter(item => !finished.has(item));
      if (left.length) {
        const part = `${draining}.${process.pid}.part`;
        writeFileSync(part, `${left.map(item => item.line).join('\n')}\n`, { mode: 0o600 });
        renameSync(part, draining);
      } else unlinkSync(draining);
    }
    const kept = all.length - (dry ? 0 : finished.size);
    const next = keepPace(healthy ? nextRows(rows, { pace, read: batch.length, slowest, backedOff: Boolean(stopped) && stopped !== 'call budget used' }) : nextRows(paced, { pace, read: 0, backedOff: true }));
    if (finished.size || stopped) log(`drain-owed-decisions: ${finished.size} of ${all.length} rows finished (${counts.settled} settled, ${counts.in_trillion} already open, ${counts.posted} posted, ${counts.not_person} not from the person), ${calls} calls, slowest answer ${Math.round(slowest)} ms, next run reads ${next}${stopped ? `, stopped: ${stopped}` : ''}`);
    return { ran: true, read: batch.length, ...counts, kept, calls, next_rows: next, ...(stopped ? { stopped } : {}), ...(dry ? { dry: [...finished.values()] } : {}) };
  } finally { release(); }
}

export const wants = () => false;
export const handle = () => null;

let timer = null;
export const start = ({ key, origin, log = () => {} } = {}) => {
  const rules = readRules();
  const confirm = origin ? { ...deciding.confirm_with, url: `${origin.replace(/\/$/, '')}/mcp` } : deciding.confirm_with;
  let running = null;
  const pass = () => {
    if (running) return running;
    running = drainOnce({ rules: readRules(), confirm, key, log })
      .catch(error => log(`drain-owed-decisions: the run did not finish: ${error.message}`))
      .finally(() => { running = null; });
    return running;
  };
  clearInterval(timer);
  pass();
  timer = setInterval(pass, rules.every_minutes * 60_000);
  timer.unref?.();
  return timer;
};

const isEntryScript = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntryScript()) {
  const argument = name => { const index = process.argv.indexOf(name); return index === -1 ? null : process.argv[index + 1]; };
  let key = null;
  if (process.argv.includes('--key-stdin')) { let raw = ''; for await (const chunk of process.stdin) raw += chunk; key = raw.split('\n')[0].trim() || null; }
  const origin = argument('--origin');
  const result = await drainOnce({
    key, dry: process.argv.includes('--dry'),
    ...(argument('--owed') ? { owed: argument('--owed') } : {}),
    ...(origin ? { confirm: { ...deciding.confirm_with, url: `${origin.replace(/\/$/, '')}/mcp` } } : {}),
    log: line => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
