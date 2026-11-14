// harness/wake-handlers/wake-stopped-chats.mjs
//
// Purpose
//   A start-only handler for harness/wake-sessions.mjs that wakes AI chats on this computer which stopped before their
//   turn finished (a usage limit, an outage, a crash, the computer restarting or losing power), so nobody has to
//   notice and start them again by hand. Every check_every_minutes (harness/wake-stopped-chats.json) it reads the
//   transcripts touched in the last look_back_hours, judges each chat and each of its lanes by the last row of its
//   turn, and hands every new stop to the person's Trillion once (POST /handoffs with once_per the stop): one job per
//   stopped chat (given back to that chat when it is hosted here, then to any AI after chat_prefer_minutes; a chat not
//   hosted here keeps no silence window, stopped_chat_silence_minutes, so any AI may take it at once) and one
//   per stopped lane (any AI). The doing is left to the owners that already do work a few at a time: this computer's
//   taker (harness/take-open-work.mjs, max_concurrent) and every chat that calls take_work. Waking is never a mass
//   relaunch from one place: one chat relaunching about 80 lanes filled this computer's memory on 2026-10-04.
//
// Non-negotiable invariants
//   1. It takes no events (wants is always false) and starts no AI itself; it only reads transcripts and creates
//      handoffs in the person's own account.
//   2. A chat is woken only when it and every one of its lanes have been quiet quiet_minutes, and a stop that names
//      when it may go on (a usage limit's reset) is handed out only after that time: a live chat is never woken.
//   3. Each stop is one job: once_per names the transcript and the stop row's own time, and the stop is remembered in
//      state_file only after Trillion accepted it, so a refused or interrupted hand-out is tried on the next check and
//      never doubled.
//   4. A lane whose name has a newer transcript anywhere was already carried on and is left alone.
//   5. Nothing here names an AI, a stop reason, a file place or a word shown to anyone: every one is a row in
//      harness/wake-stopped-chats.json; adding an AI is a `chats` row.
//   6. Quiet is measured from each transcript's last turn row, not its mtime: queued messages sent to a stuck chat
//      append rows to its file and would restart the clock on every message.
//   7. A chat with a `live` block is read from the computer's live status files (one per running process). A live
//      session that is busy is never handed out. One waiting on a prompt nobody can answer is handed out as a stuck
//      stop once it has waited after_minutes, with no AI preferred, because the stuck chat cannot take it. A live
//      session is never judged by its transcript; a dead pid falls back to the transcript rules.
//   8. Each stop counts the messages still waiting in its transcript (`queued`) and names them in its job; each check
//      writes every stop it found, with its state and count, to stuck_file (the live count, readable from one file).
//
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountCaller } from '../take-open-work.mjs';
import operators from 'trillion-workshop/tools/formula-engine/rules/rule-operators.json' with { type: 'json' };
import { makeRowFilter, ruleTreeOfTests } from 'trillion-workshop/tools/formula-engine/rules/filter-rows-by-rules.mjs';

const RULES_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'wake-stopped-chats.json');
export const readRules = () => JSON.parse(readFileSync(RULES_FILE, 'utf8'));
const expand = path => path.replace(/^~(?=\/|$)/, homedir());

const at = (row, path) => path.reduce((value, key) => (value == null ? undefined : value[key]), row);

// The formula engine decides every test, from the bytes the Workshop ships.
const conditions = makeRowFilter({ operators, wasm: () => readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm'))) });
await conditions.load();

/** One test of the DATA files' shape: { path, equals | one_of | present | starts_with }, decided by the formula engine. */
export function holds(row, test) {
  return conditions.holdsNow(ruleTreeOfTests([test]), id => at(row, JSON.parse(id)));
}

/** Parsed rows from text that may start mid-line (a tail): unreadable lines are left out. */
export function rowsOf(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* the first line of a tail is cut; a torn last line is still being written */ }
  }
  return rows;
}

/**
 * What a chat's transcript says about its last turn, from its rows in order.
 * → null (no turn row: nothing to judge) | { finished: true, row } | { stopped: reason, row, resumes_at_ms | null }
 */
export function judge(rows, chat) {
  const last = rows.findLast(row => holds(row, chat.turn_row));
  if (!last) return null;
  const rule = chat.rows.find(item => item.when.every(test => holds(last, test)));
  if (!rule || rule.finished) return { finished: true, row: last };
  const stoppedMs = Date.parse(last.timestamp ?? '') || null;
  let resumesMs = null;
  if (rule.resumes_at) {
    const value = Number(at(last, rule.resumes_at.path));
    if (Number.isFinite(value) && value > 0) resumesMs = rule.resumes_at.unit === 'seconds' ? value * 1000 : value;
  } else if (rule.wait_minutes && stoppedMs) resumesMs = stoppedMs + rule.wait_minutes * 60_000;
  return { stopped: rule.stopped, row: last, resumes_at_ms: resumesMs };
}

function readRange(path, start, length) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const got = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, got).toString('utf8');
  } finally { closeSync(fd); }
}

/** The last turn row of a transcript, reading a larger tail when one row is longer than the first window. */
export function lastTurn(path, chat, rules, size = statSync(path).size) {
  for (let length = rules.tail_bytes; ; length *= 4) {
    const take = Math.min(size, length);
    const verdict = judge(rowsOf(readRange(path, size - take, take)), chat);
    if (verdict || take >= size || length >= rules.tail_bytes * 16) return verdict;
  }
}

/** The opening rows of a transcript: what decides skip_when and the first instructions. */
function headRows(path, rules) {
  return rowsOf(readRange(path, 0, Math.min(statSync(path).size, rules.head_bytes)));
}

const textOf = value => typeof value === 'string' ? value
  : Array.isArray(value) ? value.map(part => (typeof part === 'string' ? part : part?.text ?? '')).filter(Boolean).join('\n') : '';

function firstPrompt(rows, chat, chars) {
  const row = rows.find(item => holds(item, chat.first_prompt));
  return row ? textOf(at(row, chat.first_prompt.text_path)).slice(0, chars) : '';
}

/** Every file matched by a path given as segments, each a literal or a single-segment `*` pattern. */
export function filesOf(segments, { readDir = readdirSync } = {}) {
  let found = [expand(segments[0])];
  for (const part of segments.slice(1)) {
    const pattern = part.includes('*') ? new RegExp(`^${part.split('*').map(piece => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`) : null;
    const next = [];
    for (const folder of found) {
      if (!pattern) { next.push(join(folder, part)); continue; }
      let names = [];
      try { names = readDir(folder); } catch { continue; }
      for (const name of names) if (pattern.test(name)) next.push(join(folder, name));
    }
    found = next;
  }
  return found;
}

const statOf = path => { try { return statSync(path); } catch { return null; } };

/** When a transcript was last quiet: its last turn row's time, or its mtime when no turn row has a time. */
const quietOf = (verdict, stat) => Date.parse(verdict?.row?.timestamp ?? '') || stat.mtimeMs;

/** The key a transcript stop of this chat gets (the same key an older copy of this checker writes), or null. */
const turnKey = (source_id, verdict) => (verdict?.row?.timestamp ? `wake-stopped:${source_id}::${verdict.row.timestamp}` : null);

const processAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The live status files of one chat (one JSON per running process), each parsed; unreadable ones are left out. */
export function readLiveRows(live) {
  const rows = [];
  for (const file of filesOf(live.files)) {
    try { rows.push(JSON.parse(readFileSync(file, 'utf8'))); } catch { /* being written, or gone */ }
  }
  return rows;
}

/**
 * The live state of each session of a chat, by session id: { working } (never handed out), { stuck: { reason, since_ms } }
 * (handed out now as a stop), or { live } (alive and neither: the transcript is not judged). Dead pids are left out.
 */
export function liveStates(live, rows, { now, isAlive = processAlive }) {
  const states = new Map();
  for (const row of rows) {
    const session = at(row, live.session_path);
    const pid = at(row, live.pid_path);
    if (typeof session !== 'string' || !Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) continue;
    if ((live.working ?? []).some(test => holds(row, test))) { states.set(session, { working: true }); continue; }
    const since_ms = Number(at(row, live.since_path));
    const kindOk = !live.kinds || holds(row, live.kinds);
    const rule = kindOk ? (live.stuck ?? []).find(item => item.when.every(test => holds(row, test))) : undefined;
    if (rule && Number.isFinite(since_ms) && since_ms > 0 && now - since_ms >= rule.after_minutes * 60_000) {
      states.set(session, { stuck: { reason: fill(rule.stopped, { why: String(at(row, rule.why_path) ?? '') }), since_ms } });
    } else states.set(session, { live: true });
  }
  return states;
}

/** The messages waiting in a transcript: enqueued rows not matched by a later remove with the same text. */
export function pendingOf(rows, queued) {
  const waiting = [];
  for (const row of rows) {
    if (!holds(row, queued.row)) continue;
    const text = textOf(at(row, queued.text_path));
    if (holds(row, queued.enqueue)) waiting.push(text);
    else if (holds(row, queued.remove)) { const i = waiting.lastIndexOf(text); if (i >= 0) waiting.splice(i, 1); }
  }
  return waiting.length;
}

/** How many messages wait in a transcript, reading a larger tail as the window grows (as lastTurn does). */
export function queuedOf(path, rules, chat, size = statSync(path).size) {
  if (!chat.queued) return 0;
  for (let length = rules.tail_bytes; ; length *= 4) {
    const take = Math.min(size, length);
    const count = pendingOf(rowsOf(readRange(path, size - take, take)), chat.queued);
    if (take >= size || length >= rules.tail_bytes * 16) return count;
  }
}

/** Writes JSON through a part file and a rename, so a reader never sees half of it. */
function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const part = `${path}.${process.pid}.part`;
  writeFileSync(part, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(part, path);
}

/**
 * The stops to hand out now on this computer.
 * → [{ key, source_id, lane | null, reason, stopped_at, transcript, first_prompt, lanes? }]
 */
export function findStops(rules, { now = Date.now(), woken = {}, liveRows = readLiveRows, isAlive = processAlive } = {}) {
  const since = now - rules.look_back_hours * 3_600_000;
  const quietBefore = now - rules.quiet_minutes * 60_000;
  const stops = [];
  for (const chat of rules.chats) {
    const sessionPattern = new RegExp(chat.session_pattern);
    const lanePattern = chat.lane_pattern ? new RegExp(chat.lane_pattern) : null;
    const recent = filesOf(chat.transcripts).map(path => ({ path, stat: statOf(path) })).filter(item => item.stat?.isFile() && item.stat.mtimeMs >= since);
    // Each lane name's newest transcript on this computer, so a lane carried on elsewhere is left alone.
    const chats = [];
    const newestLane = new Map();
    for (const { path, stat } of recent) {
      const session = basename(path).match(sessionPattern)?.[1];
      if (!session) continue;
      const lanes = [];
      if (chat.lanes_folder && lanePattern) {
        const folder = join(dirname(path), ...chat.lanes_folder.map(part => part.replace('{session}', session)));
        let names = [];
        try { names = readdirSync(folder); } catch { /* a chat with no lanes */ }
        for (const name of names) {
          const lane = name.match(lanePattern)?.[1];
          const laneStat = lane ? statOf(join(folder, name)) : null;
          if (!laneStat?.isFile()) continue;
          lanes.push({ name: lane, path: join(folder, name), stat: laneStat });
          if ((newestLane.get(lane) ?? 0) < laneStat.mtimeMs) newestLane.set(lane, laneStat.mtimeMs);
        }
      }
      chats.push({ path, stat, session, lanes });
    }
    const liveOf = chat.live ? liveStates(chat.live, liveRows(chat.live), { now, isAlive }) : new Map();
    for (const item of chats) {
      const source_id = `${chat.source_prefix}${item.session}`;
      const head = headRows(item.path, rules);
      if (chat.skip_when.some(test => head.some(row => holds(row, test)))) continue;
      // A live session is judged by its live status file, never by its transcript: busy or alive-and-not-stuck is left alone.
      const live = liveOf.get(item.session);
      if (live?.working || live?.live) continue;
      if (live?.stuck) {
        const sinceIso = new Date(live.stuck.since_ms).toISOString();
        stops.push({ key: `wake-stopped:${source_id}::stuck:${sinceIso}`, source_id, lane: null, reason: live.stuck.reason, stopped_at: sinceIso,
          transcript: item.path, first_prompt: '', lanes: [], stuck: true, queued_messages: queuedOf(item.path, rules, chat),
          transcript_key: turnKey(source_id, lastTurn(item.path, chat, rules, item.stat.size)) });
        continue;
      }
      const verdict = lastTurn(item.path, chat, rules, item.stat.size);
      const laneVerdicts = item.lanes.map(lane => lastTurn(lane.path, chat, rules, lane.stat.size));
      const quietMs = Math.max(quietOf(verdict, item.stat), ...item.lanes.map((lane, i) => quietOf(laneVerdicts[i], lane.stat)));
      if (quietMs > quietBefore) continue;
      const ready = verdict => verdict?.stopped && (verdict.resumes_at_ms ?? 0) + rules.after_reset_minutes * 60_000 <= now;
      const stopOf = (verdict, path, lane, first_prompt) => {
        const stopped_at = verdict.row.timestamp ?? new Date(statOf(path)?.mtimeMs ?? now).toISOString();
        return { key: `wake-stopped:${source_id}:${lane ?? ''}:${stopped_at}`, source_id, lane, reason: verdict.stopped, stopped_at, transcript: path, first_prompt,
          queued_messages: queuedOf(path, rules, chat) };
      };
      const laneStops = [];
      for (const [i, lane] of item.lanes.entries()) {
        if (lane.stat.mtimeMs < since || newestLane.get(lane.name) > lane.stat.mtimeMs) continue;
        const laneVerdict = laneVerdicts[i];
        if (!ready(laneVerdict)) continue;
        laneStops.push(stopOf(laneVerdict, lane.path, lane.name, firstPrompt(headRows(lane.path, rules), chat, rules.first_prompt_chars)));
      }
      if (ready(verdict)) stops.push({ ...stopOf(verdict, item.path, null, ''), lanes: laneStops.map(stop => stop.lane) });
      stops.push(...laneStops);
    }
  }
  return stops.filter(stop => !woken[stop.key]);
}

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole));

/** The hand_off body for one stop, every word from the DATA file. */
export function handOffOf(stop, rules, { hosted = [] } = {}) {
  const values = { ...stop, lane: stop.lane ?? '', lanes: (stop.lanes ?? []).join(', ') };
  values.queued_line = stop.queued_messages > 0 ? fill(rules.queued_line, values) : '';
  // A stuck chat cannot take its own job: no to_agent, no prefer, so any AI takes it at once.
  if (stop.stuck) return { job: fill(rules.stuck_job, values), said: fill(rules.chat_said, values), once_per: stop.key };
  if (stop.lane) {
    return { job: fill(rules.lane_job, values), said: fill(rules.lane_said, values), once_per: stop.key,
      to_agent: stop.lane, target: { prefer_minutes: rules.lane_prefer_minutes } };
  }
  values.lanes_line = stop.lanes?.length ? fill(rules.chat_lanes_line, values) : '';
  const agent = hosted.find(row => row.source_id === stop.source_id)?.agent_id;
  return { job: fill(rules.chat_job, values), said: fill(rules.chat_said, values), once_per: stop.key,
    // The stopped chat keeps no turn of its own (src/agents.mjs anyoneFrom): unless it is hosted here and given back to
    // itself first, any AI may take its job at once.
    input: { arrived: { source_id: stop.source_id, chat_silence_minutes: rules.stopped_chat_silence_minutes } },
    ...(agent ? { to_agent: agent, target: { prefer_minutes: rules.chat_prefer_minutes } } : {}) };
}

function readWoken(rules, now) {
  let kept = {};
  try { kept = JSON.parse(readFileSync(expand(rules.state_file), 'utf8')); } catch { /* none yet, or unreadable: start empty */ }
  const keepAfter = now - rules.keep_woken_days * 86_400_000;
  return Object.fromEntries(Object.entries(kept).filter(([, row]) => Date.parse(row.at) >= keepAfter));
}

function writeWoken(rules, woken) {
  writeAtomic(expand(rules.state_file), woken);
}

/**
 * One check: find the stops, hand each out once, remember the ones Trillion accepted.
 * → { found, handed: [{ key, handoff_id }], refused: [{ key, error }] }
 */
export async function check({ call, rules = readRules(), now = Date.now(), hosted = [], dry = false, log = () => {} }) {
  const woken = readWoken(rules, now);
  const found = findStops(rules, { now });
  const stops = found.filter(stop => !woken[stop.key]).slice(0, rules.most_per_check);
  const handed = [];
  const refused = [];
  for (const stop of stops) {
    if (dry) { handed.push({ key: stop.key, dry: true, said: handOffOf(stop, rules, { hosted }).said }); continue; }
    const body = handOffOf(stop, rules, { hosted });
    let answer;
    try { answer = await call('/handoffs', body); }
    catch (error) {
      // A lane name nobody published cannot be preferred; the same job goes to any AI.
      if (body.to_agent && stop.lane) {
        try { answer = await call('/handoffs', { ...body, to_agent: undefined, target: undefined }); }
        catch (again) { refused.push({ key: stop.key, error: again.message }); continue; }
      } else { refused.push({ key: stop.key, error: error.message }); continue; }
    }
    const handoff_id = answer?.handoff?.handoff_id ?? answer?.handoff_id ?? null;
    const record = { at: new Date(now).toISOString(), handoff_id, source_id: stop.source_id, lane: stop.lane, reason: stop.reason };
    woken[stop.key] = record;
    // A stuck stop is also recorded under the transcript key an older copy of this checker uses, so that copy never doubles the job.
    if (stop.transcript_key) woken[stop.transcript_key] = record;
    handed.push({ key: stop.key, handoff_id });
  }
  if (!dry && handed.length) writeWoken(rules, woken);
  // Every stop found this check, handed out now or earlier, so the live count is readable from one file.
  const stuck = found.map(stop => ({ source_id: stop.source_id, state: stop.stuck ? 'stuck' : 'stopped', reason: stop.reason, since: stop.stopped_at,
    queued_messages: stop.queued_messages, handoff_id: woken[stop.key]?.handoff_id ?? null }));
  if (!dry) writeAtomic(expand(rules.stuck_file), { checked_at: new Date(now).toISOString(), chats: stuck });
  if (stops.length) log(`wake-stopped-chats: ${stops.length} stopped, ${handed.length} handed out${refused.length ? `, ${refused.length} refused (${refused[0].error})` : ''}`);
  return { found: stops.length, handed, refused, stuck };
}

export const wants = () => false;
export const handle = () => null;

let timer = null;
export const start = ({ key, origin, rules: helperRules, log = () => {} }) => {
  const rules = readRules();
  const call = accountCaller(origin ?? helperRules.origin, key);
  const hostedOf = () => {
    try { return Object.values(JSON.parse(readFileSync(join(expand(helperRules.folder), helperRules.hosted_file), 'utf8')).sessions ?? {}); }
    catch { return []; }
  };
  let running = null;
  const pass = () => {
    if (running) return running;
    running = check({ call, rules: readRules(), hosted: hostedOf(), log })
      .catch(error => log(`wake-stopped-chats: the check did not finish: ${error.message}`))
      .finally(() => { running = null; });
    return running;
  };
  clearInterval(timer);
  pass();
  timer = setInterval(pass, rules.check_every_minutes * 60_000);
  timer.unref?.();
  return timer;
};

// node harness/wake-handlers/wake-stopped-chats.mjs --dry   lists what the next check would hand out, and hands out nothing.
const isEntryScript = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntryScript()) {
  const result = await check({ call: null, dry: true, log: line => process.stderr.write(`${line}\n`) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
