// packages/ai-tool-catalog/do-work/probe-jobs-through-public-tools.mjs
//
// PURPOSE
//   Asks an outside agent to do real jobs using ONLY the public tool servers,
//   and records every job it could not finish as a capability gap naming the
//   missing tool. The jobs, the agent command and the servers it may use are all
//   DATA (`job-probe` and `job-probe-harness-selection` records). The reusable
//   executable harness lives in this package. A failure is the finding:
//   it says which tool the Workshop still lacks.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a job, a person, a server, a vendor or a model. They come
//      from the records passed in.
//   2. The agent gets the named servers, plus any server its own account connects that the harness names by
//      tool prefix (`account_tool_prefixes`), and may call no other tool. Server definitions are read by NAME
//      from the harness's own config file, so no path or secret enters DATA or argv
//      beyond what that config already holds.
//   3. A job whose `effect` is not `read` must stop before the last call that would
//      change anything outside (post, publish, book, pay, send) and report whether
//      that call exists and would accept its arguments. The probe never publishes.
//   4. An agent reply that cannot be parsed is a gap with status `unreadable`,
//      never a pass.
//
// USE
//   node probe-jobs-through-public-tools.mjs --records <records.json> [--records <more.json>] --out <result.json> [--only <probe id>]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const RULES = `You are testing whether a real person's request can be done with the tools you have.
Use ONLY the tools available to you. Do not guess results and do not invent data.
If the request would change anything outside (post, publish, schedule, book, pay, send a message), go right up to the final call: find the tool, prepare valid arguments, and STOP without making that final call.
When you finish, end your reply with ONE line of JSON and nothing after it:
{"status":"done"|"partial"|"gap","tools_used":["tool names"],"missing_tools":[{"name":"a short name for the tool that would be needed","does":"what it would do"}],"evidence":"one or two sentences of what you actually saw"}
"done" means the request was fully satisfied (or, for an outside change, the final tool exists and accepted valid arguments). "partial" means some of it. "gap" means the tools cannot do it.`;

export function readRecords(files) {
  const payloads = [];
  const ownerManifest = path.join(path.dirname(fileURLToPath(import.meta.url)), '../things-to-store-and-run.json');
  const owner = JSON.parse(fs.readFileSync(ownerManifest, 'utf8'));
  for (const thing of owner.things || []) if (thing?.payload?.kind === 'job-probe-harness') payloads.push(thing.payload);
  for (const file of files) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const record of doc.records || []) if (record?.payload?.kind) payloads.push(record.payload);
  }
  const harnesses = payloads.filter(p => p.kind === 'job-probe-harness');
  const selections = payloads.filter(p => p.kind === 'job-probe-harness-selection');
  const jobs = payloads.filter(p => p.kind === 'job-probe');
  if (harnesses.length !== 1) throw new Error(`Expected exactly one job-probe-harness record, found ${harnesses.length}.`);
  if (selections.length !== 1 || selections[0].id !== harnesses[0].id) throw new Error('Expected one matching job-probe-harness-selection record.');
  for (const job of jobs) if (typeof job.id !== 'string' || typeof job.request !== 'string' || !job.request.trim()) throw new Error(`A job-probe record needs an id and a request: ${JSON.stringify(job).slice(0, 200)}`);
  return {harness: {...harnesses[0], ...selections[0], kind: 'job-probe-harness'}, jobs};
}

function readPointer(value, pointer) {
  return pointer.split('/').slice(1).reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], value);
}

export function serverConfigFor(harness, home = os.homedir()) {
  const source = harness.server_config_source;
  const all = readPointer(JSON.parse(fs.readFileSync(path.join(home, source.home_relative_file), 'utf8')), source.pointer) || {};
  const chosen = {};
  for (const name of harness.servers) {
    if (!all[name]) throw new Error(`The tool server "${name}" is not registered in ${source.home_relative_file}.`);
    chosen[name] = all[name];
  }
  return {mcpServers: chosen};
}

export function buildArgv(harness, fills) {
  return harness.argv.map(part => {
    if (typeof part === 'string') return part;
    if (!(part.fill in fills)) throw new Error(`The harness asks for "${part.fill}", which the probe does not supply.`);
    return fills[part.fill];
  });
}

export function lastJsonLine(text) {
  const lines = String(text || '').trim().split('\n').reverse();
  for (const line of lines) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    try { return JSON.parse(line.slice(start)); } catch {}
  }
  return null;
}

function runOne(harness, job, serverConfig) {
  const prompt = `${RULES}\n\nThis request's effect: ${job.effect || 'read'}.\n\nRequest: ${job.request}`;
  // Servers the agent's own account already connects (signed in there) are allowed by their tool prefix; they are
  // not passed in the server config, because the account supplies them.
  const allowed = [...harness.servers.map(name => `${harness.allowed_tool_prefix}${name}`), ...(harness.account_tool_prefixes || [])].join(',');
  const argv = buildArgv(harness, {prompt, server_config: JSON.stringify(serverConfig), allowed_tools: allowed});
  const cwd = harness.working_directory === 'home' ? os.homedir() : process.cwd();
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(harness.command, argv, {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), (harness.timeout_seconds || 600) * 1000);
    child.on('close', code => {
      clearTimeout(timer);
      let text = out;
      if (harness.reply?.format === 'json') { try { text = readPointer(JSON.parse(out), harness.reply.text_pointer); } catch { text = out; } }
      const verdict = lastJsonLine(text);
      resolve({
        kind: 'capability-gap-observation',
        probe_id: job.id,
        request: job.request,
        effect: job.effect || 'read',
        pursuits: job.pursuits || [],
        status: verdict?.status || 'unreadable',
        tools_used: verdict?.tools_used || [],
        missing_tools: verdict?.missing_tools || [],
        evidence: verdict?.evidence || (String(text || err).slice(-600)),
        exit_code: code,
        seconds: Math.round((Date.now() - started) / 1000),
        observed_at: new Date().toISOString(),
      });
    });
  });
}

export async function probeJobs({harness, jobs, home}) {
  const serverConfig = serverConfigFor(harness, home);
  const results = [];
  const queue = [...jobs];
  const workers = Array.from({length: Math.max(1, harness.concurrency || 1)}, async () => {
    while (queue.length) {
      const job = queue.shift();
      const result = await runOne(harness, job, serverConfig);
      results.push(result);
      process.stderr.write(`${result.status.padEnd(10)} ${job.id} (${result.seconds}s)\n`);
    }
  });
  await Promise.all(workers);
  return jobs.map(job => results.find(result => result.probe_id === job.id));
}

async function main() {
  const args = process.argv.slice(2);
  const files = [], only = [];
  let out = null;
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === '--records') files.push(args[index + 1]);
    else if (args[index] === '--out') out = args[index + 1];
    else if (args[index] === '--only') only.push(args[index + 1]);
    else throw new Error(`Unknown option ${args[index]}. Use --records, --out, --only.`);
  }
  if (!files.length || !out) throw new Error('Give --records <file> and --out <file>.');
  const {harness, jobs} = readRecords(files);
  const chosen = only.length ? jobs.filter(job => only.includes(job.id)) : jobs;
  const observations = await probeJobs({harness, jobs: chosen});
  const summary = {
    kind: 'capability-gap-run',
    harness: harness.id,
    servers: harness.servers,
    ran_at: new Date().toISOString(),
    counts: observations.reduce((acc, item) => ({...acc, [item.status]: (acc[item.status] || 0) + 1}), {}),
    observations,
  };
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(JSON.stringify(summary.counts) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { process.stderr.write(error.message + '\n'); process.exit(1); });
