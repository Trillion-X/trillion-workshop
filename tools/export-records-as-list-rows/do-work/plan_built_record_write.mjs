// Plan the writes for the records tool:build-records-to-write made, against the target records the person's store holds now.
// Nothing is read from or written to a store here: the caller's AI writes each returned command into its own store, then calls
// again with mode "readback" and the target records the store holds afterwards. The planner is read-data/record_write_plan.py,
// run by do-work/plan_record_write.py; this file only hands it the input and returns its answer.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const planner = fileURLToPath(new URL('./plan_record_write.py', import.meta.url));

function runPlanner(mode, request) {
  return new Promise((resolve, reject) => {
    // `python3` from the computer's own path, on every computer, as the builder starts it.
    const child = spawn('python3', ['-I', planner, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', bytes => stdout.push(bytes));
    child.stderr.on('data', bytes => stderr.push(bytes));
    child.on('error', error => reject(new Error(error.code === 'ENOENT'
      ? 'This computer has no python3 on its path; give the run Python 3.10 or newer as python3 to plan writes.'
      : `Could not run the write planner (${error.code ?? error.name}).`)));
    child.stdin.on('error', () => {}); // A refusal is reported by its exit status and stderr, without echoing the input.
    child.on('close', code => {
      // Exit 1 is a readback that differs: its answer is still the result.
      if (code !== 0 && code !== 1) return reject(new Error(Buffer.concat(stderr).toString('utf8').slice(-600) || `The write planner exited ${code}.`));
      try { resolve(JSON.parse(Buffer.concat(stdout).toString('utf8'))); } catch { reject(new Error('The write planner did not return JSON.')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/**
 * input: { mode: "plan" | "readback" (default plan), payload, target_type, target_prefix, held: [{ id, type, value }], config, baseline? }
 * config: { per_command, command_bytes, request_key_prefix, keep_held? }. Returns the planner's answer.
 */
export async function planBuiltRecordWrite(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Give the input object: payload, target_type, target_prefix, held and config.');
  const mode = input.mode ?? 'plan';
  if (mode !== 'plan' && mode !== 'readback') throw new Error('mode is plan (what to write) or readback (what the store holds after the writes).');
  if (!input.payload) throw new Error('Give the records builder result as payload.');
  if (typeof input.target_type !== 'string' || !input.target_type || typeof input.target_prefix !== 'string' || !input.target_prefix) {
    throw new Error('Give the exact target_type and target_prefix this run is for.');
  }
  if (!Array.isArray(input.held)) throw new Error('held is a list of { id, type, value } records: the target records your store holds now, read by your AI from that store.');
  if (!input.config || typeof input.config !== 'object') throw new Error('Give the config: per_command, command_bytes and request_key_prefix.');
  const request = {
    payload: input.payload, target_type: input.target_type, target_prefix: input.target_prefix, held: input.held, config: input.config,
    ...(input.baseline !== undefined ? { baseline: input.baseline } : {}),
  };
  return runPlanner(mode, request);
}
