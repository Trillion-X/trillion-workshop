// The Mac host's tool that keeps Trillion's standing instructions in the person's own AI harness instruction file
// (tool:keep-trillion-in-your-instructions). The input only names a supported harness and inspect, apply or remove; the
// text is the service's current words (harness/standing-instructions.json, published at /workspace/harness/), read each
// run so HQ can change it, with the copy this app carries when the service cannot be reached. The file work is
// harness/standing-instructions.mjs: one marked block, every other byte left alone.
import { keepInstructions, harnessIds, standing } from '../harness/standing-instructions.mjs';
import setup from '../harness/setup.json' with { type: 'json' };

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The text the service now publishes, or null when it cannot be read as the expected record. */
export async function currentText({ origin, fetchImpl = (...args) => fetch(...args) } = {}) {
  try {
    const url = new URL(`${setup.publication.path}/standing-instructions.json`, origin);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    const record = response.ok ? await response.json() : null;
    return record?.schema === standing.schema && typeof record.text === 'string' && record.text.trim() ? record.text : null;
  } catch { return null; }
}

/** Dependency parameters are for tests; the Workshop input cannot supply or override any of them. */
export function makeInstructionTools({ run = keepInstructions, readText = currentText, now = () => new Date().toISOString() } = {}) {
  return { async keep(input, { origin } = {}) {
    if (!object(input) || Object.keys(input).some(name => !['harness', 'action'].includes(name)) || !harnessIds().includes(input.harness) ||
      !['inspect', 'apply', 'remove'].includes(input.action)) throw new Error(`Name one supported harness (${harnessIds().join(', ')}) and inspect, apply or remove.`);
    const text = input.action === 'apply' || input.action === 'inspect' ? await readText({ origin }) : null;
    const report = run({ action: input.action, harness: input.harness, ...(text ? { text } : {}) });
    return { schema: 'trillion.standing-instructions-result/v1', observed_at: now(), text_from: text ? 'service' : 'this app', report };
  } };
}

export const instructionTools = makeInstructionTools();
