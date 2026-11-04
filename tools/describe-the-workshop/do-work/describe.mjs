// tools/describe-the-workshop/do-work/describe.mjs
//
// tool:describe-a-tool: one tool's whole row, so an AI or the person's page can learn how a tool is written. Moved from
// trillion src/workshop.mjs describeTool (the function below is that function, with the store's file bytes and the
// account's sample states left out) and from the trillion-rust engine's describe resolver (src/workshop_describe.rs,
// deleted when this tool took over its route), whose precedence it keeps: the person's own saved row, when it is not
// deleted, replaces the shared row of the same id, even when the saved row cannot be described.
//
//   node /opt/records-door/do-work/run-an-export.mjs /opt/describe-the-workshop/do-work/describe.mjs describeATool < input
//
// The shared rows are the ones the caller already holds (the page's tools:list answer, given as `shared`); the saved
// row is read through the records door ({ type: 'tool', id: 'tool:<tool id>' }), or given as `saved` instead.
// Where a tool runs decides how its samples run (read-data/workshop-sample-rules.json): the rule of its placement's
// executor, with a former placement id read as its current one (read-data/renamed-tools.json `placements`).
import { sampleRuleOf } from '../read-data/workshop-sample-rules.mjs';
import renamed from '../read-data/renamed-tools.json' with { type: 'json' };

const RUN_HINT = { input: '(an object matching input_schema)', request_key: '(any unique text; reuse it only to repeat this exact call)' };
const SAVED_TYPE = 'tool';

class WorkshopError extends Error {
  constructor(message, next_call) {
    super(message);
    if (next_call) this.next_call = next_call;
  }
}
const nonempty = value => typeof value === 'string' && value.length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const placementMap = renamed.placements ?? {};
// A placement id as its current id (trillion src/renamed-tools.mjs currentPlacement).
const currentPlacement = id => placementMap[id] ?? id;
const active = tool => (tool.status ?? 'active') === 'active';
// No file bytes are read here: a tool's files are in its Workshop folder.
const store = {};

// Who made a tool (trillion src/workshop.mjs madeByOf, for the two kinds this tool can see).
function madeByOf({ sharedIds, savedIds }, tool) {
  if (savedIds.has(tool.id)) return 'this account';
  if (sharedIds.has(tool.id)) return 'shared';
  return 'a registry';
}

// The place a tool runs (trillion src/workshop.mjs choosePlacement): the first of its placements its licence class
// allows. A licence class the caller did not give allows every placement the tool names.
function choosePlacement(tool, { placementsById, licences }) {
  const licence = licences.get(tool.licence_class) ?? null;
  const allowedHere = licence ? licence.allowed_placements.map(currentPlacement) : null;
  const allowed = (tool.placements ?? []).map(id => placementsById.get(currentPlacement(id))).filter(place => place && (!allowedHere || allowedHere.includes(place.id)));
  const here = allowed[0];
  if (here) return { place: here, licence };
  throw new WorkshopError(`${tool.id} names no placement the shared rows hold, so where it runs is not known here.`);
}

const toolById = (everythingNow, id) => everythingNow.tools.find(item => item.id === id) ?? null;

// The sample-run checks a tool declares. Their states (owed, passed) are kept by the engine that ran them, which this
// tool cannot read; each is answered with state null.
const sampleStates = tool => (tool.verify ?? []).filter(check => check?.kind === 'sample-run').map(check => ({ ...check, state: null }));

// Everything describe reads for one id: the shared rows given, and the person's own saved row.
async function everythingFor({ only, shared = [], saved }, door) {
  if (!Array.isArray(shared)) throw new WorkshopError('shared is the list of rows the Workshop answered (tools:list).');
  const rows = shared.filter(object);
  const placementsById = new Map(rows.filter(row => row.kind === 'tool-placement' && nonempty(row.id)).map(row => [row.id, row]));
  const licences = new Map(rows.filter(row => row.kind === 'tool-licence-class' && nonempty(row.id)).map(row => [row.id, row]));
  const sharedTools = rows.filter(row => row.kind === 'ai-tool-descriptor' && row.id === only);
  if (sharedTools.length > 1) throw new WorkshopError(`shared holds ${only} more than once; give the Workshop's answer as it came.`);
  let own = saved;
  if (own === undefined) own = (await door.read(SAVED_TYPE, `tool:${only}`)) ?? null;
  if (own !== null && (!object(own) || own.id !== only)) throw new WorkshopError(`The saved row read for ${only} is not that tool's row.`);
  if (own && own.status !== 'deleted' && own.listed_on === undefined && own.saved_at !== undefined) own = { ...own, listed_on: own.saved_at };
  const ownLive = own && own.status !== 'deleted' ? own : null;
  // A saved row this account did not delete replaces the shared row of its id, even when it cannot be described.
  const tools = ownLive ? [ownLive] : sharedTools;
  const describable = tools.filter(tool => active(tool) && (tool.invoke || (!ownLive && object(tool.screen)) || (ownLive && tool.screen?.kind === 'parts')));
  return {
    tools: describable.filter(tool => tool.invoke),
    screens: [],
    shared: { tools: ownLive ? [] : describable },
    savedScreens: ownLive ? describable.filter(tool => !tool.invoke) : [],
    sharedIds: new Set(ownLive ? [] : sharedTools.map(tool => tool.id)),
    savedIds: new Set(ownLive ? [ownLive.id] : []),
    placementsById,
    licences,
  };
}

export async function describeATool(input, { door } = {}) {
  if (!object(input) || !nonempty(input.tool_id)) throw new WorkshopError('tool_id is the id of the tool to describe, for example tool:find-tool-for-job.');
  if (input.tool_id.length > 4096 || /[\u0000-\u001f\u007f]/.test(input.tool_id)) throw new WorkshopError('tool_id is too long or holds a control character.');
  const everything = ({ only }) => everythingFor({ only, shared: input.shared, saved: input.saved }, door);

  // A tool's whole row, so an AI can learn from how any tool is written: its invoke, placements, licence class and
  // checks, and the text of its files when it has them. A shared row that is only a screen (`screens` below) is
  // described too, since its own screen is drawn from this row; there is nothing of it to run.
  async function describeTool({ tool_id, share, include_files = true }) {
    if (share !== undefined && !nonempty(share)) throw new WorkshopError('share is the link someone sent you for this tool.');
    const everythingNow = await everything({ only: tool_id, share });
    // A screen that is one of the workspace's own (its row names a surface) is not shelved twice, but it is described:
    // an AI reads what it takes (input_schema, controls) like any other tool's.
    const tool = await toolById(everythingNow, tool_id) ?? everythingNow.screens.find(item => item.id === tool_id)
      ?? everythingNow.savedScreens.find(item => item.id === tool_id)
      ?? everythingNow.shared.tools.find(item => item.id === tool_id && !item.invoke && object(item.screen) && (item.status ?? 'active') === 'active') ?? null;
    if (!tool) throw Object.assign(new WorkshopError(`There is no tool ${tool_id}. find_tool_for_job lists tools by job.`, { tool: 'find_tool_for_job', arguments: { job: '(the job in plain words)' } }), { status: 404 });
    const madeBy = madeByOf(everythingNow, tool);
    const fingerprint = typeof tool.invoke?.files === 'string' ? tool.invoke.files : tool.bytes_fingerprint;
    let files;
    if (include_files && fingerprint && store.readBytes && madeBy !== 'another account') {
      const bytes = await store.readBytes(fingerprint);
      if (bytes) files = bytes;
    }
    // Where it runs decides how its samples run (src/workshop-sample-rules.json); its maker reads where each one stands.
    let rule = null;
    try { rule = tool.invoke ? sampleRuleOf(choosePlacement(tool, everythingNow).place) : null; } catch (error) { if (!(error instanceof WorkshopError)) throw error; }
    return {
      tool_id: tool.id, made_by: madeBy, descriptor: tool, ...(files ? { files } : {}),
      ...(rule ? { sample_rule: { safe: rule.safe, unconnected: rule.unconnected, owed_until: rule.owed_until, readback: rule.readback } } : {}),
      ...(madeBy === 'this account' && tool.invoke ? { samples: await sampleStates(tool) } : {}),
      next_call: madeBy === 'this account' ? { tool: 'save_tool', arguments: { descriptor: '(this descriptor, changed)' } } : tool.invoke ? { tool: 'run_tool', arguments: { tool_id: tool.id, ...(share !== undefined ? { share } : {}), ...RUN_HINT } } : null,
    };
  }

  return describeTool({ tool_id: input.tool_id, include_files: false });
}
