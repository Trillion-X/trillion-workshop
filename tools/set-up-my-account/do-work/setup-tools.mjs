// tools/set-up-my-account: the two setup tools an AI calls over the connection, start_setup and read_setup, with the
// owner calls they make. Ported from the older repository's src/setup-plan.mjs setupTools (commit b6ae0ebf81), with its
// rules: the input is checked before any owner call; start_setup prepares the account's runtime first, then reads the
// prerequisites, the known pursuits, connections, profile and devices, then the computers; read_setup and the read-only
// start_setup only read. The plan itself is tools/walk-a-new-person-through-first-setup/do-work/setup-plan.mjs. The
// call that reaches an owner is passed in (`call(path, body, method)`), so this file opens no route and no store.
import { setupPlan } from '../../walk-a-new-person-through-first-setup/do-work/setup-plan.mjs';

const callFor = (tool, args = {}) => ({ tool, arguments: args });
const uniqueCalls = calls => [...new Map(calls.map(call => [JSON.stringify([call.tool, call.arguments]), call])).values()];
const PREREQUISITES_SCHEMA = 'setup-prerequisites/v1';
const COMPUTER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

// The entry point the person started from: the one named, else the one recorded for where they came from. Never a gate.
export function entryPointForSetup(entries, named, cameFrom) {
  const entry = (typeof named === 'string' && named ? entries.find(row => row.id === named) : null)
    ?? (typeof cameFrom?.from === 'string' ? entries.find(row => row.from === cameFrom.from) : null) ?? null;
  if (typeof named === 'string' && named && !entry) throw Object.assign(new Error(`There is no entry point ${named}.`), { status: 404 });
  return entry ? { id: entry.id, persona: entry.persona, opening_message: entry.opening_message, channels: entry.channels, source: named ? 'named' : 'came_from' } : null;
}

/**
 * The setup tools over `call`. Dependencies are passed in so each is owned where it lives:
 *   withoutSecrets(error) -> text with credential-shaped values hidden (the scheduler's rule),
 *   formerAgentIds(id) -> the ids a renamed computer app may advertise (the keep-and-wake rename rule),
 *   computerAgentPrefix -> the agent prefix of computers (the placement DATA),
 *   entries -> the entry-point rows (start-from-any-landing-page entry_points).
 */
export function setupTools({ call, origin, cameFrom = async () => null, withoutSecrets, formerAgentIds = () => [], computerAgentPrefix, entries = [] }) {
  const readNative = async () => {
    try {
      const answer = await call('/computer-sources');
      if (!Array.isArray(answer?.computers) || !answer.computers.every(row => typeof row?.computer_id === 'string' &&
        COMPUTER_ID.test(row.computer_id) && Number.isFinite(Date.parse(row.reported_at))) ||
        new Set(answer.computers.map(row => row.computer_id)).size !== answer.computers.length) throw new Error('The account computer inventory could not be read.');
      const computers = answer.computers.slice(0, 32);
      const idOf = row => `${computerAgentPrefix}${row.computer_id}`;
      // The current agent id is asked first; a computer whose app predates the rename advertises only a former id,
      // so the former ids are asked only when the current answer has no agents.
      const cards = await Promise.allSettled(computers.map(async row => {
        const agent_id = idOf(row);
        let found = await call('/agents/find', { agent_id, limit: 1 }, 'POST');
        for (const former of formerAgentIds(agent_id)) {
          if (found?.agents?.length) break;
          found = await call('/agents/find', { agent_id: former, limit: 1 }, 'POST');
        }
        return found;
      }));
      return { computers, truncated: answer.computers.length > 32, cards: Object.fromEntries(cards.map((result, index) => [idOf(computers[index]),
        result.status === 'fulfilled' ? result.value : { unavailable: withoutSecrets(result.reason) }])) };
    } catch (error) { return { unavailable: withoutSecrets(error) }; }
  };
  const readPrerequisites = async (prepare = false) => {
    try {
      const result = prepare ? await call('/setup/requirements', {}, 'POST') : await call('/setup/requirements');
      if (result?.schema !== PREREQUISITES_SCHEMA || !Array.isArray(result.requirements)
        || !Array.isArray(result.setup_access) || !Array.isArray(result.next_calls)
        || !result.next_calls.every(next => typeof next?.tool === 'string' && next.arguments && typeof next.arguments === 'object' && !Array.isArray(next.arguments))
        || typeof result.setup_complete !== 'boolean' || typeof result.workspace_ready !== 'boolean' || typeof result.setup_paused !== 'boolean') {
        throw new Error('The current account setup prerequisites could not be read.');
      }
      return result;
    } catch (error) { return { unavailable: withoutSecrets(error) }; }
  };
  const withEntry = async (plan, named) => {
    const entry = entryPointForSetup(entries, named, await cameFrom().catch(() => null));
    return entry ? { ...plan, entry_point: entry } : plan;
  };
  const readSetup = async (view = 'full', entry) => {
    const runtime = await call('/setup/runtime');
    return withEntry(setupPlan({ runtime, prerequisites: await readPrerequisites(), native: view === 'full' ? await readNative() : null, origin, view }), entry);
  };
  const readKnown = async () => {
    const entryReads = [
      ['pursuits', () => call('/pursuits?offset=0&limit=25')],
      ['connections', async () => {
        const page = await call('/connections?limit=25');
        return typeof page?.next_after === 'string' && page.next_after
          ? { ...page, next_call: callFor('list_connections', { after: page.next_after, limit: 25 }) } : page;
      }],
      ['profile', () => call('/network/ensure-profile', {}, 'POST')],
      ['devices', () => call('/setup/devices')],
    ];
    const results = await Promise.allSettled(entryReads.map(([, read]) => read()));
    return Object.fromEntries(results.map((result, index) => [entryReads[index][0], result.status === 'fulfilled'
      ? result.value : { unavailable: withoutSecrets(result.reason) }]));
  };
  return [
    {
      name: 'start_setup',
      inputSchema: { type: 'object', properties: {
        read_only: { type: 'boolean' }, restart: { type: 'boolean' }, view: { type: 'string', enum: ['state', 'full'] }, entry: { type: 'string' } } },
      run: async (input = {}) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || (input.read_only !== undefined && typeof input.read_only !== 'boolean')
          || (input.restart !== undefined && typeof input.restart !== 'boolean'))
          throw new Error('read_only and restart, when supplied, must be true or false.');
        if (input.view !== undefined && !['state', 'full'].includes(input.view))
          throw new Error("view must be 'state' or 'full'.");
        if (input.entry !== undefined && typeof input.entry !== 'string') throw new Error('entry, when supplied, must be an entry point id.');
        const { read_only = false, restart = false } = input;
        if (read_only && restart) throw new Error('Read-only setup cannot be combined with restart.');
        if (read_only) return readSetup(input.view ?? 'full', input.entry);
        if (input.view !== undefined) throw new Error('view is only supported with read_only:true.');
        // Runtime authorization and preparation must succeed before optional reads or profile initialization.
        const runtime = await call('/setup/runtime', restart === true ? { restart: true } : {}, 'POST');
        const prerequisites = await readPrerequisites(true);
        return withEntry(setupPlan({ runtime, prerequisites, known: await readKnown(), native: await readNative(), origin }), input.entry);
      },
    },
    {
      name: 'read_setup',
      inputSchema: { type: 'object', properties: { view: { type: 'string', enum: ['state', 'full'] }, entry: { type: 'string' } } },
      run: async (input = {}) => {
        if (!input || typeof input !== 'object' || Array.isArray(input) || (input.view !== undefined && !['state', 'full'].includes(input.view)))
          throw new Error("view must be 'state' or 'full'.");
        if (input.entry !== undefined && typeof input.entry !== 'string') throw new Error('entry, when supplied, must be an entry point id.');
        return readSetup(input.view ?? 'full', input.entry);
      },
    },
  ];
}

export const setupAnnotations = {
  start_setup: { title: 'Finish setup', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_setup: { title: 'Read setup', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
