// computer/supervised-run.mjs
//
// PURPOSE
//   Runs long, heavy automation (a load test, a batch render, a crawl) as a process of its own that this module supervises, so
//   a hang or a flood of output never stops the host that asked and the Mac does not sleep in the middle of it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: how a run is supervised is a `classes` row in computer/supervised-run.json; this file names no program of work.
//   2. A wall clock on every run: past it the process is asked to stop, then killed after the class's grace.
//   3. Sleep prevention is tied to the process: the keep-awake helper is started with the process id it waits on (`caffeinate -w`), so it
//      ends when the process ends, however it ends, and is stopped here if the process cannot be waited on.
//   4. Output is bounded: only the last `output_bytes` of each stream are kept, and the answer says it was cut.
//   5. argv is an array (never shell text), and the environment is the caller's explicit one.
//
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const supervisedSettings = () => JSON.parse(readFileSync(join(HERE, 'supervised-run.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

class Tail {
  constructor(limit) { this.limit = limit; this.chunks = []; this.size = 0; this.cut = false; }
  add(piece) {
    this.chunks.push(piece); this.size += piece.length;
    while (this.size > this.limit && this.chunks.length) {
      const overflow = this.size - this.limit;
      if (this.chunks[0].length <= overflow) { this.size -= this.chunks.shift().length; } else { this.chunks[0] = this.chunks[0].subarray(overflow); this.size -= overflow; }
      this.cut = true;
    }
  }
  text() { return Buffer.concat(this.chunks).toString('utf8'); }
}

/** Runs argv under a class; resolves { code, signal, timed_out, stdout, stderr, cut, kept_awake, ms, pid }. onStart(pid) is told once the process lives. */
export function runSupervised({ argv, cwd, env = {}, class: className = 'heavy', settings = supervisedSettings(), onStart = () => {} } = {}) {
  const row = Object.hasOwn(settings.classes, className) ? settings.classes[className] : null;
  if (!row) return Promise.reject(Object.assign(new Error(fill(settings.words.unknown_class, { class: className, known: Object.keys(settings.classes).join(', ') })), { status: 400, retry: false }));
  if (!Array.isArray(argv) || !argv.length || !argv.every(part => typeof part === 'string')) return Promise.reject(Object.assign(new Error(settings.words.needs_argv), { status: 400, retry: false }));
  return new Promise((done, fail) => {
    const began = Date.now();
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = new Tail(row.output_bytes);
    const err = new Tail(row.output_bytes);
    child.stdout.on('data', piece => out.add(piece));
    child.stderr.on('data', piece => err.add(piece));
    let awake = null;
    let timedOut = false;
    let killer = null;
    child.on('error', error => { clearTimeout(timer); awake?.kill(); fail(Object.assign(new Error(fill(settings.words.failed_to_start, { error: error.message })), { status: 502, retry: true })); });
    child.on('spawn', () => {
      if (row.prevent_sleep && child.pid) {
        awake = spawn(settings.keep_awake.program, settings.keep_awake.args.map(arg => fill(arg, { pid: child.pid })), { stdio: 'ignore' });
        awake.on('error', () => { awake = null; });
      }
      onStart(child.pid);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killer = setTimeout(() => child.kill('SIGKILL'), row.stop_grace_ms);
    }, row.timeout_ms);
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(killer);
      awake?.kill();
      done({ code, signal, timed_out: timedOut, stdout: out.text(), stderr: err.text(), cut: out.cut || err.cut, kept_awake: Boolean(row.prevent_sleep), ms: Date.now() - began,
        ...(timedOut ? { said: fill(settings.words.timed_out, { ms: row.timeout_ms }) } : {}) });
    });
  });
}
