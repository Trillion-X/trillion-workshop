// Final-answer checks survive a busy account. The existing session helper replays them when its stream reconnects
// or pings. One queued request keeps its event key; a later explicit recheck gets
// a fresh key if an earlier delivery was refused.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const sourceReturnFolder = () => join(homedir(), '.trillion', 'source-return-pending');
const valid = item => /^h_[A-Za-z0-9]+$/.test(item?.handoff_id)
  && /^(?:codex|claude-code):[0-9a-f-]{36}$/.test(item?.source_id)
  && /^[A-Za-z0-9_-]{1,100}$/.test(item?.transcript_message_id)
  && typeof item?.text === 'string';
const nameOf = item => `${item.handoff_id}-${item.transcript_message_id}.json`;

export function queueSourceReturnCandidates(candidates, folder = sourceReturnFolder()) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  let queued = 0;
  for (const item of Array.isArray(candidates) ? candidates.slice(0, 10) : []) {
    if (!valid(item)) continue;
    if (existsSync(join(folder, nameOf(item)))) { queued += 1; continue; }
    const request = { ...item, request_id: randomUUID() };
    const temp = join(folder, `${nameOf(item)}.${randomUUID()}.tmp`);
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(request)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, join(folder, nameOf(item)));
    const directory = openSync(folder, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
    queued += 1;
  }
  return queued;
}

// The checks due now (a check put off by deferSourceReturnCandidate waits for its next_check_at), at most ten.
export function pendingSourceReturnCandidates(folder = sourceReturnFolder(), now = Date.now()) {
  let names;
  try { names = readdirSync(folder).filter(name => /^h_[A-Za-z0-9]+-[A-Za-z0-9_-]{1,100}\.json$/.test(name)).sort(); }
  catch { return []; }
  const due = [];
  for (const name of names) {
    if (due.length === 10) break;
    try {
      const item = JSON.parse(readFileSync(join(folder, name), 'utf8'));
      if (valid(item) && nameOf(item) === name && !(Date.parse(item.next_check_at) > now)) due.push({ ...item, file: join(folder, name) });
    } catch { /* unreadable: skipped */ }
  }
  return due;
}

export function completeSourceReturnCandidate(file) { unlinkSync(file); }

// A check that cannot be sent yet (its handoff is not finished, or the account was busy) waits the next of
// `recheckMinutes` before it is read again, and is dropped after the last: one that never settles is never read
// again and again (on 2026-10-03 155 stuck checks were re-read by every Stop of every chat).
export function deferSourceReturnCandidate(file, { recheckMinutes, now = Date.now() }) {
  let item;
  try { item = JSON.parse(readFileSync(file, 'utf8')); } catch { return 'gone'; }
  const checks = (Number.isInteger(item.checks) ? item.checks : 0) + 1;
  if (checks > recheckMinutes.length) { try { unlinkSync(file); } catch { /* already gone */ } return 'given-up'; }
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify({ ...item, checks, next_check_at: new Date(now + recheckMinutes[checks - 1] * 60_000).toISOString() }), { mode: 0o600 });
  renameSync(temp, file);
  return 'deferred';
}
export function hasPendingSourceReturns(folder = sourceReturnFolder()) { return pendingSourceReturnCandidates(folder).length > 0; }
