// computer/isolated-run-worker.mjs
//
// The worker thread of computer/isolated-run.mjs: loads the one tool function its run names, calls it with the plain
// input and context, and posts back the answer or a refusal. It names no tool; everything comes from its workerData.
import { parentPort, workerData } from 'node:worker_threads';

const { module, exported, name, input, context } = workerData;
parentPort.on('message', message => { if (message?.stop === true) process.exit(0); });
try {
  const fn = (await import(module))[exported]?.[name];
  if (typeof fn !== 'function') throw Object.assign(new Error('The tool function is not there.'), { status: 404, retry: false });
  const value = (await fn(input ?? {}, context)) ?? {};
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  parentPort.postMessage({ error: { message: String(error?.message ?? error), status: error?.status, retry: typeof error?.retry === 'boolean' ? error.retry : undefined,
    reaction: error?.reaction, reaction_said: error?.reaction_said, outcome: error?.outcome } });
}
