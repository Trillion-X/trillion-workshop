// A generic app job on this Mac. App operations remain owned by the app's MCP server in apps-here.json;
// this host checks the installed-app row, resolves declared files, calls that server, and keeps requested outputs.
import { chmodSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { appsHere, appRow, openAppQuietly, runningPrograms, withAppSession } from '../media-composition/do-work/use-an-app-here.mjs';
import { bearerControl, namespaceClient } from '../browse-and-upload-my-files/do-work/namespace-client.mjs';
import { loadChunking } from '../browse-and-upload-my-files/do-work/content-chunks.mjs';
import { fileSource, sendFile } from '../browse-and-upload-my-files/do-work/send-a-file-to-a-namespace.mjs';
import { LOOKS } from './computer-sources.mjs';
import { sharedReference } from '../parts/live-namespace/do-work/shared-file-reference.mjs';
import { hearingHere as programHere } from '../computer-programs/read-data/program-here.mjs';

const IDENTITY = /^1f:[a-f0-9]{64}$/;
const MAX_FILES = 32;
const computerSourceRows = () => JSON.parse(readFileSync(new URL('./computer-sources.json', import.meta.url), 'utf8'));
const safeName = (value, fallback) => basename(String(value ?? fallback)).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').slice(0, 180) || fallback;
const safeKey = value => String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
const atPath = (value, path) => String(path ?? '').split('.').filter(Boolean).reduce((part, key) => part?.[key], value);
const matches = (value, rule) => rule && typeof rule.path === 'string' && Object.hasOwn(rule, 'is') && atPath(value, rule.path) === rule.is;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hideWorkspace = (value, workspace) => typeof value === 'string' ? value.replaceAll(workspace, '[private job folder]')
  : Array.isArray(value) ? value.map(item => hideWorkspace(item, workspace))
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hideWorkspace(item, workspace)])) : value;

function eligibilityFor(app, appRows, sourceRows) {
  const appDefinition = appRow(appRows, app);
  const source = sourceRows.sources.find(row => row.id === appDefinition.id);
  return { appDefinition, source };
}

function installedHere(source, sourceRows, home = homedir()) {
  if (!source) return false;
  const look = Object.keys(source.look ?? {}).find(key => Object.hasOwn(LOOKS, key));
  return Boolean(look && LOOKS[look](source, source.look[look], { home }).some(found => found.state === 'found'));
}

function declaredFiles(value = {}) {
  const inputs = value.inputs ?? [];
  const outputs = value.outputs ?? [];
  if (!Array.isArray(inputs) || !Array.isArray(outputs) || inputs.length + outputs.length > MAX_FILES) throw new Error(`files must list at most ${MAX_FILES} inputs and outputs.`);
  const inputKeys = new Set();
  const outputKeys = new Set();
  for (const item of inputs) {
    if (!item || typeof item.key !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.key) || !IDENTITY.test(item.identity)) throw new Error('Each input file needs a simple key and a file identity from your files.');
    if (sharedReference(item)) throw new Error('A shared file cannot be an input here: it stays a Namespace reference, and this Mac opens no Namespace files in place.');
    if (item.access !== 'copy') throw new Error('Each input file needs access: copy; this Mac opens no Namespace files in place.');
    if (item.byte_length !== undefined && (!Number.isSafeInteger(item.byte_length) || item.byte_length < 0)) throw new Error('An input file size must be a whole, nonnegative byte count.');
    if (inputKeys.has(item.key)) throw new Error(`Input file key ${item.key} appears more than once.`);
    inputKeys.add(item.key);
  }
  for (const item of outputs) {
    if (!item || typeof item.key !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.key)) throw new Error('Each output file needs a simple key.');
    if (outputKeys.has(item.key)) throw new Error(`Output file key ${item.key} appears more than once.`);
    outputKeys.add(item.key);
  }
  return { inputs, outputs, inputKeys, outputKeys };
}

// A step's arguments may name a value an earlier step of the same job answered: { from_step, path } is the answer of
// step `from_step` (0-based, earlier than this one) at the dotted `path` (such as answer.clips.0.id), so an id the app
// made (an imported clip) is carried into the next operation without the caller knowing it in advance.
function resolveFiles(value, inputPaths, outputPaths, earlier = []) {
  if (Array.isArray(value)) return value.map(item => resolveFiles(item, inputPaths, outputPaths, earlier));
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.includes('from_step')) {
    if (keys.length !== 2 || !keys.includes('path') || typeof value.path !== 'string' || !value.path) throw new Error('A value from an earlier step has exactly from_step and path.');
    if (!Number.isInteger(value.from_step) || value.from_step < 0 || value.from_step >= earlier.length) throw new Error(`from_step ${String(value.from_step)} does not name an earlier step of this job.`);
    const found = atPath(earlier[value.from_step], value.path);
    if (found === undefined) throw new Error(`Step ${value.from_step} answered nothing at ${value.path}.`);
    return found;
  }
  if (keys.some(key => ['input_file', 'output_file', 'output_dir'].includes(key))) {
    if (keys.length !== 1) throw new Error('A file placeholder has exactly one field: input_file, output_file, or output_dir.');
    const path = keys[0] === 'input_file' ? inputPaths.get(value.input_file)
      : keys[0] === 'output_file' ? outputPaths.get(value.output_file)
        : outputPaths.has(value.output_dir) ? dirname(outputPaths.get(value.output_dir)) : null;
    if (!path) throw new Error(`The ${keys[0] === 'input_file' ? 'input' : 'output'} file key ${String(value[keys[0]])} is not declared.`);
    return path;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveFiles(item, inputPaths, outputPaths, earlier)]));
}

async function fetchInput(client, item, target, fetchImpl) {
  const found = await client.file(item.identity);
  if (!found) throw new Error(`The input file ${item.identity} is not in your files.`);
  const response = await fetchImpl(await client.readUrl(item.identity));
  if (!response.ok || !response.body) throw new Error(`Your files could not send ${item.identity} to this Mac (${response.status}).`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { mode: 0o600, flags: 'wx' }));
  return statSync(target).size;
}

/** runAppJob(input, {origin, key}, deps?) is the your-Mac tool implementation. */
export async function runAppJob(input = {}, context = {}, deps = {}) {
  const app = input.app;
  if (typeof app !== 'string' || !app.trim()) throw new Error('app names one of the apps on this Mac.');
  const files = declaredFiles(input.files);
  const outputDelivery = files.outputs.length ? context.outputDelivery : null;
  if (files.outputs.length && context.handoff_id && (!outputDelivery?.createWorkspace || !outputDelivery?.stage))
    throw new Error('App output files need the authenticated native result outbox before editing.');
  const appRows = deps.apps ?? appsHere();
  const sourceRows = deps.sources ?? computerSourceRows();
  let appDefinition, source;
  try { ({ appDefinition, source } = eligibilityFor(app, appRows, sourceRows)); }
  catch (error) { return { app, label: app, ok: false, said: error.message }; }
  const runtime = appDefinition.runtime ?? 'desktop';
  if (!['desktop', 'command'].includes(runtime)) return { app, label: appDefinition.label, ok: false, said: `${appDefinition.label} declares an unknown runtime, so Trillion did not contact it.` };
  if (runtime === 'command') {
    // The shipped row may name a package-launched server with no desktop app. Its local command must still pass
    // the declared check before files are fetched or the server is contacted; the caller cannot waive that check.
    if (!Array.isArray(appDefinition.check) || !appDefinition.check.length || appDefinition.needs_open) {
      return { app, label: appDefinition.label, ok: false, said: `${appDefinition.label} needs a command check and no desktop-app requirement in its runtime row.` };
    }
    if (!(deps.programHere ?? programHere)([appDefinition], { home: deps.home ?? homedir() })) {
      return { app, label: appDefinition.label, ok: false, said: `${appDefinition.label} needs ${appDefinition.check[0]} available on this computer, so Trillion did not contact it.` };
    }
  } else {
    if (!source) return { app, label: appDefinition.label, ok: false, said: `${appDefinition.label} has no matching app row in this computer's sources, so it was not opened.` };
    if (!(deps.installedHere ?? installedHere)(source, sourceRows, deps.home ?? homedir())) {
      return { app, label: appDefinition.label, ok: false, said: `${appDefinition.label} is not installed on this Mac, so Trillion did not contact it.` };
    }
  }
  // An app that works only while open is opened quietly (in the background, no focus, nothing for the person to do)
  // before anything is fetched; if it will not start, the job answers plainly and nothing is fetched.
  const opened = await (deps.openApp ?? openAppQuietly)(appDefinition, { running: deps.running ?? runningPrograms, rows: appRows, ...(deps.openDeps ?? {}) });
  if (!opened.ok) return { app, label: appDefinition.label, ok: false, said: opened.said };

  const steps = input.steps;
  if (steps !== undefined && (!Array.isArray(steps) || !steps.length || steps.length > 32 || steps.some(step => !step || typeof step.operation !== 'string' || !step.operation.trim()))) {
    throw new Error('steps must contain 1 to 32 operations, each with an operation name.');
  }
  if (steps !== undefined && input.operation !== undefined) throw new Error('Use operation or steps, not both.');
  const workspace = outputDelivery
    ? outputDelivery.createWorkspace()
    : (deps.makeWorkspace ?? (() => mkdtempSync(join(tmpdir(), 'trillion-app-job-'))))();
  chmodSync(workspace, 0o700);
  const safeResult = result => hideWorkspace(result, workspace);
  try {
    const inputsRoot = join(workspace, 'inputs');
    const outputsRoot = join(workspace, 'outputs');
    mkdirSync(inputsRoot, { mode: 0o700 });
    mkdirSync(outputsRoot, { mode: 0o700 });
    const origin = context.origin;
    const key = context.key;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const client = deps.client ?? (origin && key ? namespaceClient({ origin, control: bearerControl({ origin, authorization: async () => `Bearer ${key}`, fetchImpl }), fetchImpl }) : null);
    if (files.inputs.length && !client) throw new Error('File inputs need this Mac to be connected to your Trillion account.');

    const inputPaths = new Map();
    // Every input is an explicit copy (declaredFiles refuses anything else), fetched whole before an app operation.
    for (const item of files.inputs) {
      const key = safeKey(item.key);
      const folder = join(inputsRoot, key);
      mkdirSync(folder, { mode: 0o700 });
      const target = join(folder, safeName(item.name, `${key}-input`));
      await fetchInput(client, item, target, fetchImpl);
      inputPaths.set(item.key, target);
    }

    const outputPaths = new Map();
    const outputTargets = [];
    const outputNames = new Set();
    for (const item of files.outputs) {
      const key = safeKey(item.key);
      const folder = join(outputsRoot, key);
      mkdirSync(folder, { mode: 0o700 });
      const name = safeName(item.name, `${key}-output`);
      if (outputNames.has(name)) throw new Error('Output files need distinct saved names.');
      outputNames.add(name);
      const path = join(folder, name);
      outputPaths.set(item.key, join(folder, name));
      outputTargets.push({ ...item, key, name, path });
    }

    const finishedAnswer = async answer => {
      if (!outputDelivery || answer.uncertain === true) return answer;
      const produced = outputTargets.filter(output => statSync(output.path, { throwIfNoEntry: false })?.isFile());
      if (answer.ok !== false && produced.length !== outputTargets.length) {
        const missing = outputTargets.find(output => !produced.includes(output));
        answer = { ...answer, ok: false, said: appDefinition.label + ' did not create the requested file ' + missing.name + '.' };
      }
      if (answer.ok === false) answer = { ...answer, error: answer.said ?? 'The app did not finish this job.' };
      // A confirmed failure can still have a completed project or other valuable artifact.
      // Keep every produced declared output, including a prefix, before returning the failed answer.
      await outputDelivery.stage({ result: answer, outputs: produced.map(output => ({ key: output.key, name: output.name, path: output.path, media_type: output.media_type ?? 'application/octet-stream' })) });
      return { output_delivery_pending: true };
    };

    const executeSteps = async useApp => {
    const results = [];
    const stepInputs = steps ?? [{ operation: input.operation ?? null, arguments: input.arguments ?? {} }];
    let fenced = false;
    const dispatchedSteps = new Set();
    let returnedSteps = 0;
    const progress = value => context.recordProgress?.({ total_steps: stepInputs.length, returned_steps: returnedSteps, ...value });
    const uncertain = async step => {
      await progress({ stage: 'app-step-uncertain', step, uncertain: true });
      return { app, label: appDefinition.label, ok: false, uncertain: true, said: `${appDefinition.label} did not return a confirmed answer. This operation may have run and was not repeated.` };
    };
    // One shared fence covers the entire operation session. Step progress stays local;
    // a long edit does not add two account round trips for every operation or status read.
    const settle = async result => {
      if (fenced && result.uncertain !== true) await context.recordEffect({ effect_id: 'app-job-operations', state: 'done',
        receipt: { returned_steps: returnedSteps, ok: result.ok !== false && result.answer?.success !== false } });
    };
    const runStep = async (operation, arguments_, step, starting = false) => {
      let args;
      try { args = resolveFiles(arguments_ ?? {}, inputPaths, outputPaths, results); }
      catch (error) { return { app, label: appDefinition.label, ...(operation ? { operation } : {}), ok: false, said: `${appDefinition.label} could not do this job: ${error.message}` }; }
      if (starting) {
        await progress({ stage: 'app-step-starting', step });
        if (operation && !fenced && context.recordEffect) {
          let admitted;
          try { admitted = await context.recordEffect({ effect_id: 'app-job-operations', state: 'starting', target: 'An app job on this computer' }); }
          catch { return uncertain(step); }
          // Repeated starting, done and unknown all lack permission to dispatch this operation again.
          if (!admitted?.proceed || admitted.repeated) return uncertain(step);
          fenced = true;
        }
      } else await progress({ stage: 'app-step-starting', step });
      dispatchedSteps.add(step);
      try {
        const answer = await useApp({ app, operation: operation ?? null, args, rows: appRows });
        return answer && typeof answer === 'object' && answer.uncertain !== true ? answer : uncertain(step);
      } catch { return uncertain(step); }
    };
    for (const [stepIndex, step] of stepInputs.entries()) {
      let result = await runStep(step.operation, step.arguments ?? {}, stepIndex, true);
      if (step.expect && !matches(result, step.expect)) {
        result = { ...result, ok: false, said: `${appDefinition.label} did not match the requested ${step.expect.path} before continuing.` };
      }
      const completion = step.wait_for;
      if (completion && result.ok !== false && matches(result, completion.when)) {
        const poll = completion.poll;
        const seconds = Number(completion.timeout_seconds ?? 180);
        if (!poll || typeof poll.operation !== 'string' || typeof poll.until?.path !== 'string' || !Object.hasOwn(poll.until, 'is') || !Number.isFinite(seconds) || seconds < 1 || seconds > 900) {
          throw new Error('wait_for needs a poll operation, a result path and a timeout of 1 to 900 seconds.');
        }
        const outputKeys = completion.output_keys ?? files.outputs.map(output => output.key);
        if (!Array.isArray(outputKeys) || outputKeys.some(key => !files.outputKeys.has(key))) throw new Error('wait_for.output_keys must name declared output files.');
        const awaitedOutputs = outputTargets.filter(output => outputKeys.includes(output.key));
        const deadline = Date.now() + seconds * 1000;
        let checked = null;
        let finished = false;
        let pollFailed = false;
        while (Date.now() < deadline) {
          checked = await runStep(poll.operation, poll.arguments ?? {}, stepIndex);
          if (checked.ok === false || checked.answer?.success === false) { result = { ...checked, ok: false }; pollFailed = true; break; }
          if (matches(checked, poll.until) && awaitedOutputs.every(output => statSync(output.path, { throwIfNoEntry: false })?.size > 0)) {
            result = { ...result, ok: true, answer: { success: true, initial: result.answer, completion: checked.answer }, said: `${appDefinition.label} finished ${step.operation} and made the requested files.` };
            finished = true;
            break;
          }
          await wait(1000);
        }
        if (!finished && !pollFailed) result = { ...result, ok: false, uncertain: true, said: `${appDefinition.label} did not finish ${step.operation} within ${seconds} seconds.` };
      }
      if (result.uncertain === true) await progress({ stage: 'app-step-uncertain', step: stepIndex, uncertain: true });
      else if (dispatchedSteps.has(stepIndex)) {
        returnedSteps += 1;
        const ok = result.ok !== false && result.answer?.success !== false;
        await progress({ stage: 'app-step-returned', step: stepIndex, ok });
      }
      results.push(result);
      if (result.ok === false || result.answer?.success === false) {
        await settle(result);
        return await finishedAnswer(safeResult({ ...result, ok: false, ...(steps ? { steps: results } : {}), inputs: files.inputs.map(item => ({ key: item.key, identity: item.identity, name: item.name ?? null })) }));
      }
    }
    const result = steps ? { ...results.at(-1), steps: results } : results[0];
    await settle(result);
    if (outputDelivery) return await finishedAnswer(safeResult({ ...result, ok: result.ok ?? true,
      ...(files.inputs.length ? { inputs: files.inputs.map(item => ({ key: item.key, identity: item.identity, name: item.name ?? null, access: item.access })) } : {}) }));
    const keptFiles = [];
    for (const output of outputTargets) {
      if (!statSync(output.path, { throwIfNoEntry: false })?.isFile()) return safeResult({ ...result, ok: false, said: `${appDefinition.label} did not create the requested file ${output.name}.` });
      if (!client) throw new Error('Saving output files needs this Mac to be connected to your Trillion account.');
      const file = await (deps.fileSource ?? fileSource)(output.path);
      try {
        const saved = await (deps.sendFile ?? sendFile)({
          client, source: file, chunking: await (deps.loadChunking ?? loadChunking)(),
          name: `/Made by tools/An app on your Mac/${output.name}`,
          mediaType: output.media_type ?? 'application/octet-stream',
        });
        if (!IDENTITY.test(saved?.identity)) throw new Error(`Your files did not confirm that ${output.name} was saved.`);
        keptFiles.push({ key: output.key, identity: saved.identity, name: output.name, bytes: file.size, media_type: output.media_type ?? 'application/octet-stream' });
        await progress({ stage: 'app-output-saved', saved_outputs: keptFiles.length, file: { identity: saved.identity, bytes: file.size } });
      } finally { await file.close(); }
    }
    return safeResult({ ...result, ok: result.ok ?? true, ...(files.inputs.length ? { inputs: files.inputs.map(item => ({ key: item.key, identity: item.identity, name: item.name ?? null, access: item.access })) } : {}), ...(keptFiles.length ? { files: keptFiles } : {}) });
    };
    if (deps.useApp) return await executeSteps(deps.useApp);
    return await (deps.withAppSession ?? withAppSession)({ app, rows: appRows }, session => executeSteps(request => session.use(request)));
  } finally {
    if (!outputDelivery) rmSync(workspace, { recursive: true, force: true });
  }
}

export const appJob = {
  async run(input, context, deps) {
    const answer = await runAppJob(input, context, deps);
    return answer.ok === false ? { ...answer, error: answer.said } : answer;
  },
};
