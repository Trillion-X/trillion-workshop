// computer/model-helper.mjs
//
// Purpose
//   Runs heavy on-device AI (a model that removes a background, sharpens a picture, finds landmarks) in a helper process of
//   its own, so the app carries none of its entitlements or memory. The job's tiers are DATA (computer/model-helper.json):
//   the most capable tier this Mac meets is chosen, its runner and model bundle are fetched on first use and checked against
//   their pinned hash by the helper owner (computer/helper-runtimes.mjs), and the runner is started with only the
//   environment variables the DATA lists.
//
// Non-negotiable invariants
//   1. Blind: no job, tier, helper or program is named here; they are rows. With no rows nothing runs.
//   2. The tier is chosen from this Mac (memory, arch), best first; a Mac below every tier is told so with the numbers, and
//      nothing is fetched for it.
//   3. The helper runs as its own process with a fixed environment, a time limit and a cap on what it may print; a failure
//      is returned in words, never thrown at the caller as a stack.
//   4. Bytes come only from the helper owner, which refuses anything that does not match its pin.
//
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { makeHelperRuntimes } from './helper-runtimes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
export const modelHelperSettings = () => JSON.parse(readFileSync(join(HERE, 'model-helper.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const gb = bytes => Math.floor(bytes / 2 ** 30);

/** The first tier of the job this Mac meets, or null. */
export const tierFor = (job, { memoryGb, arch }) => job.tiers.find(tier => memoryGb >= tier.min_memory_gb && (!tier.arch || tier.arch === arch)) ?? null;

export function makeModelHelper({ settings = modelHelperSettings(), helpers = makeHelperRuntimes(), memory = totalmem, arch = process.arch, run = exec } = {}) {
  return {
    /** The jobs this Mac could run, each with the tier it would use. */
    list() {
      const here = { memoryGb: gb(memory()), arch };
      return { jobs: settings.jobs.map(job => ({ id: job.id, what: job.what, tier: tierFor(job, here)?.id ?? null })), said: settings.jobs.length ? null : settings.words.no_jobs };
    },
    async runJob({ job: id, input, output } = {}) {
      const job = settings.jobs.find(row => row.id === id);
      if (!job) throw Object.assign(new Error(fill(settings.words.unknown_job, { id, ids: settings.jobs.map(row => row.id).join(', ') || 'none' })), { status: 404 });
      if (typeof input !== 'string' || !input) throw Object.assign(new Error(settings.words.needs_input), { status: 400 });
      const here = { memoryGb: gb(memory()), arch };
      const tier = tierFor(job, here);
      if (!tier) return { job: id, ran: false, tier: null, said: fill(settings.words.no_tier, { id, memory_gb: here.memoryGb, arch, need_gb: Math.min(...job.tiers.map(row => row.min_memory_gb)) }) };
      try {
        const runner = await helpers.ensure({ id: tier.runner });
        const bundle = await helpers.ensure({ id: tier.bundle });
        const env = Object.fromEntries(settings.env.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
        const { stdout } = await run(runner.path, [dirname(bundle.path), input, ...(output ? [output] : [])], { env, timeout: settings.timeout_seconds * 1000, maxBuffer: settings.max_output_bytes });
        return { job: id, ran: true, tier: tier.id, output: output ?? null, result: stdout.trim() || null, said: fill(settings.words.ran, { id, tier: tier.id }) };
      } catch (error) {
        return { job: id, ran: false, tier: tier.id, said: fill(settings.words.failed, { id, why: String(error?.message ?? error).split('\n')[0].slice(0, 300) }) };
      }
    },
  };
}

let shared = null;
const managerHere = () => (shared ??= makeModelHelper());

/** The tool the Mac runs (computer/mac-tools.json): `jobs` lists what this Mac can run; `run` does one job. */
export const modelHelperTools = {
  async jobs() { return managerHere().list(); },
  async run(input) { return managerHere().runJob(input); },
};
