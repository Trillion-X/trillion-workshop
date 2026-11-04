// tools/keep-a-long-job-resumable/read-data/durable-job.mjs
//
// Purpose
//   Long local jobs (a meeting summary, a transcription) that are accepted with a key, announce a stream address with
//   an expiry, keep their output so far, and can be resumed from a cursor or cancelled by id by any client, so a
//   closed laptop neither loses nor duplicates the work. tool:job runs it on the person's computer:
//
//   node /opt/records-door/do-work/run-an-export.mjs /opt/keep-a-long-job-resumable/read-data/durable-job.mjs job
//
//   with { input, folder } on standard input, `folder` being the folder the person granted (change-a-folder).
//
// Non-negotiable invariants
//   1. Starting with a key already used returns that job (same id, same stream, same seed): never a second job and
//      never a changed seed or version.
//   2. Output is append-only and numbered; reading from a cursor returns exactly the pieces after it, so resuming
//      twice from the same place gives the same pieces.
//   3. A finished, cancelled or expired job takes no more output, and says which; an expired job's stream is not readable.
//   4. Limits, expiry, states, stream address and words are DATA (durable-job.json). Ids are BLAKE3 of the key.
//
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

/** BLAKE3-256 of the bytes as 64 hex digits, from the one content-identity owner (its `1f:` prefix dropped). */
const blake3Hex = bytes => makeHashCodeHexFromBytes(bytes).slice(3);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const expand = (place, home = os.homedir()) => String(place).replace(/^~(?=\/|$)/, home);
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
export const jobSettings = () => JSON.parse(readFileSync(path.join(HERE, 'durable-job.json'), 'utf8'));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function createJobs({ settings = jobSettings(), file = expand(settings.file), now = () => Date.now() } = {}) {
  const load = () => { try { const jobs = JSON.parse(readFileSync(file, 'utf8')).jobs; return Array.isArray(jobs) ? jobs : []; } catch { return []; } };
  const save = jobs => { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(`${file}.part`, `${JSON.stringify({ jobs }, null, 1)}\n`, { mode: 0o600 }); renameSync(`${file}.part`, file); };
  const stateOf = job => (job.state === settings.states.running && now() > job.expires_at ? settings.states.expired : job.state);
  const view = job => ({ id: job.id, state: stateOf(job), stream_url: fill(settings.stream_url, { id: job.id }), expires_at: new Date(job.expires_at).toISOString(), seed: job.seed, version: job.version, chunks: job.chunks.length });
  const find = id => { const job = load().find(entry => entry.id === id); if (!job) throw fail(fill(settings.words.no_job, { id }), 404); return job; };
  const put = job => save(load().map(entry => (entry.id === job.id ? job : entry)));
  return {
    start({ key, seed = null, version = 1 }) {
      if (!String(key ?? '').trim()) throw fail(settings.words.needs_key);
      const id = blake3Hex(new TextEncoder().encode(JSON.stringify(['job', key]))).slice(0, 16);
      const found = load().find(entry => entry.id === id);
      if (found) return view(found);
      const job = { id, key, seed, version, state: settings.states.running, chunks: [], expires_at: now() + settings.ttl_seconds * 1000 };
      save([...load(), job].slice(-settings.most_jobs));
      return view(job);
    },
    append(id, piece) {
      const job = find(id); const state = stateOf(job);
      if (state !== settings.states.running) throw fail(fill(settings.words.finished, { id, state }), 409);
      job.chunks = [...job.chunks, piece].slice(-settings.most_chunks);
      job.seq = (job.seq ?? 0) + 1; job.chunk_seqs = [...(job.chunk_seqs ?? []), job.seq].slice(-settings.most_chunks);
      job.expires_at = now() + settings.ttl_seconds * 1000; put(job); return job.seq;
    },
    finish(id) { const job = find(id); if (stateOf(job) === settings.states.running) { job.state = settings.states.done; put(job); } return view(job); },
    cancel(id) { const job = find(id); if (stateOf(job) === settings.states.running) { job.state = settings.states.cancelled; put(job); } return view(job); },
    /** The pieces after `cursor` (0 for all): { job, pieces: [{ seq, piece }], cursor }. An expired job's stream is not readable. */
    read(id, cursor = 0) {
      const job = find(id); const state = stateOf(job);
      if (state === settings.states.expired) throw fail(fill(settings.words.finished, { id, state }), 410);
      const pieces = job.chunks.map((piece, index) => ({ seq: job.chunk_seqs[index], piece })).filter(entry => entry.seq > cursor);
      return { job: view(job), pieces, cursor: pieces.at(-1)?.seq ?? cursor };
    },
    list: () => load().map(view),
  };
}

export const jobTools = {
  /** { action: start | append | read | finish | cancel | list, key?, id?, seed?, version?, piece?, cursor? } */
  async job(input, { file } = {}) {
    const jobs = createJobs(file ? { file } : {});
    switch (input.action ?? 'list') {
      case 'start': return jobs.start(input);
      case 'append': return { seq: jobs.append(input.id, input.piece) };
      case 'read': return jobs.read(input.id, input.cursor ?? 0);
      case 'finish': return jobs.finish(input.id);
      case 'cancel': return jobs.cancel(input.id);
      default: return { jobs: jobs.list() };
    }
  },
};

/** tool:job as one export for run-an-export: { input, folder } -> the answer of jobTools.job, the jobs file kept in the granted folder. */
export async function job({ input = {}, folder } = {}) {
  if (!String(folder ?? '').trim()) throw fail('Grant a folder to keep the jobs in (change-a-folder).');
  return jobTools.job(input, { file: path.join(folder, jobSettings().file) });
}
