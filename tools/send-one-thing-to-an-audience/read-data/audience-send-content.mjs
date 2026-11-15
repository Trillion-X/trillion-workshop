// Audience choice DATA uses the same independently addressed inert sections as
// other default content. Stored ledger identities and delivery/retry limits stay
// with the engine; no publication can rename or reopen a historical receipt.
import { audiencePolicy as bootstrap } from './audience-policy.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const path = value => typeof value === 'string' && /^(?:\$\.)?[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(value)
  && !value.split('.').some(key => ['__proto__', 'constructor', 'prototype'].includes(key));
const invalid = () => { throw Object.assign(new Error('The current audience choices do not satisfy the delivery contract.'), { status: 503, code: 'audience_content_invalid' }); };
const timingProtocols = new Set(['manual', 'now', 'at', 'each_new']);
const stateProtocols = new Set(['sent', 'opened', 'not_opened', 'signed', 'paid', 'not_paid']);

export function checkedAudienceSendContent(value) {
  if (!object(value) || !Array.isArray(value.channels) || !Array.isArray(value.timings)
      || !object(value.audience_states) || !object(value.words) || !object(value.screen)) invalid();
  const seen = new Set();
  for (const row of value.channels) {
    if (!object(row) || !text(row.id) || !text(row.label) || !text(row.road) || seen.has(row.id)
        || row.address !== null && !Object.hasOwn(bootstrap.addresses, row.address)
        || row.connects_any !== undefined && (!Array.isArray(row.connects_any) || !row.connects_any.every(text))
        || row.tool_id !== undefined && !text(row.tool_id)
        || row.input !== undefined && !object(row.input)
        || row.outcome !== undefined && (!object(row.outcome) || !path(row.outcome.sent) || row.outcome.unknown !== undefined && !path(row.outcome.unknown))) invalid();
    if (row.road === 'carried' && !Array.isArray(row.connects_any)) invalid();
    seen.add(row.id);
  }
  if (!value.timings.every(kind => timingProtocols.has(kind)) || new Set(value.timings).size !== value.timings.length
      || !Object.entries(value.audience_states).every(([kind, row]) => stateProtocols.has(kind) && object(row) && text(row.label))
      || !Object.values(value.words).every(word => typeof word === 'string')) invalid();
  for (const key of ['who', 'when', 'prices']) if (value.screen[key] !== undefined && (!Array.isArray(value.screen[key])
      || !value.screen[key].every(row => object(row) && text(row.id) && text(row.label) && text(row.icon)))) invalid();
  if (value.screen.when?.some(row => !timingProtocols.has(row.id)) || value.screen.who?.some(row => !['one', 'list'].includes(row.id))
      || value.screen.prices?.some(row => !['one', 'two'].includes(row.id))) invalid();
  if (value.screen.words !== undefined && (!object(value.screen.words) || !Object.values(value.screen.words).every(word => typeof word === 'string'))
      || value.screen.channel_icons !== undefined && (!object(value.screen.channel_icons) || !Object.values(value.screen.channel_icons).every(text))) invalid();
  return value;
}

/** Empty published sections and withdrawal are actual empty choices. Neither
 * restores bundled defaults; private saved send/tool definitions stay intact. */
export async function readAudienceSendContent(door, { dispatch = false } = {}) {
  const value = structuredClone(bootstrap);
  for (const key of dispatch ? ['channels'] : ['channels', 'timings', 'audience_states', 'words', 'screen']) {
    const row = await door.read('audience-send-content', `audience-send-content:${key}`);
    // Missing and withdrawn rows are empty choices. An outage propagates; it never restores defaults.
    if (row !== null) value[key] = row.content;
  }
  return checkedAudienceSendContent(value);
}
