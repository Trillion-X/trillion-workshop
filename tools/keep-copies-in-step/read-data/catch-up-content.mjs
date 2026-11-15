// Optional current presentation over the catch-up owner's private facts. Only
// these exact content sections are selectable; engine limits and identities
// remain with catch-up.mjs. No selected presentation is persisted into history.
// The host supplies current content rows and its admitted publication resolver.
// No content selection grants access to the private catch-up owner.
import { answerWithin } from '../../keep-and-wake-ai-sessions-on-this-computer/src/connecting-without-the-store.mjs';

// Optional public copy must not hide private facts behind a stalled read. This
// is a finite engine latency bound, not editable content or a retry schedule.
const PRESENTATION_WAIT_MS = 250;

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sectionsOf = bootstrap => [
  { key: 'words', pointer: '/words', absent: {}, valid: value => object(value) && Object.keys(bootstrap.words).every(key => nonempty(value[key])) },
  { key: 'title_fields', pointer: '/title_fields', absent: [], valid: value => Array.isArray(value) && value.every(nonempty) },
  { key: 'copy_state', pointer: '/copy_state', absent: '', valid: nonempty },
];

export async function resolveCatchUpPresentation(host, { read } = {}) {
  const { bootstrap, resolveContent } = host;
  const sections = sectionsOf(bootstrap);
  const completed = new Map();
  const work = Promise.all(sections.map(async section => {
    let selected;
    try {
      // Consumer authority is checked outside this optional-presentation catch.
      const result = await resolveContent(
        { file: 'records/catch-up.json', pointer: section.pointer }, bootstrap[section.key], { read });
      if (result.found && !section.valid(result.value)) throw new TypeError('Invalid catch-up presentation section.');
      selected = { key: section.key, value: result.found ? result.value : section.absent,
        status: { pointer: section.pointer, from: result.from, found: result.found, ...(result.revision ? { revision: result.revision } : {}) } };
    } catch {
      selected = { key: section.key, value: section.absent,
        status: { pointer: section.pointer, from: 'unavailable', found: false, code: 'marketplace_content_source_unavailable' } };
    }
    completed.set(section.key, selected);
  }));
  await answerWithin(work, { ms: PRESENTATION_WAIT_MS });
  // Snapshot completed sections once. A late optional result cannot mutate a
  // response that already released independently retained private facts.
  const selected = sections.map(section => completed.get(section.key) ?? {
    key: section.key, value: section.absent,
    status: { pointer: section.pointer, from: 'unavailable', found: false, code: 'marketplace_content_source_timeout' },
  });
  return {
    value: Object.fromEntries(selected.map(section => [section.key, section.value])),
    status: { available: selected.every(section => section.status.found), sections: selected.map(section => section.status) },
  };
}

/** Pure owners retain synchronous APIs. Runtime reads await current content,
 * recheck rights, then take the private snapshot, so an intervening device or
 * settlement write cannot be overwritten by an earlier presentation read. */
export function currentCatchUp(owner, host, { read, current = async () => {} } = {}) {
  return { ...owner,
    here: async body => { await current(); return owner.here(body); },
    settle: async (body, context) => { await current(); return owner.settle(body, context, { rawReceipt: true }); },
    read: async () => {
      await current();
      const presentation = await resolveCatchUpPresentation(host, { read });
      await current();
      return { ...await owner.read({ presentation: presentation.value }), presentation: presentation.status };
    },
  };
}
