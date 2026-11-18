// src/dead-end-search.mjs
//
// A SEARCH THAT FINDS NOTHING IS A DEAD END: the job it asked for is what the person's own product does not cover yet.
// This file is the rule only, values in and values out: which answer is a dead end, what job it counts as, and the
// one record name a job is kept under. The record itself (the job, how many times it was asked, first and last time,
// the refresh window and the sweep) is kept in the person's own store by workflow:keep-a-search-that-found-no-tool
// (tools/workflows/recipes/keep-a-search-that-found-no-tool.json), so no store is named here.
//
// Non-negotiable invariants:
//   1. The shortest job worth keeping, the cut, the ignored jobs and the words are DATA (./dead-end-search.json).
//   2. Only an answer with an empty `candidates` list is a dead end; an answer that failed, or one holding anything, is not.
//   3. The same job is one record (its BLAKE3 name, deadEndName): asking again counts up in the store.
//   4. The job is the AI's own description of the job, kept as a job, never as the person's words.
//
// Values in, values out:
//   deadEndJob(sent, reply)  -> the job to keep, or '' when the answer is not a dead end or the job is too short or ignored
//   deadEndName(job)         -> the record name for that job: the name prefix and the BLAKE3 identity of the job
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import rulesData from './dead-end-search.json' with { type: 'json' };

export const deadEndName = job => `${rulesData.name_prefix}${bytesToHex(blake3(new TextEncoder().encode(job))).slice(0, 32)}`;

/** The job a search asked for, tidied, or '' when it is too short to keep or is one the rules ignore. */
export function deadEndJob(sent, reply, rules = rulesData) {
  if (!Array.isArray(reply?.candidates) || reply.candidates.length > 0) return '';
  const job = typeof sent?.job === 'string' ? sent.job.trim().replace(/\s+/gu, ' ').slice(0, rules.most_job_characters) : '';
  return job.length < rules.min_characters || rules.ignore.includes(job.toLowerCase()) ? '' : job;
}
