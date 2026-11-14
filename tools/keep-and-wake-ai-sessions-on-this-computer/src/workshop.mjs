import { canonical, identityOf, workshopTaskId, workshopToolVersion, workshopToolDefinition, schemaProblems } from './typed-operation-contract.mjs';
export { workshopTaskId, workshopToolVersion, workshopToolDefinition, schemaProblems } from './typed-operation-contract.mjs';
import { bindAdmittedTool, boundToolId, boundToolParts, connectionVendor, requireCurrentConnection } from './source-connection.mjs';
// A concrete connection identity is private execution authority, never shared
// learning metadata. Keep the public executable definition and its version.
// The reply of unpublish_tool: one shape for its call and for its readback once the call is gone.
export const unpublishedToolReply = tool_id => ({ tool_id, published: false, visible_to: 'only the account that saved it' });
// The reply to a publish, one shape for the publish itself and for a lost publish read back from its Marketplace row.
const publishedToolReply = (tool_id, runs_on, row, price, publicRun) => ({ tool_id, published: true, visible_to: 'every account\'s AI', runs_on, ...(row.price_ref ? { price_ref: row.price_ref } : {}), ...(price ? { usage_price: { amount: `${(price.amount_micros / 1e6).toFixed(4)}`, per: price.per } } : {}), ...(publicRun ? { public_run: publicRun } : {}), next_call: { tool: 'unpublish_tool', arguments: { tool_id } } });
export const workshopLearningToolId = id => boundToolParts(id)?.tool_id ?? id;
export function workshopLearnedDefinition(tool) {
  const bound=boundToolParts(tool.id);if(!bound)return {...tool,kind:'ai-tool-descriptor'};
  const {source_connection,...invoke}=tool.invoke;
  const {bound_from,bound_connection,connection_id,...provenance}=tool.provenance??{};
  return {...tool,kind:'ai-tool-descriptor',id:bound.tool_id,invoke:{...invoke,connection_id:bound_connection},provenance};
}
// The Workshop: an AI names a job and gets a checked result from a tool that already exists somewhere.
//
// Four verbs, shared by the local service and each person's hosted store:
//   find(job)            tools whose job matches, ranked by how their earlier runs went for everyone
//   run(tool, input)     one task per (tool, request_key); runs where the tool can run, checks the output
//   read(task)           the same task from any AI that signs in as the same person
//   save(descriptor)     keeps a tool an AI built, under the BLAKE3 identity of its bytes
//
// Nothing here names a tool, a vendor or a place. Tool rows, placements and licence classes are DATA read
// through the one decoder in bitfield-packages (ai-tool-catalog). The host hands in `executors`, a map from
// a placement's `executor` id to a function, and says which host it is. Every shared placement is deployed (the
// decoder refuses anything on one person's machine); a placement this host cannot run is refused with the reason,
// and a tool whose licence keeps it off our compute is handed back to run in the caller's own sandbox. Every finished run is counted, with no person and no content, in the pooled
// results that rank the next pick.
import { makeMakerPayouts } from './maker-payouts.mjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { admitToolDescriptor, readToolData, toolLineProblems } from '../../ai-tool-catalog/read-data/read-ai-tool-catalog.ts';
import { selectDeclaredValue } from '../../ui/read-data/declared-selector.ts';
import { tarGz, untarGz } from './tar-gz.mjs';
import { InputStagingPending, inputPlacement, NAMESPACE_FILE, NAMESPACE_IDENTITY, runsSealed } from './repo-explorer.mjs';
import { sharedNamespaceFileInput, placeSharedNamespaceFileInput } from './shared-namespace-file-input.mjs';
import SAVE_TOOL_EXAMPLE from './save-tool-example.json' with { type: 'json' };
import { decideExternalEffectAttempt, recordExternalEffectResult } from '../../connect-a-service-and-seal-its-key/do-work/external-effect-attempt.ts';
import { sentFromRun } from './sent.mjs';
import { completeExecutionCapture, executionContext, providerObservation, taskEffectBinding } from './execution-context.mjs';
import { passing } from './cut-off.mjs';
import { NotPublicAddress, fetchPublic, publicAddress } from '../../refuse-requests-to-private-addresses/public-address.mjs';
import { checkedPublicRunPermission, publicRunEligible, publicRunPermissionFor } from './public-app-run-permission.mjs';
import { liveSourceProblems } from './live-tool-sources.mjs';
import { SOLD_COPIES, traceAsk } from './sold-copies.mjs';
import { thingActions } from './work-workshop.mjs';
import { MATCHED_BY_WORDS, wordShare, wordsOf as words } from './meaning-or-words.mjs';
import { latestTaskReport, observationFromReadTask, observationProblems, sameObservationTarget } from './outcome-checks.mjs';
import { claimedTime } from './claimed-time.mjs';
import { personReportVerified } from './check-uses.mjs';
import { RECORDS_PER_TOOL_INPUT, TooManyRecords } from './your-records.mjs';
import { currentPlacement, formerAgentIds } from './renamed-tools.mjs';
import { sampleRuleOf, unsafeSample } from './workshop-sample-rules.mjs';
import { effectsAt } from '../../ai-tool-catalog/read-data/declared-effects.ts';
import { HOST_VERSION, compatibleRelease, oldestNeeded, withEarlierReleases } from './tool-releases.mjs';
import { splitWriteOnly, joinHeld, heldTexts } from './write-only-input.mjs';
import { validateModuleSurfaceRequests } from '../parts/ui/show/isolated-module-surface/module-surface-requests.mjs';
import { PARTS_SCREEN, SCREEN_ONLY_LICENCE, checkSpec, screenOnly, screenSpecLimits } from 'trillion-workshop/tools/build-a-screen-from-patches/read-data/screen-spec.mjs';

const WAIT_SECONDS = { default: 20, max: 50 };
const MAX_SAVED_BYTES = 20 * 1024 * 1024;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
// The words a person used to ask for a saved screen (`screen.asked`): the same words typed again pick it at once
// (src/instant-screens.mjs). Bounded by src/screen-spec.json limits (asked_lines, asked_chars), the one rule make_screen keeps too.
/** What a screen with no `kind` may carry: how a tool is offered on a file, which opens no tab (work-workshop.mjs thingActions). */
/** The ways a tool's own screen is shown (tool-screen.tsx SHOWS, and `reads` for the page's own list screens). There is no screen drawn from a tool's input schema. */
const SCREEN_KINDS = new Set(['web-address', 'app-entry', 'module', 'parts', 'reads']);
const OFFERED_ON_A_FILE = new Set(['group', 'icon', 'label', 'about', 'inputs']);
const askedWordsValid = asked => Array.isArray(asked) && asked.length <= screenSpecLimits.asked_lines
  && asked.every(words => typeof words === 'string' && words.trim() && words.length <= screenSpecLimits.asked_chars)
  && new Set(asked.map(words => words.trim().toLowerCase())).size === asked.length;
const askedOf = tool => (Array.isArray(tool.screen?.asked) ? tool.screen.asked.filter(words => typeof words === 'string') : []);
// The words a tool is found by: what it does, its name, its line about itself and the words that asked for its screen.
const toolWords = tool => [tool.job ?? '', tool.label ?? '', tool.description ?? '', ...askedOf(tool)].join(' ');
// What a tool's meaning is read from: what it does, its name and the words that asked for its screen.
const toolMeaning = tool => [tool.job ?? '', tool.label ?? '', ...askedOf(tool)].join(' ');
// NAMESPACE_FILE (src/repo-explorer.mjs) marks an input holding files from this account's namespace by identity:
// a string is one file; a list or an object holds files wherever a string in it is an identity (an edit's sources).
// The task keeps the identities; the run reads each file where it can (see fileInputs).
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fingerprintOf = bytes => '1f:' + bytesToHex(blake3(bytes));

const relayHash = key => bytesToHex(blake3(new TextEncoder().encode(key)));

// An error the caller can act on: what to change, and the call that will work. A tool refused because this account has
// not connected the service it uses names that connection's value (`missing_connection`), so a caller running tools
// for someone else (a booking calendar running its host's tools) can tell "not connected" from "failed".
export class WorkshopError extends Error {
  constructor(message, next_call = null, missing_connection = null) { super(message); this.next_call = next_call; this.missing_connection = missing_connection; }
}
// The request_key a caller sends, kept under the place it was sent from (a pursuit's grant, ...). It is checked as the
// caller sent it: a missing, empty or non-text key would otherwise become nonempty text once prefixed, and two such
// calls would share one task.
export function scopedRequestKey(scope, request_key) {
  if (!nonempty(request_key)) throw new WorkshopError('request_key is required: any unique text. Sending the same request_key again returns the same task instead of running twice.');
  return `${scope}:${request_key}`;
}
// A request that charges, calls or messages someone and was not sent (again): `effect_state` is the ledger's state for
// it (unknown, dispatching, succeeded), or 'in-flight' when this host is sending it right now.
class EffectNotSent extends Error {
  constructor(message, effect_state) { super(message); this.effect_state = effect_state; }
}
// A request refused before anything was sent, and a reply the service answered with: both say nothing happened.
const notSent = message => Object.assign(new Error(message), { not_sent: true });

// The part of JSON Schema a tool contract uses. Written without code generation, because the hosted runtime
// forbids it. Keywords it does not know are ignored rather than guessed at.
// Only a missing top-level declared field can be collected through the durable Workshop seam. Nested requirements
// are grouped under their declared top-level object, while invalid values and undeclared fields remain refusals.
function pendingInputFields(problems, schema) {
  if (!problems.length || !object(schema?.properties)) return null;
  const missing = [];
  for (const problem of problems) {
    const match = /^input\.([^.\[ ]+)(?:\..*)? is required$/.exec(problem);
    if (!match || !Object.hasOwn(schema.properties, match[1])) return null;
    const field = schema.properties[match[1]];
    if (!object(field) || field.writeOnly === true) return null;
    if (!missing.includes(match[1])) missing.push(match[1]);
  }
  return missing.length ? missing : null;
}

// Turn a tool's `invoke` DATA into the concrete call. An object whose only key is `fill` is replaced by a value:
//   { "fill": { "from": "input" } }                                   the whole call input
//   { "fill": { "from": "input", "field": "audio_url" } }             one input field
//   { "fill": { "from": "input", "field": "audio_url", "fetch": "base64" } }   the bytes at that address, base64
//   { "fill": { "from": "task", "field": "request_key" } }            a field of the task
// Callers may name more sources (`extra`), for example the tool row and the last input for an outcome notice.
// Everything else is copied as written.
//
// A tool's request (`request: true`) also reads the grammar other packages' notes are written in, the one
// trade-order's assemble-order-request.py owns (its tests are this port's conformance list). It applies only to
// the request's url, headers and body, and reads facts from the call input:
//   "{a.b}"                                    the whole value: that input fact, keeping its type; required
//   "https://x/{a}/y"                          a hole inside text: substituted (escaped when in the url); required
//   { "const": value }                         this value
//   { "from": "a.b" }                          that input fact; required (a list is walked by position: "things.0.label")
//   { "from": "a.b", "optional": true }        the field is left out when the fact is absent
//   { "from": "a.b", "otherwise": <leaf> }     the next leaf when the fact is absent
//   { "$when": "a.b", "value": <leaf> }         the leaf is left out when the fact is absent
//   { "$time": { "hours": -24 } }              when the run started, moved by days, hours and minutes, as an ISO time
//                                              ("as": "date" gives YYYY-MM-DD), so a scheduled read names its own window
// `query` ({ name: leaf }) is read the same way and added to the address as its query string, a list as repeated
// names; a name whose leaf is left out is not sent.
// (`body_template` is the notes' own name for the body and is read the same way.)
// and `credential_injections` and `credential_mounts` become the names the locked box holds: `secret_name` (or
// `vault_key`) as written, else the service-connections name for `connection_id` + `field_id`.
// `argv` (a container tool's command) reads the same `{ from }` leaves, but its text is passed as written: a braced
// word in a command is the command's, never a hole.
const REQUEST_FIELDS = { url: 'address', headers: 'text', body: 'text', body_template: 'text', query: 'text', argv: 'as-written' };
const OMIT = Symbol('left out');
const TIME_STEPS = { days: 86_400_000, hours: 3_600_000, minutes: 60_000 };
function timeFrom(started, { as, ...moves }) {
  const unknown = Object.keys(moves).filter(name => !TIME_STEPS[name] || !Number.isFinite(moves[name]));
  if (unknown.length) throw new WorkshopError(`$time moves by days, hours and minutes (numbers); ${unknown.join(', ')} is not one of them.`);
  const at = new Date(started + Object.entries(moves).reduce((sum, [name, count]) => sum + count * TIME_STEPS[name], 0)).toISOString();
  return as === 'date' ? at.slice(0, 10) : at;
}
// A path walks objects by key and lists by position ("things.0.address": the first thing's address).
const factAt = (facts, path) => String(path).split('.').reduce((at, part) => (object(at) && Object.hasOwn(at, part) ? at[part] : Array.isArray(at) && /^\d+$/.test(part) ? at[Number(part)] : undefined), facts);
function requiredFact(facts, path) {
  const value = factAt(facts, path);
  if (value === undefined || value === null) throw new WorkshopError(`The request needs input.${path}, and it was not given.`);
  return value;
}
const percent = char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
const forAnAddress = (text, inPath) => {
  if (inPath && (text.startsWith('/') || text.split('/').some(part => part === '.' || part === '..'))) {
    throw new WorkshopError('An address path must stay inside the named resource.');
  }
  const encoded = encodeURIComponent(text).replace(/[!'()*]/g, percent);
  return inPath ? encoded.replace(/%2F/g, '/') : encoded;
};
function fillHoles(text, facts, zone) {
  const whole = text.trim();
  if (whole.startsWith('{') && whole.endsWith('}') && whole.split('{').length === 2) return requiredFact(facts, whole.slice(1, -1));
  const pathEnd = Math.min(...[text.indexOf('?'), text.indexOf('#')].filter(at => at >= 0), text.length);
  return text.replace(/\{([^{}]+)\}/g, (_, path, at) => {
    const value = String(requiredFact(facts, path));
    return zone === 'address' ? forAnAddress(value, at < pathEnd) : value;
  });
}
const hexOf = text => bytesToHex(new TextEncoder().encode(String(text ?? '')));
// The name the locked box keeps one field of one connection under (service-connections' naming rule).
export const connectionFieldName = (connectionId, fieldId) => `service-connection-${hexOf(connectionId)}-field-${hexOf(fieldId)}`;
// A request that says `before_you_have_a_secret` (opening an account, handing back a code) places none, exactly as
// service-connections' own performer (follow-one-written-note-now.py) does.
const heldName = (invoke, item) => (nonempty(item.secret_name) ? item.secret_name : nonempty(item.vault_key) ? item.vault_key : connectionFieldName(invoke.connection_id, item.field_id));
const heldItems = (invoke, field) => (invoke?.before_you_have_a_secret === true || !Array.isArray(invoke?.[field]) ? [] : invoke[field]);
export function credentialInjections(invoke) {
  return heldItems(invoke, 'credential_injections').map(item => ({ secret_name: heldName(invoke, item), placement: item.placement }));
}
// Values a container tool reads as files (`invoke.credential_mounts: [{ field_id | secret_name, mount_path }]`, the
// credentials vault's `resolve-one-credential-mount` input shape), named the same way.
export function credentialMounts(invoke) {
  return heldItems(invoke, 'credential_mounts').map(item => ({ secret_name: heldName(invoke, item), mount_path: item.mount_path }));
}
const FETCHES = {
  base64: bytes => {
    let binary = '';
    for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return btoa(binary);
  },
};
export async function buildInvocation(template, { input, task, extra = {}, needs = {}, fetchBytes = fetch, request = false }) {
  const sources = { input, task, ...extra };
  const fill = async (value, zone = null) => {
    if (Array.isArray(value)) return (await Promise.all(value.map(item => fill(item, zone)))).filter(item => item !== OMIT);
    if (typeof value === 'string') return zone && zone !== 'as-written' ? fillHoles(value, input, zone) : value;
    if (!object(value)) return value;
    const keys = Object.keys(value);
    if (zone && keys.length === 1 && keys[0] === 'const') return value.const;
    if (zone && keys.length === 2 && typeof value.$when === 'string' && keys.includes('value')) {
      const fact = factAt(input, value.$when);
      return fact === undefined || fact === null || fact === '' ? OMIT : fill(value.value, zone);
    }
    if (zone && keys.length === 1 && object(value.$time)) return timeFrom(Date.parse(task?.started_at ?? '') || Date.now(), value.$time);
    if (zone && typeof value.from === 'string' && keys.every(key => key === 'from' || key === 'optional' || key === 'otherwise' || key === 'allow_null')) {
      const found = factAt(input, value.from);
      if (found !== undefined && (found !== null || value.allow_null === true)) return found;
      if ('otherwise' in value) return fill(value.otherwise, zone);
      if (value.optional === true) return OMIT;
      throw new WorkshopError(`The request needs input.${value.from}, and it was not given.`);
    }
    if (keys.length === 1 && object(value.fill)) {
      const { from, field, fetch: as } = value.fill;
      const source = Object.hasOwn(sources, from) ? sources[from] : undefined;
      if (source === undefined) throw new WorkshopError(`The tool's invoke names an unknown source "${from}".`);
      const picked = field === undefined ? source : source?.[field];
      if (!as) return picked;
      if (!FETCHES[as]) throw new WorkshopError(`The tool's invoke asks for an unknown fetch "${as}".`);
      // A file to fetch is on a public site (parts/http-client/do-work/public-address.mjs), judged again at every redirect.
      let response;
      try { response = await fetchPublic(String(picked), { signal: AbortSignal.timeout(30000) }, { fetchImpl: fetchBytes, schemes: ['https:', 'http:'] }); }
      catch (error) { if (error instanceof NotPublicAddress) throw new WorkshopError(`input.${field}: ${error.message}`); throw error; }
      if (!response.ok) throw new WorkshopError(`input.${field} could not be fetched: the address answered ${response.status}. Give an address that serves the file directly.`);
      const limit = Number(needs.max_input_bytes) || MAX_SAVED_BYTES;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > limit) throw new WorkshopError(`input.${field} is ${bytes.length} bytes; this tool takes at most ${limit}.`);
      return FETCHES[as](bytes);
    }
    return Object.fromEntries((await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await fill(item, zone)]))).filter(([, item]) => item !== OMIT));
  };
  if (!request || !object(template)) return fill(template);
  const built = Object.fromEntries(await Promise.all(Object.entries(template).map(async ([key, item]) => [key, await fill(item, REQUEST_FIELDS[key] ?? null)])));
  return {
    ...built,
    ...(template.credential_injections === undefined ? {} : { credential_injections: credentialInjections(template) }),
    ...(template.credential_mounts === undefined ? {} : { credential_mounts: credentialMounts(template) }),
  };
}

// The input a run gets: every namespace file the tool's input_schema marks, handed over where the run can read it. A
// run that reaches the web (a model or http tool, a shared container tool with the network) gets an address that
// reads each file; a container that runs sealed (every tool someone saved or published) gets each file placed inside
// it at /inputs/<identity hex>/<the file's own name>, and that path stands in the input. Returns { input, placements:
// [{ path, open() → the file's bytes as a stream }] }. A host without a namespace cannot run a tool that takes a file.
export async function fileInputs(value, schema, files, { sealed = false } = {}) {
  const placements = [];
  const hand = async identity => {
    if (!sealed) return files.readAddress(identity);
    const placement = inputPlacement(identity, await files.open(identity));
    if (!placements.some(item => item.path === placement.path)) placements.push(placement);
    return placement.path;
  };
  async function walk(item, fieldSchema) {
    if (!object(fieldSchema)) return item;
    if (fieldSchema.format === NAMESPACE_FILE) {
      if (!files) throw new WorkshopError('This tool reads files from your namespace, and this service has none to read them from.');
      const swap = async inner => {
        // A shared reference is never a private identity or a durable byte URL.
        // Stage it for networked and sealed tools alike, through the original
        // grant's current execution/range owner.
        if (sharedNamespaceFileInput(inner)) return placeSharedNamespaceFileInput(inner, files, placements);
        return typeof inner === 'string' && NAMESPACE_IDENTITY.test(inner) ? hand(inner)
          : Array.isArray(inner) ? Promise.all(inner.map(swap))
            : object(inner) ? Object.fromEntries(await Promise.all(Object.entries(inner).map(async ([key, part]) => [key, await swap(part)]))) : inner;
      };
      return swap(item);
    }
    if (Array.isArray(item) && object(fieldSchema.items)) return Promise.all(item.map(inner => walk(inner, fieldSchema.items)));
    if (object(item) && object(fieldSchema.properties)) {
      return Object.fromEntries(await Promise.all(Object.entries(item).map(async ([key, inner]) => [key, Object.hasOwn(fieldSchema.properties, key) ? await walk(inner, fieldSchema.properties[key]) : inner])));
    }
    return item;
  }
  return { input: await walk(value, schema), placements };
}

// A top-level input whose schema names `x-your-records: ["<record type>", ...]` and that the caller left out is filled
// with this account's own records of those types, read through `records` (src/your-records.mjs). A caller who sends
// the field sends the records they mean instead.
export async function yourRecords(value, schema, records) {
  const fields = object(schema?.properties) ? Object.entries(schema.properties) : [];
  const wanted = fields.filter(([key, field]) => Array.isArray(field?.['x-your-records']) && (value?.[key] === undefined || value?.[key] === null));
  if (!wanted.length) return value;
  if (!records) throw new WorkshopError('This tool reads your own records, and this service keeps none to read.');
  const readField = async ([key, field]) => {
    try { return [key, await records.read(field['x-your-records'], { at_most: RECORDS_PER_TOOL_INPUT })]; }
    catch (error) {
      if (!(error instanceof TooManyRecords)) throw error;
      throw new WorkshopError(`${error.message} Send ${key} yourself with the records this run is about.`);
    }
  };
  return { ...value, ...Object.fromEntries(await Promise.all(wanted.map(readField))) };
}
// The records a completed run keeps, from its row's `keeps_records: [{ output_selector, type_field, id_field }]`: every
// record the selector finds (one object or a list), with its type and id read from its own fields.
export function recordsToKeep(tool, output) {
  return (tool.keeps_records ?? []).flatMap(rule => {
    const found = selectDeclaredValue(output, rule.output_selector ?? '$');
    return (Array.isArray(found) ? found : [found]).filter(object).map(value => ({ type: value[rule.type_field], id: value[rule.id_field], value }));
  });
}

// A run's output: the part result_selector names, or the whole raw result. The files a container tool left (its
// invoke.outputs, at files in the raw result) stay in the output under files, since result_selector names where the
// tool's own answer is (a printed line at $.result), never a choice to drop the files it made.
function outputOf(tool, raw) {
  const output = tool.result_selector ? selectDeclaredValue(raw, tool.result_selector) : raw;
  return object(output) && object(raw?.files) && !('files' in output) && !('selector_contract_error' in output) ? { ...output, files: raw.files } : output;
}

// A number a check compares: `{ value }`, `{ output_selector }` or `{ input_field }`, plus an optional `plus`.
const numberAt = (output, selector) => { const found = selectDeclaredValue(output, selector ?? '$'); return typeof found === 'number' ? found : NaN; };
function boundOf(bound, output, input) {
  if (typeof bound === 'number') return bound;
  if (!object(bound)) return NaN;
  const base = bound.value !== undefined ? Number(bound.value)
    : bound.output_selector !== undefined ? numberAt(output, bound.output_selector)
      : bound.input_field !== undefined ? Number(factAt(input, bound.input_field)) : NaN;
  return base + Number(bound.plus ?? 0);
}

// A request body as bytes on the wire, in the encoding the tool's DATA selects. New encodings are one more entry.
const formPairs = (node, prefix = '') => {
  if (Array.isArray(node)) return node.flatMap((item, index) => formPairs(item, prefix ? `${prefix}[${index}]` : String(index)));
  if (object(node)) return Object.entries(node).flatMap(([key, item]) => formPairs(item, prefix ? `${prefix}[${key}]` : key));
  return node === null || node === undefined ? [] : [[prefix, String(node)]];
};
const forAForm = text => encodeURIComponent(text).replace(/[!'()*]/g, percent).replace(/%20/g, '+');
const BODY_ENCODINGS = {
  json: body => ({ text: JSON.stringify(body), content_type: 'application/json' }),
  form: body => ({ text: formPairs(body).map(([key, value]) => `${forAForm(key)}=${forAForm(value)}`).join('&'), content_type: 'application/x-www-form-urlencoded' }),
  // A file sent as the request's whole body (a package uploaded to a store): the body is the file's bytes as base64,
  // filled by the row's invoke (`{ fill: { from: "input", field, fetch: "base64" } }` over a file the input names).
  bytes: body => {
    if (typeof body !== 'string') throw notSent('A body sent as bytes must be the file\'s bytes as base64.');
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
    return { bytes, content_type: 'application/octet-stream' };
  },
};
// What an encoded body sends: its bytes, or its words as UTF-8.
const bodyBytes = encoded => encoded.bytes ?? new TextEncoder().encode(encoded.text);
export function encodeBody(body, encoding = 'json') {
  if (body === undefined || body === null) return null;
  if (!Object.hasOwn(BODY_ENCODINGS, encoding)) throw notSent(`This tool asks for a body encoding "${encoding}" this service does not have.`);
  return BODY_ENCODINGS[encoding](body);
}

const HELD = '[held value]';
const scrubText = (text, texts) => texts.reduce((kept, value) => kept.split(value).join(HELD), String(text));

// A row marked `read_only` that a shipped place answers now, with no price, no key, no schedule and no one's job to
// belong to, is answered at once and kept nowhere (readOnce). It reads only the shared rows, so the Worker decides it
// from the rows it holds (answersOnceFrom) and no call to the account is made to ask.
// What a tool run's own owner (src/tool-run-owner.mjs) does not carry yet, by name: each is run state a kept workshop
// task holds today (a charge and its settlement, counted uses, a computer's lease, a record of what was sent, kept
// records, observations, a relay). tools:execute refuses such a tool rather than running it without that state.
// A tool that changes something at another service (invoke.external_effect: true) runs: the run's own owner journals
// each attempt before it is asked, grants it once and never asks a cut-off one again, which is that tool's effect
// ledger. One whose effect names what it sent or observed (an email kept in Sent) needs that record kept.
function runOwnerGaps(tool, place) {
  const gaps = [];
  if (tool.price_ref || tool.billing) gaps.push('a charge');
  if (tool.use_limits) gaps.push('counted uses');
  if (tool.invoke?.external_effect && tool.invoke.external_effect !== true) gaps.push('a record of what it sent');
  if (tool.invoke?.gateway_relay) gaps.push('a relay');
  if (tool.observes) gaps.push('an observation');
  if (tool.keeps_records) gaps.push('kept records');
  if (tool.result_saved_as_tool) gaps.push('a saved tool result');
  if (credentialMounts(tool.invoke).length) gaps.push('a connection placed in its container');
  return gaps;
}
function readsOnce(tool, shared, { run_at, repeat_every_hours, share, space_authorization, public_run_limits, for_handoff, held }) {
  return tool?.read_only === true && shared.tools.some(item => item.id === tool.id)
    && run_at === undefined && repeat_every_hours === undefined && share === undefined && !space_authorization && !public_run_limits && !for_handoff && held === undefined
    && !tool.price_ref && !tool.billing && !tool.use_limits && !tool.observes && !tool.keeps_records && !tool.result_saved_as_tool;
}
export function answersOnceFrom(shared, request) {
  const { tool_id, input = {}, run_at, repeat_every_hours, space_authorization, public_run_limits, share, for_handoff } = request ?? {};
  if (!nonempty(tool_id) || !nonempty(request.request_key) || !object(input)) return false;
  const tool = shared.tools.find(item => item.id === tool_id);
  const { held } = tool ? splitWriteOnly(input, tool.input_schema) : {};
  return readsOnce(tool, shared, { run_at, repeat_every_hours, share, space_authorization, public_run_limits, for_handoff, held });
}
// Every held value one run touched: its write-only input, and the values placed in its container. `add` takes more as
// they are placed; `value` and `text` replace each of them in whatever the run returns or throws.
function heldInRun(held) {
  const texts = heldTexts(held);
  return {
    add(more) { texts.push(...more.filter(text => text.length > 0)); texts.sort((a, b) => b.length - a.length); },
    value: value => scrubValue(value, texts),
    text: text => scrubText(text, texts),
  };
}
const scrubValue = (value, texts) => {
  if (!texts.length) return value;
  if (typeof value === 'string') return scrubText(value, texts);
  if (Array.isArray(value)) return value.map(item => scrubValue(item, texts));
  return object(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValue(item, texts)])) : value;
};

// Where each held value may be sent. Shared rows decide every connection they name, so a tool a person saved can never
// widen one of those. A connector an account saved itself (a connect row whose provider no shared row connects) decides
// only its own connection, joined only over that account's own saved rows (grantsOf): an outside developer adds a
// service with save_tool and no change to this service, and every shared connection stays as wide as the shared rows.
// Every row copies its source's facts as written: a use row names its connection (`invoke.connection`) and the
// values it places; a connect row names the same connection (`invoke.connects.connection`) and the request that
// checks a key (`connects.verify_request`). A value may go to the host of each plain url of a use row of its
// connection and of that connection's verify request, over https. A hole in the path is fine; a hole in the host
// grants nothing.
const plainHost = url => {
  if (typeof url !== 'string' || !URL.canParse(url)) return null;
  const host = new URL(url).hostname.toLowerCase();
  return host && !/[{}%]/.test(host) ? host : null;
};
// The connection a held value's name belongs to (`connectionFieldName`): its vendor, whether it is an additional
// account of that vendor (`service_connection:<vendor>:<account>`), and its field, or null for any other name.
function connectionOfHeldName(secretName) {
  const match = /^service-connection-([0-9a-f]+)-field-([0-9a-f]+)$/.exec(secretName);
  if (!match || match[1].length % 2) return null;
  let connectionId;
  try { connectionId = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(match[1].match(/../g).map(byte => parseInt(byte, 16)))); }
  catch { return null; }
  const parts = connectionId.split(':');
  if (parts.length < 2 || parts[0] !== 'service_connection' || !parts[1]) return null;
  return { vendor: parts[1], additional_account: parts.length >= 3, field_hex: match[2] };
}
// Additional accounts of a vendor have their own sealed field name. They inherit only
// the vendor's published destination hosts; the box still requires that exact account
// field to exist before it will send anything.
function publishedGrantForInstance(grants, secretName) {
  const named = connectionOfHeldName(secretName);
  if (!named?.additional_account) return null;
  return grants.get(`service-connection-${hexOf(`service_connection:${named.vendor}`)}-field-${named.field_hex}`) ?? null;
}
// The service a connect row connects (`invoke.provider` of a held-values row that carries `invoke.connects`), or null.
const providerOf = tool => (tool?.invoke?.kind === 'held-values' && object(tool.invoke.connects) && nonempty(tool.invoke.provider) ? tool.invoke.provider : null);
/** The connect rows an account connects through: every shared one, then each connector the account saved itself whose
 *  provider no shared row connects, so a saved row never stands in for a service this one ships. */
export function connectRowsOf(sharedTools, savedTools) {
  const taken = servicesShipped(sharedTools);
  return [...sharedTools.filter(tool => object(tool.invoke?.connects)), ...savedTools.filter(tool => providerOf(tool) && tool.status !== 'deleted' && !taken.has(providerOf(tool)))];
}
// Every service a shared connect row connects.
const servicesShipped = sharedTools => new Set(sharedTools.filter(tool => object(tool.invoke?.connects) && nonempty(tool.invoke.provider)).map(tool => tool.invoke.provider));
// Every held value's grant: the shared rows' (connectionsOf), plus the grants an account's own saved rows give the
// connections of its own connectors, and only those.
// Rows read live from a source (`liveTools`, src/live-tool-sources.mjs) add no host of their own: a value they place may
// go only where a shipped row already sends it, or to the host its connection was checked at when it was connected.
function grantsOf(sharedTools, savedTools, liveTools = []) {
  const grants = withLiveRows(connectionsOf(sharedTools), sharedTools, liveTools);
  const shipped = servicesShipped(sharedTools);
  const own = new Set(connectRowsOf(sharedTools, savedTools).map(providerOf).filter(provider => provider && !shipped.has(provider)));
  if (!own.size) return grants;
  for (const [name, grant] of connectionsOf(savedTools)) {
    if (!grants.has(name) && own.has(connectionOfHeldName(name)?.vendor)) grants.set(name, grant);
  }
  return grants;
}
function withLiveRows(grants, sharedTools, liveTools) {
  if (!liveTools.length) return grants;
  const hosts = new Map();
  for (const tool of sharedTools) {
    const connection = tool.invoke?.connects?.connection;
    const host = plainHost(tool.invoke?.connects?.verify_request?.url);
    if (nonempty(connection) && host) hosts.set(connection, host);
  }
  for (const tool of liveTools) {
    const host = hosts.get(tool.invoke?.connection);
    if (!host) continue;
    for (const { secret_name } of credentialInjections(tool.invoke)) {
      const grant = grants.get(secret_name) ?? { tool_id: null, allowed_hosts: [], allowed_schemes: ['https'] };
      if (!grant.allowed_hosts.includes(host)) grant.allowed_hosts.push(host);
      grants.set(secret_name, grant);
    }
  }
  return grants;
}
function connectionsOf(tools) {
  const connects = new Map();
  for (const tool of tools) {
    const connection = tool.invoke?.connects?.connection;
    if (nonempty(connection)) connects.set(connection, { tool_id: tool.id, host: plainHost(tool.invoke.connects.verify_request?.url) });
  }
  const byName = new Map();
  const grantOf = (secret_name, connect) => {
    const grant = byName.get(secret_name) ?? { tool_id: connect?.tool_id ?? null, allowed_hosts: [], allowed_schemes: ['https'] };
    byName.set(secret_name, grant);
    return grant;
  };
  for (const tool of tools) {
    const connect = connects.get(tool.invoke?.connection);
    for (const { secret_name } of credentialInjections(tool.invoke)) {
      const grant = grantOf(secret_name, connect);
      for (const host of [plainHost(tool.invoke.url), connect?.host]) if (host && !grant.allowed_hosts.includes(host)) grant.allowed_hosts.push(host);
    }
    // A value placed in a container is sent nowhere by this service; it only needs its connect tool named.
    for (const { secret_name } of credentialMounts(tool.invoke)) grantOf(secret_name, connect);
  }
  return byName;
}


// What a saved container tool that asked for the network is told: it runs sealed, and needs no network for its files.
const SEALED_WORDS = 'A tool saved here runs without the network, so invoke.internet is not used; leave it out. It needs no network for files: each file input (format "namespace-file") is placed inside the container before it runs and the input holds that local path, like /inputs/<hex>/clip.mp4, and each file it leaves at a path in invoke.outputs with "keep_in": "files" is kept in your files under /Made by tools/<the tool\'s label>/, named from the input when the output has keep_as: { "name_from": [input field names] }, otherwise in a folder named for when the run started.';
const RUN_HINT = { input: '(an object matching input_schema)', request_key: '(any unique text; reuse it only to repeat this exact call)' };

// What a caller sees about one tool. Its words are shown as data, never as instructions.
function toolCard(tool, placementsById, stats, host, madeBy) {
  const places = (tool.placements ?? []).map(id => placementsById.get(id)).filter(Boolean);
  const here = places.find(place => place.reachable_from.includes(host));
  const run = stats ?? { runs: 0, contract_passed: 0, reported_met: 0, reported_failed: 0 };
  return {
    tool_id: tool.id, label: tool.label ?? tool.id, job: tool.job, description: tool.description ?? null,
    // What its maker says it does and cannot do, so an AI reads the limits before it runs the tool.
    ...(tool.can_do ? { can_do: tool.can_do } : {}),
    ...(tool.cannot_do ? { cannot_do: tool.cannot_do } : {}),
    input_schema: tool.input_schema ?? { type: 'object' },
    runs_on: places.map(place => place.label),
    ...(here || !tool.invoke ? {} : { runs_here: false }),
    earlier_runs: run,
    made_by: madeBy,
    ...(tool.price_ref ? { price_ref: tool.price_ref } : {}),
    ...(tool.listed_on ? { listed_on: tool.listed_on } : {}),
    ...(tool.use_limits ? { use_limits: tool.use_limits } : {}),
    ...(tool.billing?.price_micros !== undefined ? { price: { amount: `$${(tool.billing.price_micros / 1e6).toFixed(4)}`, per: tool.billing.per ?? 'call', before_markup: true } } : {}),
    ...(tool.billing?.payers ? { who_can_pay: tool.billing.payers } : {}),
    ...(tool.billing?.measured_by_source ? { measured_by_its_source: tool.billing.measured_by_source } : {}),
    ...(tool.bytes_fingerprint ? { bytes_fingerprint: tool.bytes_fingerprint } : {}),
    // A tool may carry its own human screen (docs: SCREEN in src/workspace/tool-screen.tsx); every list derives from it.
    ...(object(tool.screen) ? { screen: tool.screen } : {}),
    // A tool read live from a public source says whose it is, the licence its source declares and where it was read.
    ...(madeBy === 'a public source' && object(tool.provenance) ? { source: { api: tool.provenance.api ?? null, licence: tool.provenance.licence ?? null, url: tool.provenance.page ?? tool.provenance.description ?? tool.provenance.server ?? null, read_at: tool.provenance.read_at ?? null } } : {}),
    // A row that is only a screen has nothing to run.
    next_call: tool.invoke ? { tool: 'run_tool', arguments: { tool_id: tool.id, ...RUN_HINT } } : null,
    // A tool that says what a person adjusts by hand (its `controls`) is one call from live controls for it.
    ...(object(tool.controls) ? { controls_call: { tool: 'make_controls', arguments: { tool_id: tool.id, intent: '(what the person wants to adjust, in their words)', ...(Array.isArray(tool.controls.subject) && tool.controls.subject.length ? { bind: Object.fromEntries(tool.controls.subject.map(name => [name, '(what it works on)'])) } : {}) } } } : {}),
  };
}

// data():     { tools, placements, licence_classes, notices, prices } shared rows (already decoded)
// store:      { readTask(id), writeTask(task), dueTasks(atMs), nextDueAt(), lastCompleted(toolId), taskCards({ tool_id, limit }),
//               readSavedTools(), readSavedTool(id) → its newest row or null, savedToolsForConnection(connection) → current rows for that connection,
//               savedToolsPage({ after, limit }) → { rows, next } (this account's saved tools in id
//               order, one page, read through an index), writeSavedTool(row, { reply }) (reply(context) is the save's answer, kept with the row in one write where the store keeps command receipts), putBytes(fingerprint, bytes). The task questions are answered from
//               an index of the tasks (src/workshop-tasks.mjs), never by reading every task whole.
//               readBytes?(fingerprint) (describe_tool shows a tool's file texts through it),
//               readEffect(ref), writeEffect(attempt) }. The effect pair is service-connections' external-effect attempt
//               ledger (do-work/external-effect-attempt.ts), one attempt per run of a tool that charges, calls or
//               messages someone; a host without it cannot run such a tool.
// pool:       { recordRun(run), recordReport(report), stats(toolIds, job?) → { [toolId]: counts },
//               relevance?(job, tools) → { [toolId]: 0..1 } | null } — relevance, when present, is meaning similarity
//               between the asked job and each tool's job, in the same embedding space decisions use; null when meaning
//               cannot be had now (src/meaning-or-words.mjs), so find ranks by words and says so
// executors:  { [executor id]: async ({ tool, placement, invocation, input, task, held }) → raw result }.
//               `held` is true when the input carries write-only values.
// host:       which reachability this host has (the deployed service is 'hosted')
// keepAlive:  (promise) → void, so work continues after the reply when it outlasts the wait
// box:        this account's locked box, when the host has one: { check_exists(name) → boolean,
//               send(request, grant) → { status_code, headers, body } }. A value goes in through a connect tool and
//               never comes out: `send` places the named values into a CallExternalRequest
//               ({ url, method, headers, body?, credential_injections: [{ secret_name, placement }], timeout_ms }),
//               sends it only to `grant` ({ allowed_hosts, allowed_schemes }), and hands back the reply with every
//               placed value already replaced by "[held value]" (src/held-values.mjs is the hosted box).
//               `keep(name, value)` puts a value a shared tool's reply carried into the box (it is never read back).
//               `mount([{ secret_name, mount_path }])` gives the host the bytes a SHARED container tool reads as files
//               (`{ mount_path, content_type, source: { kind: 'inline', bytes } }`), placed inside the container as it
//               starts; the runner replaces each of them in whatever the run returns.
//               Executors get `send` only after the request's host is one the connection may be sent to.
// sendFromConnection: (connection id) → a fetch for the places that connection's requests leave from (src/send-from.mjs),
//               or null to send from this host; the box sends that connection's requests through it.
// sendMeter:  { covers(tool), before(tool), after(tool, request, status, text) } counting what a send on the person's own
//               account costs them (src/api-spend.mjs): before may refuse (nothing is sent), after reads the answer's usage.
// connectionFields: (connection id) → { field: value } for the fields its service marks not secret, such as the
//               address of a person's own site; a request using that connection may go only to that address.
// market:     the shared Workshop every account reads: { published() → [{ row, maker }], publishedOne(id) → { row, maker } | null, publish({ row, maker }),
//               priceOne(id) → { row, maker } | null, unpublish({ id, maker }) → boolean }. A published row is a saved row that passed its checks here.
// maker:      this account's opaque maker identity in the market (never its user id).
// payers:     who pays for a call after the person's own connection (src/payers.mjs): { plan({ tool }) → payer | null,
//               take(task), settle(task, { failed, actual_micros }) }. A task records its payer, and every reply says
//               who paid and how much credit is left.
// sourced:    tools read live from where they are described (src/live-tool-sources.mjs): { rows() → tool rows, config
//               (records/live-tool-sources.json), own() → this account's own source rows, put(row), reads(own) → each
//               source as last read }. They are found and run like shared rows, are named "a public source", and add no
//               host a connection may go to beyond the one its connection was checked at.
// sources:    registries asked at find time (src/tool-sources.mjs): { search(job, limit) → { rows, unread },
//               resolve(tool_id) → row | null, kept() → rows, keep(row) }. A registry's tool is kept only after its
//               first checked run.
// access:     { grants(accessRef) → boolean }: whether this account holds an access (from any offer that grants it), for
//             tools whose price names one.
// files:      this account's namespace, when the host has one: { readAddress(identity) → an address that reads the file
//               (a lease-signed web address), open(identity) → { name, byte_length, stream() } its bytes for a sealed
//               container, keep({ name, size, open, media_type }) → { identity, bytes, media_type, name } storing a
//               file a run made. A tool's `format: "namespace-file"` inputs are read through it (see fileInputs), and a
//               container tool's outputs marked `keep_in: "files"` are kept in it.
// records:    this account's own records, when the host keeps them (src/your-records.mjs): { read(types) → the current
//               records of those types, write([{ type, id, value }], { tool_id, task_id }) → [{ type, id }] }. Only a
//               SHARED row reaches them: its `x-your-records` inputs are filled from them, and what its
//               `keeps_records` selects from a completed run's output is kept in them.
// sent:       this account's Sent (src/sent.mjs), when the host keeps it: { keep(value) → { id } }. A completed run of
//               a row whose `invoke.external_effect.sent` maps what it sent keeps one record there under its task id.
// relay:      { url, person } where a SHARED container tool paid through a gateway sends its calls (the `relay` verb,
//               reached by the host's relay route): when such a run starts, its container gets a file at the row's
//               `invoke.gateway_relay.mount_path` holding { url, person, key }, a key that opens the relay for that one
//               run while it works here, instead of the person's own connection values.
// sharedTool: (link, tool_id) → the saved row of a tool another person shared with this account by a link that lets
//               its holder run it (src/record-sharing.mjs releaseSharedTool), read from its owner at every start, begin
//               and describe, so an ended, revoked or someone else's link stops the next run. A run names the link as
//               `share` and keeps it on its task; it runs here, on this account's own connections, as a tool another
//               account made.
// Why a tool cannot be placed on someone's own computer: every tool runs where Trillion runs it.
const RUNS_WHERE_TRILLION_RUNS = 'A tool runs where Trillion runs it, never on a person\'s own computer.';
// What a task says that was left waiting for a person's own computer to run its tool, a way of running tools that
// was retired; it is settled as failed the first time it is read.
const RETIRED_WAIT = 'This tool ran on a computer and that way of running tools was retired.';

// What a run cut off by a restart says; the same request_key starts it over.
const RESTARTED = 'The run stopped without finishing because Trillion restarted while it worked. Nothing was sent to anyone. Send the same run_tool call again, with the same request_key, and it starts over.';
// How many times one run is taken up again after restarts before it is reported as cut off.
const TAKE_UP_AT_MOST = 5;
// How long after a run is cut off it is taken up again, so the restart that cut it off has finished.
const TAKE_UP_AFTER_MS = 5000;

// A remote durable job can reconnect only under an explicit protocol and a
// stable task identity. Ordinary POSTs remain ineligible for automatic replay.
function httpReconnectDuration(tool) {
  const invoke = tool?.invoke;
  if (invoke?.resume_after_restart !== true) return null;
  const key = Object.entries(invoke.headers ?? {}).find(([name]) => name.toLowerCase() === 'idempotency-key')?.[1];
  if (invoke.kind !== 'http' || key?.fill?.from !== 'task' || key.fill.field !== 'task_id') {
    throw new WorkshopError('A reconnecting web tool must send its task_id as its Idempotency-Key.');
  }
  return Math.min(7200000, Number(invoke.timeout_ms) || (Number(invoke.timeout_seconds) || 300) * 1000);
}
// What a run says when every container was busy with other runs (the executor's error carries `no_container_free`):
// the tool never started, so it says nothing about the tool, and the same request_key starts it over.
const NO_CONTAINER_FREE = 'No container was free to run this tool just now, because other runs were using all of them. The tool did not start and nothing was sent to anyone. Send the same run_tool call again in a minute, with the same request_key, and it starts over.';

// Tool sources with no tools to give yet, as a reply carries them: each named with its state and why, and when one is only
// being read for the first time, how soon to ask again (a read made beside the reply is kept for the next call).
const ASK_AGAIN_IN_SECONDS = 5;
const unavailableFields = unavailable => !unavailable?.length ? {} : {
  unavailable_sources: unavailable,
  ...(unavailable.some(source => source.state === 'pending') ? { ask_again_in_seconds: ASK_AGAIN_IN_SECONDS, ask_again: `Some tool sources are being read for the first time and their tools are not listed yet; ask again in ${ASK_AGAIN_IN_SECONDS} seconds.` } : {}),
};

// handedToCaller(task): hears each run handed to the caller's own computer (placement executor caller), after it is
// kept, so the stream route can tell whatever runs tools there; that computer answers it with answer().
export function makeWorkshop({ data, store, pool, executors, host, handedToCaller = () => {}, box = null, sourced = null, connectionFields = null, connections = null, authorizeConnection = null, market = null, maker = null, access = null, payers = null, payouts = null, sources = null, files = null, publishBundle = null, sharedTool = null, records = null, sent = null, execution = null, relay = null, sendFromConnection = null, sendMeter = null, authorizeSpaceTask = async () => {}, authorizeResourceTask = null, fetchBytes = fetch, keepAlive = () => {}, reportRun = null, defaultPublisher = () => false, hostVersion = HOST_VERSION, now = () => new Date() }) {
  // Only tasks running in this isolate. Another host can own a live container for the same person.
  const running = new Set();
  // Resource binding authority belongs to the host's current owner. A descriptor cannot grant itself a
  // transport, runtime ABI or permission; the same check fences resumed tasks and the actual effect boundary.
  async function requireResourceTask(authorization, tool, input) {
    if (!authorization) return;
    if (!object(authorization) || typeof authorizeResourceTask !== 'function') throw new WorkshopError('The current resource admission owner is unavailable.');
    if (!tool || workshopToolVersion(tool) !== authorization.tool_version) throw new WorkshopError('This resource operation pins a different executable definition.');
    if (!Array.isArray(authorization.placements) || !authorization.placements.length) throw new WorkshopError('The resource operation has no admitted execution placement.');
    if (input !== undefined && (authorization.needs ?? []).some(need => !Array.isArray(input.needs) || !input.needs.includes(need))) throw new WorkshopError('This resource operation must retain its selected execution requirements.');
    await authorizeResourceTask(authorization, tool, input);
  }
  // The relays open right now, by the BLAKE3 hash of their key: one per run that reaches a gateway through this host.
  // A key lives only in memory and only while its run works here, so a restart closes every relay with the runs.
  const relays = new Map();
  // Starts in progress by task id, so the same request_key sent twice at once runs once.
  const starting = new Map();
  // A scheduled task whose time has come starts once, however many of its wakes and reads ask at the same moment: the
  // account's own alarm reads each due task (src/standalone-resource-behavior.mjs runDue), as runDue starts them here.
  function startDue(task) {
    const pending = starting.get(task.task_id);
    if (pending) return pending;
    const started = begin(task, { wait_seconds: 0 });
    const settled = started.finally(() => { if (starting.get(task.task_id) === settled) starting.delete(task.task_id); });
    starting.set(task.task_id, settled);
    return settled;
  }
  // Reports change an existing task's evidence, never its execution. Serialize concurrent reports so one cannot
  // overwrite another; the durable pending projection makes a lost pool acknowledgement safe to retry.
  const reporting = new Map();
  const withReport = (id, work) => {
    const operation = (reporting.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    reporting.set(id, operation);
    void operation.finally(() => { if (reporting.get(id) === operation) reporting.delete(id); }).catch(() => {});
    return operation;
  };
  async function poolReportedTask(task) {
    const pending = task.report_pool_pending;
    if (!pending || pool.deferred) return task;
    await pool.recordReport({ tool_id: task.tool_id, report_key: task.report_pool_key, revision: pending.revision, result: pending.result, answered_by: 'person', attribution_basis: 'trusted_person_source' });
    const current = await store.readTask(task.task_id);
    if (current?.report_pool_pending?.revision !== pending.revision) return current ?? task;
    const kept = { ...current, report_pool_pending: null, report_pool_revision: pending.revision };
    await store.writeTask(kept);
    return kept;
  }

  // A task already names where it was placed. Observing its executor or releasing its resources needs only the
  // shared placement DATA; resolving a tool and its connection grants belongs to begin() when work resumes.
  async function taskPlacement(task) {
    return new Map((await data()).placements.map(place => [place.id, place])).get(task.placement);
  }

  function canTakeUp(task, placement) {
    if (task.key_given) return false;
    if (task.http_reconnect_before) return placement?.executor === 'http' && now().getTime() < Date.parse(task.http_reconnect_before);
    return (task.taken_up ?? 0) < TAKE_UP_AT_MOST && executors[placement?.executor]?.resumes;
  }

  // A fresh Worker isolate cannot infer a lost run from its own empty Set. Ask the persisted container for its state
  // before taking up a resumable run. A short grace covers the interval between writing `working` and first contact
  // with the container; long file placement keeps its own durable preparation marker and heartbeat.
  async function resumableRunIsActive(task, placement) {
    const executor = executors[placement?.executor];
    if (!executor?.resumes || !executor.observe) return false;
    const seen = await executor.observe(task, placement);
    // A staged task deliberately leaves the container in preparation state
    // between bounded wakes. Treat that state as resumable work, not as an
    // already-running command: the next read must advance its cursor. A lost
    // staging container also resets immediately instead of waiting through the
    // generic post-restart grace period.
    if (task.input_staging) return seen?.state === 'running' || seen?.state === 'finalizing';
    if (seen?.state === 'preparing' || seen?.state === 'running' || seen?.state === 'finalizing') return true;
    return seen?.state === 'none' && now().getTime() - Date.parse(task.started_at) < 120000;
  }

  // A tool whose row says it charges, calls or messages someone (`invoke.external_effect`, DATA from its service's own
  // how-to row) runs under service-connections' effect ledger, one attempt per logical effect (`ref`: the task, or the
  // tool's sample check). An attempt is recorded as dispatching before anything is sent, and after the send: succeeded,
  // rejected (never sent, or the service answered with a refusal), or unknown (sent, and no answer came back). Unknown
  // and dispatching are never sent again; only a rejected attempt may be. The same ref in flight right now is never
  // sent twice either.
  const effectsInFlight = new Set();
  async function underEffectLedger(tool, { ref, authorization, space_authorization, execution_ref, input = {}, origin = 'unknown', invocation = null, captureResult = () => {} }, send) {
    if (!tool.invoke?.external_effect) {
      if (space_authorization) await authorizeSpaceTask(space_authorization, tool);
      return send();
    }
    if (!store.readEffect || !store.writeEffect) throw new WorkshopError(`${tool.id} charges, calls or messages someone, and this service keeps no record of such sends, so it does not make them.`);
    if (!execution_ref && execution) {
      const source = await execution.begin({ operation: tool.id, capture_kind: 'internal_dispatch', origin });
      execution_ref = source.execution_ref;
      await execution.update(execution_ref, { links: { effect_ref: ref } });
    }
    if (effectsInFlight.has(ref)) throw new EffectNotSent(`${tool.id} is sending this exact request right now, so it is not sent a second time.`, 'in-flight');
    effectsInFlight.add(ref);
    try {
      const decision = decideExternalEffectAttempt({ effectRef: ref, actionRef: tool.id, authorizationRef: authorization, executionRef: execution_ref, prior: await store.readEffect(ref) });
      if (!decision.dispatch) {
        throw new EffectNotSent(decision.attempt.state === 'succeeded'
          ? `${tool.id} already did this, so it is not sent again.`
          : `${tool.id} sent this once and whether it happened is not known, so it is not sent again. Check with the service before asking for it again.`, decision.attempt.state);
      }
      await store.writeEffect(decision.attempt);
      let result;
      try {
        // Last authority read before the executor can cause an external effect.
        if (space_authorization) await authorizeSpaceTask(space_authorization, tool);
        result = await send();
      } catch (error) {
        // A refusal the service answered with (a 4xx) or one made before sending means nothing happened; anything
        // else after the send began (a timeout, a dropped connection, a 5xx) may have happened.
        const refused = error.not_sent === true || (error.service_answered >= 400 && error.service_answered < 500);
        const attempt = recordExternalEffectResult(decision.attempt, { outcome: refused ? 'rejected-before-dispatch' : 'timeout-after-dispatch' });
        const kept = await completeExecutionCapture(execution_ref ?? null, attempt, (_source, value) => store.writeEffect(value));
        captureResult({ effect: attempt, ...(kept.source_capture ? { source_capture: { ...kept.source_capture, effect_ref: ref } } : {}) });
        if (refused) throw error;
        throw new EffectNotSent(`${tool.id} sent its request and no answer came back (${error.message ?? error}), so it may have happened. It is not sent again: check with the service before asking for it again.`, attempt.state);
      }
      // Capture what the provider returned before the output contract is judged. A malformed contract cannot erase
      // an actual send. Descriptor mappings supply provider identity; an absent account is explicitly unknown.
      let attempt = recordExternalEffectResult(decision.attempt, { outcome: 'succeeded' });
      const kept = await completeExecutionCapture(execution_ref ?? null, () => {
        const output = outputOf(tool, result);
        const sentValue = sentFromRun(tool.invoke.external_effect.sent, { output, input });
        const declared = sentFromRun({ kind: 'other', fields: tool.invoke.external_effect.observation ?? {} }, { output, input });
        const endpoint = typeof invocation?.url === 'string' ? new URL(invocation.url) : null;
        const observation = providerObservation({ ...(endpoint ? { provider_origin: endpoint.origin, dispatch_route: `${invocation.method ?? 'POST'} ${endpoint.origin}${endpoint.pathname}` } : {}), provider: sentValue?.provider, account: sentValue?.provider_account,
          object_id: sentValue?.provider_id, response_ref: typeof output?.id === 'string' ? output.id : typeof output?.provider_id === 'string' ? output.provider_id : undefined, connection_id: tool.invoke.connection_id, route: tool.id, ...declared }, { basis: 'provider_response', now: now().toISOString(), origin: result?.kept_for_proof ? 'synthetic' : origin });
        return attempt = recordExternalEffectResult(decision.attempt, { outcome: 'succeeded', remoteEffectRef: observation?.object_id ?? observation?.response_ref, observation });
      }, async (_source, value) => {
        await store.writeEffect(value);
        if (execution_ref && execution) await execution.update(execution_ref, { links: { task_id: ref, effect_ref: ref }, observation: value.observation });
        return value;
      });
      // The dispatching ledger already forbids another send. Keep the actual accepted response available to the
      // task and Sent owners even when only its source/effect finalization failed; reconciliation never dispatches.
      captureResult({ effect: attempt, ...(kept.source_capture ? { source_capture: { ...kept.source_capture, effect_ref: ref } } : {}) });
      return result;
    } finally {
      effectsInFlight.delete(ref);
    }
  }
  // Every tool this account can use. With `only` (a tool id), the same answer for that one tool, read by its id: its
  // saved row and its published row alone, so asking for one tool costs the same however many there are.
  async function everything({ only, share, saving = false, persistedOnly = false, wait = false } = {}) {
    if (!saving) only = boundToolParts(only)?.tool_id ?? only;
    let shared = await data({only});
    // A tool shared with this account by a link (sharedTool) comes first for its own id: the person named the link.
    if (nonempty(share) && !sharedTool) throw new WorkshopError('This service cannot run a tool shared by a link.');
    const through = nonempty(share) ? readToolData([{ payload: await sharedTool(share, only ?? null) }], shared.placements).tools : [];
    const savedRows = only && store.readSavedTool ? [await store.readSavedTool(only)].filter(Boolean) : await store.readSavedTools();
    // A saved tool was first offered when it was saved, unless its row says otherwise.
    const saved = readToolData(savedRows.filter(row => row.status !== 'deleted').map(row => ({ payload: { listed_on: row.saved_at, ...row } })), shared.placements).tools;
    // Private edits/adoptions keep their own bytes and grants. A default
    // publisher's later version cannot replace an account's saved tool, nor
    // turn that saved code into a trusted service definition by id collision.
    const savedIds = new Set(saved.map(tool => tool.id));
    shared = {...shared,tools:shared.tools.filter(tool=>!savedIds.has(tool.id))};
    // An addressed resource's installed definition owns its ordinary execution.
    // Public discovery remains complete; it is fallback for an uninstalled id.
    const localKnown=only&&[...through,...shared.tools,...saved].some(tool=>tool.id===only);
    const discovered = !market || market.independent && localKnown ? [] : only && market.publishedOne ? [await market.publishedOne(only)].filter(Boolean) : await market.published();
    // Each published tool answers as the newest of its releases this Trillion runs (src/tool-releases.mjs).
    const offered=discovered.filter(item=>!savedIds.has(item.row.id)||!(shared.default_makers??[]).includes(item.maker));
    const listed=offered.flatMap(item=>{const row=compatibleRelease(item.row,hostVersion);return row?[{...item,row}]:[];});
    const published = readToolData(listed.map(({ row }) => ({ payload: row })), shared.placements).tools;
    const publishers = new Map([...listed.map(({ row, maker: by }) => [row.id, by]), ...through.map(tool => [tool.id, 'shared by link'])]);
    const requested = only ? [...through, ...shared.tools, ...published, ...saved].find(tool => tool.id === only) : null;
    const tooNew = only && !requested && !saving && !persistedOnly ? offered.find(item => item.row.id === only && !compatibleRelease(item.row, hostVersion)) : null;
    if (tooNew) throw new WorkshopError(`${only} needs Trillion ${oldestNeeded(tooNew.row)} or newer, and this Trillion is ${hostVersion}. Update Trillion, or find another tool for this job.`, { tool: 'find_tool_for_job', arguments: { job: tooNew.row.job ?? only } });
    // Running a known tool never reads unrelated registry tools, live sources or every published price.
    // Saving and saved-state inspection need only this id. Keep all matching rows so the decoder
    // still decides validity and duplicate order; an older provider may ignore the optional registry id. Live
    // sources still fetch and refresh as before. Run/describe/sample resolution keeps every row for its grants.
    const narrow = (saving || persistedOnly) && typeof only === 'string' && Boolean(only);
    const forSave = rows => narrow ? rows.filter(row => row?.id === only || row?.kind === 'tool-placement') : rows;
    const kept = sources && (!only || !requested) ? readToolData(forSave(await (narrow ? sources.kept(only) : sources.kept())).map(payload => ({ payload })), shared.placements).tools : [];
    let live = [];
    let unavailable = [];
    // Diagnostic snapshots use only kept definitions; refreshing a live source can write its cache.
    try {
      if (!persistedOnly && sourced && (!only || !requested && !kept.some(tool => tool.id === only))) {
        // A source never read yet is answered as pending or unavailable, with why, never as a source with no tools. Only a
        // call that searches tools (`wait`) holds for a first read, up to the sources' read budget; a screen never does.
        const read = typeof sourced.catalog === 'function' ? await sourced.catalog({ wait, need: only ?? false }) : { rows: await sourced.rows(), unavailable: [] };
        live = readToolData(forSave(read.rows).map(payload => ({ payload })), shared.placements).tools;
        unavailable = read.unavailable;
      }
    }
    catch { throw new WorkshopError('The live tool sources are unavailable; their current tools could not be checked.'); }
    // Resolve the exact price after registry/live rows, using the same tool precedence as execution.
    const priced = only ? [...through, ...shared.tools, ...published, ...saved, ...live, ...kept].find(tool => tool.id === only) : null;
    const needsPrice = priced?.price_ref && !(shared.prices ?? []).some(price => price.id === priced.price_ref);
    const makerPrices = persistedOnly || !market ? [] : only
      ? needsPrice ? market.priceOne ? [await market.priceOne(priced.price_ref)].filter(Boolean) : market.prices ? await market.prices() : [] : []
      : market.prices ? await market.prices() : [];
    const prices = readToolData(makerPrices.map(({ row }) => ({ payload: row }))).prices;
    const sharedWithPrices = { ...shared, prices: [...(shared.prices ?? []), ...prices] };
    // A person's own connector grants its saved use rows only. A single-tool run still needs that connector,
    // but reads only current saved rows naming the requested connection through the reference index.
    if (!persistedOnly && only && store.readSavedTool) {
      const requested = [...through, ...saved, ...shared.tools, ...published, ...live, ...kept].find(tool => tool.id === only);
      const connection = requested?.invoke?.connection;
      const names = requested ? [...credentialInjections(requested.invoke), ...credentialMounts(requested.invoke)].map(item => item.secret_name) : [];
      const sharedGrants = names.length ? grantsOf(shared.tools, []) : null;
      if (nonempty(connection) && names.some(name => !sharedGrants.has(name))) {
        const related = row => row?.status !== 'deleted' &&
          row?.id !== only && (row?.invoke?.connection === connection || row?.invoke?.connects?.connection === connection);
        const keep = rows => saved.push(...readToolData(rows.filter(related).map(row => ({ payload: row })), shared.placements).tools);
        if (store.savedToolsForConnection) keep(await store.savedToolsForConnection(connection));
        else if (store.savedToolsPage) {
          let after = '';
          do {
            const page = await store.savedToolsPage({ after, limit: 100 });
            keep(page.rows);
            after = page.next;
          } while (after);
        } else keep(await store.readSavedTools());
      }
    }
    // Explicit links and existing non-default publication precedence remain.
    // An account's private row already removed its matching default above.
    const tools = [];
    const seen = new Set();
    for (const tool of [...through, ...shared.tools, ...published, ...saved, ...live, ...kept]) if (!seen.has(tool.id)) { seen.add(tool.id); tools.push(tool); }
    return {
      shared: sharedWithPrices, saved, savedRows, publishers, kept, live, unavailable,
      throughIds: new Set(through.map(tool => tool.id)), sharedIds: new Set(shared.tools.map(tool => tool.id)), savedIds: new Set(saved.map(tool => tool.id)), liveIds: new Set(live.map(tool => tool.id)),
      tools: tools.filter(tool => tool.invoke && tool.placements && (tool.status ?? 'active') === 'active'),
      // Shared rows that are only a screen a person opens (no invoke): never matched to a job or run, but described, granted
      // to a pursuit and placed there like any tool, every one of them, the workspace's own screens (Write, Edit on canvas,
      // Record, Calendar...) included: one catalog, one grant, one part placement. Only the shelf below leaves out a row
      // whose screen names its `surface`, since that screen is already a row of the person's lists (src/workspace/screens.mjs).
      // The account's own screen-only tools (a parts screen with nothing to run) are screens the same way.
      screens: [...shared.tools, ...saved.filter(screenOnly)].filter(tool => !tool.invoke && object(tool.screen) && (tool.status ?? 'active') === 'active'),
      placementsById: new Map(shared.placements.map(place => [place.id, place])), licences: new Map(shared.licence_classes.map(item => [item.id, item])),
    };
  }

  // Who made a tool, in the words every reply uses: a shared row, this account's own (saved, or published by it),
  // another account's published tool, or a registry's tool someone has already run and checked. The one rule find,
  // describe and list share.
  function madeByOf({ throughIds = new Set(), sharedIds, savedIds, liveIds = new Set(), publishers }, tool) {
    if (throughIds.has(tool.id)) return 'another account';
    if (sharedIds.has(tool.id)) return 'shared';
    if (savedIds.has(tool.id) || (maker && publishers.get(tool.id) === maker)) return 'this account';
    if (liveIds.has(tool.id)) return 'a public source';
    return publishers.has(tool.id) ? 'another account' : 'a registry';
  }

  // A tool by id: a known row, or a registry's tool read live by its id.
  // One default publisher's published tool (makeWorkshop defaultPublisher names the makers), read by its id alone.
  async function defaultPublishedTool(shared, id) {
    if (!nonempty(id) || typeof market?.publishedOne !== 'function') return null;
    const found = await market.publishedOne(id);
    const release = found && compatibleRelease(found.row, hostVersion);
    if (!release || !defaultPublisher(found.maker)) return null;
    return readToolData([{ payload: release }], shared.placements).tools.find(item => item.id === id && item.invoke) ?? null;
  }

  async function toolById(everythingNow, id, { resolve = true } = {}) {
    const bound = boundToolParts(id);
    if (bound) {
      const base = await toolById(everythingNow, bound.tool_id, { resolve });
      if (!base || workshopToolVersion(base) !== bound.version) throw new WorkshopError('The bound tool definition changed; resolve the source tool again before continuing.');
      if (!connections) throw new WorkshopError('This host cannot verify the selected source connection.');
      requireCurrentConnection(bound.binding, await connections());
      if (bound.binding.source_id) {
        if (!authorizeConnection) throw new WorkshopError('This host cannot verify the source’s current intent.');
        await authorizeConnection(bound.binding);
      }
      return bindAdmittedTool(base, id, bound.binding);
    }
    const known = everythingNow.tools.find(item => item.id === id);
    if (known || !resolve || !sources || !nonempty(id)) return known ?? null;
    const [found] = readToolData([{ payload: await sources.resolve(id) }].filter(item => item.payload), everythingNow.shared.placements).tools;
    return found ?? null;
  }

  function choosePlacement(tool, { placementsById, licences }, resourceAuthorization = null) {
    const licence = licences.get(tool.licence_class);
    if (!licence) throw new WorkshopError(`${tool.id} has no known licence class, so it cannot run anywhere yet.`);
    const allowedHere = licence.allowed_placements.map(currentPlacement);
    const allowed = (tool.placements ?? []).map(id => placementsById.get(currentPlacement(id))).filter(place => place && allowedHere.includes(place.id)
      && (!resourceAuthorization || resourceAuthorization.placements.map(currentPlacement).includes(place.id)));
    const here = allowed.find(place => place.reachable_from.includes(host) && executors[place.executor]);
    if (here) return { place: here, licence };
    throw new WorkshopError(`${tool.id} cannot run from here: its licence allows ${licence.allowed_placements.join(', ') || 'no placement'}, and none of those can be reached from this service.`, { tool: 'find_tool_for_job', arguments: { job: tool.job } });
  }

  // An input value `{ "from_task": "<task id>", "output_selector": "$.text" }` is the output of an earlier task
  // of this account, so one tool's result feeds the next without passing through the caller.
  async function resolveRefs(value) {
    if (Array.isArray(value)) return Promise.all(value.map(resolveRefs));
    if (!object(value)) return value;
    if (nonempty(value.from_task) && Object.keys(value).every(key => key === 'from_task' || key === 'output_selector')) {
      const earlier = await store.readTask(value.from_task);
      if (!earlier) throw new WorkshopError(`There is no task ${value.from_task} for this account to take output from.`);
      if (earlier.state !== 'completed') throw new WorkshopError(`Task ${value.from_task} is ${earlier.state}; its output can be used once it is completed.`, { tool: 'read_task', arguments: { task_id: value.from_task } });
      const picked = selectDeclaredValue(earlier.output, value.output_selector ?? '$');
      if (object(picked) && 'selector_contract_error' in picked) throw new WorkshopError(`Task ${value.from_task}'s output has no ${value.output_selector}.`);
      return picked;
    }
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await resolveRefs(item)])));
  }

  function priceOf(tool, shared) {
    if (!tool.price_ref) return null;
    const price = shared.prices?.find(item => item.id === tool.price_ref);
    if (!price) throw new WorkshopError(`${tool.id} names a price that is not published, so it cannot run until its maker publishes one.`);
    return price;
  }

  // Outcome notices: a tool whose share of runs meeting its contract drops starts another tool, once per window
  // of runs, in the account whose run crossed the line.
  // Only a notice whose line was crossed looks up the tool it starts, by id; a run never lists every tool for it.
  async function checkNotices(tool) {
    const shared = await data();
    for (const notice of shared.notices ?? []) {
      if (notice.then.tool_id === tool.id) continue;
      const counts = (await (pool.noticeStats??pool.stats)([tool.id]))[tool.id];
      if (!counts || counts.runs < notice.min_runs || counts.contract_passed / counts.runs >= notice.pass_rate_below) continue;
      const lastGood = await store.lastCompleted(tool.id);
      try {
        // A target that cannot be read is recorded below as this notice's failed task; one that does not exist is skipped.
        if (!(await everything({ only: notice.then.tool_id })).tools.some(item => item.id === notice.then.tool_id)) continue;
        const input = await buildInvocation(notice.then.input, { input: {}, task: {}, extra: { tool: { ...tool, repository: tool.provenance?.repository }, last_input: lastGood?.input ?? {} } });
        await start({ tool_id: notice.then.tool_id, input, request_key: `notice:${notice.id}:${tool.id}:${counts.runs - (counts.runs % notice.min_runs)}`, wait_seconds: 0, started_by: notice.id });
      } catch (error) {
        await store.writeTask({ task_id: `notice_${identityOf({ notice: notice.id, tool: tool.id, runs: counts.runs }).slice(0, 26)}`, tool_id: notice.then.tool_id, job: `Re-explore ${tool.id}`, state: 'failed', error: `The notice ${notice.id} could not start: ${error.message}`, started_at: now().toISOString(), reports: [], history: [] });
      }
    }
  }

  // A task left waiting for a person's own computer (a way of running tools that was retired) is settled as failed.
  async function retiredWait(task) {
    if (task.state !== 'working') return task;
    const at = now().toISOString();
    const failed = { ...Object.fromEntries(Object.entries(task).filter(([key]) => key !== 'waiting_on')), state: 'failed', finished_at: at, error: RETIRED_WAIT, history: [...(task.history ?? []), { at, state: 'failed' }] };
    await store.writeTask(failed);
    return failed;
  }

  function view(task) {
    const readAgain = { tool: 'read_task', arguments: { task_id: task.task_id } };
    const next = {
      working: readAgain,
      scheduled: readAgain,
      waiting_for_input: { tool: 'provide_task_input', arguments: { task_id: task.task_id, input_version: task.pending_input?.version, replay_key: '(unique text)', input: '(the requested fields)' } },
      completed: { tool: 'report_result', arguments: { task_id: task.task_id, result: 'met, failed or unknown', summary: '(what happened, in the person\'s words)', answered_by: 'person' } },
      failed: { tool: 'find_tool_for_job', arguments: { job: task.job } },
      for_you_to_run: { tool: 'report_result', arguments: { task_id: task.task_id, result: 'met, failed or unknown', summary: '(what happened)', answered_by: '(who saw it)' } },
    }[task.state];
    return {
      task_id: task.task_id, tool_id: task.tool_id, job: task.job, state: task.state, runs_on: task.placement_label,
      ...(!task.public_run_limits ? { request_key: task.request_key } : {}),
      ...(task.space_authorization ? { space_authorization: task.space_authorization } : {}),
      ...(!task.public_run_limits && task.execution_ref ? { execution_ref: task.execution_ref, execution: task.execution } : {}),
      ...(!task.public_run_limits && task.source_capture ? { source_capture: task.source_capture } : {}),
      ...(!task.public_run_limits && taskEffectBinding(task) ? { binding: taskEffectBinding(task) } : {}),
      ...(task.due_at ? { due_at: task.due_at } : {}),
      ...(task.repeat_every_hours ? { repeat_every_hours: task.repeat_every_hours } : {}),
      ...(task.charge ? { charge: task.charge } : {}),
      ...(task.payment ? { payment: task.payment } : task.payer ? { payment: { paid_by: task.payer.paid_by, ...(task.payer.quote_micros !== undefined ? { quoted: `$${(task.payer.quote_micros / 1e6).toFixed(4)}` } : {}) } } : {}),
      ...(task.started_by ? { started_by: task.started_by } : {}),
      ...(task.output !== undefined ? { output: task.output } : {}),
      ...(task.contract ? { contract: task.contract } : {}),
      ...(task.error ? { error: task.error } : {}),
      ...(task.pending_input ? { pending_input: {
        kind: 'missing_required_inputs', version: task.pending_input.version, fields: task.pending_input.fields.map(({ name, schema }) => ({ name, label: schema?.title ?? name, about: schema?.description ?? null, schema })),
        run_url: `/workshop/runs/${encodeURIComponent(task.task_id)}`,
        submit: `/work/api/workshop/run/${encodeURIComponent(task.task_id)}/input`,
      } } : {}),
      ...(!task.public_run_limits && task.effect ? { effect: task.effect } : {}),
      ...(task.how ? { how: task.how } : {}),
      // What the caller's own computer needs to run it: the input it was given and where it was placed.
      ...(task.state === 'for_you_to_run' ? { input: task.input, placement: task.placement } : {}),
      ...(task.source_link ? { source_link: task.source_link } : {}),
      ...(task.saved_tool ? { saved_tool: task.saved_tool } : {}),
      ...(task.kept_records ? { kept_in_your_records: task.kept_records } : {}),
      ...(task.kept_in_sent ? { kept_in_sent: task.kept_in_sent } : {}),
      ...(task.changes?.length ? { changes: task.changes } : {}),
      ...(task.sent_not_kept ? { sent_not_kept: task.sent_not_kept } : {}),
      started_at: task.started_at, ...(task.finished_at ? { finished_at: task.finished_at, seconds: task.seconds } : {}),
      reports: task.reports ?? [],
      ...(task.last_observation ? { last_observation: task.last_observation } : {}),
      ...(task.observation_unavailable ? { observation_unavailable: task.observation_unavailable } : {}),
      ...(task.report_pool_pending ? { report_pool_pending: true } : {}),
      ...(task.run_pool_pending ? { run_pool_pending: true } : {}),
      ...(task.source_pool_pending ? { source_pool_pending: true } : {}),
      ...(task.state === 'completed' ? { if_you_built_something: 'If you wrote code or a tool to finish this job, save_tool keeps it for the next time.' } : {}),
      next_call: next ?? null,
    };
  }

  // The job-level checks a tool row declares in `verify`. A contract passes only when the output has the declared
  // shape AND these say the job was done. `sample-run` is a precondition: the tool must have done its job on its
  // known sample (checked once per tool identity) before anyone's input is trusted to it.
  // A selected value as the text a contains-check reads: an object or a list as its JSON, so a check on the whole
  // output ($) reads what it holds instead of "[object Object]".
  const selectedText = (output, selector) => {
    const value = selectDeclaredValue(output, selector ?? '$');
    return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  };
  const OUTPUT_CHECKS = {
    'output-contains': (check, output) => selectedText(output, check.output_selector).includes(String(check.text)),
    'output-contains-input': (check, output, input) => nonempty(input?.[check.input_field]) && selectedText(output, check.output_selector).includes(input[check.input_field]),
    // A number the output holds lies between two bounds; each bound is a number, an output field or an input field,
    // optionally widened by `plus` (a moment inside the file: 0 <= $.best.time <= $.duration).
    'output-number-within': (check, output, input) => {
      const value = numberAt(output, check.output_selector);
      const low = check.at_least === undefined ? -Infinity : boundOf(check.at_least, output, input);
      const high = check.at_most === undefined ? Infinity : boundOf(check.at_most, output, input);
      return Number.isFinite(value) && !Number.isNaN(low) && !Number.isNaN(high) && value >= low && value <= high;
    },
    // Two numbers agree within `tolerance` (a rendered length matches the length the edit asked for).
    'output-numbers-close': (check, output, input) => {
      const left = boundOf(check.left, output, input);
      const right = boundOf(check.right, output, input);
      return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= Number(check.tolerance ?? 0);
    },
  };
  function jobProblems(tool, input, output) {
    return (tool.verify ?? []).filter(check => OUTPUT_CHECKS[check.kind] && !OUTPUT_CHECKS[check.kind](check, output, input))
      .map(check => `the output does not show the job was done (${check.kind} on ${check.output_selector ?? '$'})`);
  }
  // The input one run of `tool` gets and the files placed for it, for the sample check and a real run alike.
  const runFiles = (tool, input, fromSharedRow) => fileInputs(input, tool.input_schema, files, { sealed: runsSealed(tool.invoke, fromSharedRow) });

  // A sample run proves the tool works; each file it makes is measured and let go, never kept in the person's Files.
  const SAMPLE_FILES = {
    keep: async ({ name, open, media_type }) => {
      let bytes = 0;
      const body = await open();
      if (body) for await (const chunk of body) bytes += chunk.byteLength;
      return { bytes, media_type, name, kept: false };
    },
  };

  // A tool's own sample's record, kept per account under the tool's code and the sample (passed, failed or owed).
  const sampleKey = (tool, sample) => `sample:${tool.id}:${tool.bytes_fingerprint ?? identityOf(tool.invoke)}:${identityOf(sample)}`;

  // Each sample-run check of a tool and where it stands for this account: checked (it passed), failed, owed to the first
  // computer this account connects (with the tests it names as its evidence), or unchecked.
  async function sampleStates(tool) {
    const states = [];
    for (const sample of (tool.verify ?? []).filter(check => check.kind === 'sample-run')) {
      const kept = await store.readTask(sampleKey(tool, sample));
      states.push({ sample: identityOf(sample), ...(sample.safety ? { safety: sample.safety } : {}),
        state: kept?.passed ? 'checked' : kept?.state === 'owed' ? 'owed' : kept ? 'failed' : 'unchecked',
        ...(kept?.state === 'owed' ? { owed_until: kept.owed_until, evidence: kept.evidence } : {}),
        ...(kept?.checked_at ? { checked_at: kept.checked_at } : {}) });
    }
    return states;
  }

  // Runs each of a tool's own samples that has not passed for this account, where the tool runs; a failure throws. Answers
  // the samples owed to a computer that is not connected (src/workshop-sample-rules.json), which did not run.
  async function sampleChecked(tool, place, reach = {}, held = heldInRun(undefined), space_authorization = null) {
    const samples = (tool.verify ?? []).filter(check => check.kind === 'sample-run');
    // Where the tool runs decides which samples may run there and what an unreached computer means
    // (src/workshop-sample-rules.json): only a sample declared safe runs, and one whose computer is not connected is owed.
    const rule = sampleRuleOf(place);
    const connected = executors[place.executor]?.connected;
    const owed = [];
    for (const sample of samples) {
      const unsafe = rule ? unsafeSample(rule, tool, sample) : null;
      if (unsafe) throw new WorkshopError(unsafe);
      const key = sampleKey(tool, sample);
      const earlier = await store.readTask(key);
      if (earlier?.passed) continue;
      if (rule?.unconnected === 'owed' && typeof connected === 'function' && !(await connected({ tool, placement: place, input: sample.input }))) {
        if (earlier?.state !== 'owed') await store.writeTask({ task_id: key, state: 'owed', passed: false, owed_until: rule.owed_until, evidence: Array.isArray(sample.evidence) ? sample.evidence : [], recorded_at: now().toISOString(), seen: rule.words.owed, history: [], started_by: 'sample-run' });
        owed.push(identityOf(sample));
        continue;
      }
      let passed = false;
      let seen = '';
      let capture = {};
      try {
        const { input: sampleInput, placements } = await runFiles(tool, sample.input, reach.from_shared_row === true);
        const invocation = await buildInvocation(tool.invoke, { input: sampleInput, task: { task_id: key, request_key: key }, needs: tool.needs, fetchBytes, request: true });
        const raw = held.value(await underEffectLedger(tool, { ref: key, authorization: identityOf(sample), space_authorization, origin: 'synthetic', input: sample.input, invocation, captureResult: value => { capture = value; } },
          () => executors[place.executor]({ tool, placement: place, invocation, input: sample.input, task: { task_id: key, request_key: key }, ...reach, ...(files || reach.files ? { files: SAMPLE_FILES } : {}), placements })));
        const output = outputOf(tool, raw);
        // What the sample returned, in words the AI can act on: the value at output_selector as text, or, when there
        // is nothing there, what the output held instead, so a wrong selector is seen at once.
        const found = selectDeclaredValue(output, sample.output_selector ?? '$');
        const absent = object(found) && 'selector_contract_error' in found;
        seen = absent ? `nothing at ${sample.output_selector ?? '$'}; the output was ${JSON.stringify(output)}` : typeof found === 'string' ? found : JSON.stringify(found ?? null);
        passed = !absent && seen.includes(String(sample.contains));
      } catch (error) {
        // A busy pool or a run the platform cut off (a restart: Cloudflare marks it retryable) says nothing about the
        // tool, so nothing about its sample is written down; the run says which and starts over under its request_key.
        if (error?.no_container_free === true || error?.retryable === true) throw error;
        seen = held.text(error.message);
      }
      // A tool's check on its own sample is started by the check (started_by), never by the person.
      await store.writeTask({ task_id: key, state: passed ? 'checked' : 'failed', passed, checked_at: now().toISOString(), seen: seen.slice(0, 600), history: [], started_by: 'sample-run', ...capture });
      if (!passed) throw new WorkshopError(`${tool.id} did not do its job on its own known sample, so it is not trusted with this input. It returned: ${seen.slice(0, 300)}`, { tool: 'find_tool_for_job', arguments: { job: tool.job } });
    }
    return owed;
  }

  // A run of a tool its owner chose to show while it works (reportRun, records/run-progress.json) is shown to the person
  // as it starts and ends; a report that cannot be kept never changes the run.
  async function told(task, tool) {
    if (!reportRun) return;
    try { await reportRun(task, tool); } catch (error) { console.error('showing a run to the person', error); }
  }

  // Terminal task state is authoritative once finish() has written it. Cleanup only releases the executor's
  // resources, so a cleanup or placement lookup failure must be retried later without changing that result.
  async function cleanupTerminalTask(task, place = null) {
    if (task?.state !== 'completed' && task?.state !== 'failed') return;
    try {
      const resolved = place ?? await taskPlacement(task);
      await executors[resolved?.executor]?.cleanup?.(task, resolved);
    } catch (error) {
      console.error('cleaning up a terminal task', error);
    }
  }

  // A raw result becomes the task's output only after it passes the tool's declared contract.
  async function finish(task, tool, outcome, keep = null) {
    const settled = await store.readTask(task.task_id);
    if (settled?.state === 'completed' || settled?.state === 'failed') return settled;
    if(settled?.payment_finish)return finishPaymentCapture(settled,settled.payment_finish.tool,settled.payment_finish.done,settled.payment_finish.outcome);
    const finishedAt = now();
    const done = { ...task, finished_at: finishedAt.toISOString(), seconds: Math.round((finishedAt - new Date(task.started_at)) / 100) / 10 };
    if ('error' in outcome) Object.assign(done, { state: 'failed', error: task.public_run_limits ? 'This run could not be completed.' : outcome.error, ...(outcome.effect && !task.public_run_limits ? { effect: outcome.effect } : {}), ...(outcome.cut_off ? { cut_off: true } : {}) });
    else {
      const output = outputOf(tool, outcome.raw);
      const problems = object(output) && 'selector_contract_error' in output ? [`the result has no ${tool.result_selector}`] : [...schemaProblems(output, tool.output_schema, 'output'), ...jobProblems(tool, task.input, output)];
      Object.assign(done, { state: problems.length ? 'failed' : 'completed', output, contract: { passed: !problems.length, problems } });
    }
    if (store.readEffect) { const effect = await store.readEffect(task.task_id); if (effect) done.effect = effect; }
    if (outcome.effect?.effect_ref) done.effect = outcome.effect;
    if (outcome.source_capture) done.source_capture = outcome.source_capture;
    // What the run changed on the screens that show it, from the tool's declared effects (declared-effects.ts), so every
    // caller (the web, the apps, an AI over MCP) refreshes or patches the same reads.
    if (done.state === 'completed' && !task.public_run_limits && tool.effects) done.changes = effectsAt(tool.effects, 'success', { input: task.input, output: done.output });
    if (done.state === 'completed' && !task.public_run_limits && tool.observes) {
      const captured = outcome.readback_response;
      const observation = captured ? observationFromReadTask(tool, { ...done, output: outputOf(tool, captured.value) }, captured) : null;
      if (observation) done.last_observation = observation;
      else done.observation_unavailable = 'The run has no host-captured read response establishing the declared provider, account, object and route.';
    }
    // A tool whose result is itself a tool (the repository explorer) keeps that tool for this account.
    if (done.state === 'completed' && !task.public_run_limits && tool.result_saved_as_tool) {
      try { done.saved_tool = await saveTool({ descriptor: done.output.descriptor }); }
      catch (error) { Object.assign(done, { state: 'failed', error: `The tool it made could not be kept: ${error.message}` }); }
    }
    // What the run's row says to keep goes into this account's records, only after the output passed its contract.
    if (done.state === 'completed' && !task.public_run_limits && keep && tool.keeps_records) {
      try { done.kept_records = await keep.write(recordsToKeep(tool, done.output), { tool_id: tool.id, task_id: task.task_id }); }
      catch (error) { Object.assign(done, { state: 'failed', error: `Its result could not be kept in your records: ${error.message}` }); }
    }
    // What the run sent out in the world is kept in this account's Sent (src/sent.mjs), when its row maps it
    // (`invoke.external_effect.sent`). A record that cannot be kept is noted on the task and never fails the send.
    const sentMapping = tool.invoke?.external_effect?.sent;
    if (!('error' in outcome) && done.effect?.state === 'succeeded' && !task.public_run_limits && sent && sentMapping) {
      try {
        const value = sentFromRun(sentMapping, { output: done.output, input: task.input });
        if (value) {
          done.kept_in_sent = (await sent.keep({ ...value, id: task.task_id, sent_at: value.sent_at ?? done.finished_at, execution_ref: task.execution_ref, effect_ref: done.effect.effect_ref, observation: done.effect.observation, origin: done.effect.observation?.origin ?? task.execution?.origin ?? 'unknown', by: { tool_id: tool.id, task_id: task.task_id, app: task.caller_app ?? null } })).id;
          if (task.execution_ref && execution) {
            const captured = await completeExecutionCapture(task.execution_ref, { links: { sent_ref: `record:sent:${done.kept_in_sent}` } }, (ref, value) => execution.update(ref, value));
            if (captured.source_capture) done.source_capture = { ...captured.source_capture, effect_ref: done.effect.effect_ref };
          }
        }
      } catch (error) { done.sent_not_kept = `What it sent could not be kept in Sent: ${error.message}`; }
    }
    // The meter: a completed run of a priced tool records its charge on the task.
    if (done.state === 'completed' && task.price) done.charge = { price_id: task.price.id, amount_micros: task.price.amount_micros, currency: task.price.currency, per: task.price.per };
    if(payers&&task.payer){
      // Retain the original accepted result before monetary awaits. Bounded
      // group refunds and lost settlement replies resume this finish only;
      // neither the executor nor its already completed effects run again.
      await store.writeTask({...task,state:'working',payment_finish:{tool,done,outcome:{...(outcome.actual_micros!==undefined?{actual_micros:outcome.actual_micros}:{}),...(outcome.cut_off?{cut_off:true}:{})}}});
    }
    return finishPaymentCapture(task,tool,done,outcome);
  }

  async function finishPaymentCapture(task,tool,done,outcome){
    done={...done};delete done.payment_finish;
    if(payers&&task.payer){
      done.payment=await payers.settle(done,{failed:done.state!=='completed',actual_micros:outcome.actual_micros});
      if(done.payment?.pending)return (await store.readTask(task.task_id))??task;
    }
    // A registry's tool is kept as a row once it has done a checked run, so the next caller finds it with its outcomes.
    if (done.state === 'completed' && !task.public_run_limits && sources && tool.billing?.source) {
      if(pool.deferred){if(sources.retained?.(workshopLearningToolId(tool.id))!==true)done.source_pool_pending=workshopLearnedDefinition(tool);}
      else if(!(await sources.kept()).some(row=>row.id===tool.id))await sources.keep({...tool,kind:'ai-tool-descriptor'});
    }
    if (task.public_run_limits) delete done.input;
    done.history = [...(task.history ?? []), { at: done.finished_at, state: done.state }];
    if (tool.use_limits && done.state === 'failed' && !outcome.cut_off) await store.recordUseFailure(task.task_id);
    if (pool.deferred && !outcome.cut_off) {
      // The original task owns this immutable anonymous projection. Its resource
      // captures summary + delivery obligation in the same terminal transaction.
      done.run_pool_pending ??= { run_key: crypto.randomUUID(), tool_id: workshopLearningToolId(tool.id), tool_version:boundToolParts(tool.id)?.version??task.tool_version??workshopToolVersion(tool), day: done.finished_at.slice(0,10),
        bytes_fingerprint: tool.bytes_fingerprint ?? null, placement: task.placement,
        state: done.state, contract_passed: done.contract?.passed === true, seconds: done.seconds,
        notice_pending: !done.contract?.passed };
    }
    // Only a task that can still resume needs the definition it pinned; a finished one keeps no copy of it.
    if (!outcome.cut_off && done.cut_off !== true) delete done.tool_version;
    await store.writeTask(done);
    if (!task.public_run_limits) await told(done, tool);
    // A run cut off before it could finish (a restart, a busy pool) says nothing about the tool, so it is not pooled.
    if (!outcome.cut_off && !pool.deferred) {
      await pool.recordRun({ tool_id: tool.id, bytes_fingerprint: tool.bytes_fingerprint ?? null, placement: task.placement, state: done.state, contract_passed: done.contract?.passed === true, seconds: done.seconds, job: task.caller_job ?? task.job });
      if (!done.contract?.passed) await checkNotices(tool);
    }
    return done;
  }

  // Everything wrong with a descriptor at once, so an AI fixes it in one more call instead of one field per call. Each
  // line names the field, what it must be, and what this service knows (placements, licence classes, check kinds).
  function descriptorProblems(row, { placementsById, licences, sharedIds, sharedProviders, sent }) {
    const problems = [...observationProblems(row), ...toolLineProblems(row)];
    if (!nonempty(row.id)) problems.push('id: a short unique name for the tool, for example "tool:count-words".');
    else if (sharedIds.has(row.id)) problems.push(`id: ${row.id} is already a shared tool. Pick another id.`);
    if (!nonempty(row.job)) problems.push('job: what the tool does, in plain words, as someone would ask for it ("Count the words in a piece of text"). find_tool_for_job matches on it.');
    if (!object(row.input_schema) || row.input_schema.type !== 'object') problems.push('input_schema: a JSON Schema with "type": "object" and a property for each input the tool takes.');
    if (row.output_schema !== undefined && !object(row.output_schema)) problems.push('output_schema: a JSON Schema for what the tool returns (after result_selector), or leave it out.');
    const invoke = row.invoke;
    // A screen made of shared parts is a whole tool by itself: nothing runs, so it needs no invoke, placement or sample.
    const onlyScreen = screenOnly(row);
    if (!onlyScreen && (!object(invoke) || !nonempty(invoke.kind))) problems.push('invoke: how the tool runs, an object with a kind: "container" (your own code, sent in files), "model" (a hosted model with a fixed prompt) or "http" (a request to a web address that answers JSON).');
    else if (invoke?.kind === 'container') {
      if (!Array.isArray(invoke.argv) || !invoke.argv.length) problems.push('invoke.argv: the command that runs the tool, as a list, run in /work without a shell, for example ["python3", "main.py", {"from": "text"}], where {"from": "text"} is replaced by input.text.');
      if (!sent && !nonempty(invoke.files)) problems.push('files: a container tool needs its code. Send files as {"main.py": "<the file text>"}; they are placed in /work.');
      // A saved tool's files leave its container only into the caller's own namespace.
      if (invoke.outputs !== undefined && !Array.isArray(invoke.outputs)) problems.push('invoke.outputs: a list of the files the tool leaves, each {"name": "video", "path": "/work/out.mp4", "keep_in": "files", "media_type": "video/mp4"}, or {"name": "pages", "folder": "/work/out", "keep_in": "files"} for every file in a folder.');
      (Array.isArray(invoke.outputs) ? invoke.outputs : []).forEach((output, index) => {
        const where = object(output) ? (output.folder === undefined ? output.path : output.folder) : null;
        if (!object(output) || !nonempty(output.name) || !nonempty(where) || !where.startsWith('/') || (output.path !== undefined && output.folder !== undefined)) problems.push(`invoke.outputs[${index}]: needs a name and one full path in the container: "path" for one file ({"name": "video", "path": "/work/out.mp4", "keep_in": "files"}) or "folder" for every file left in it ({"name": "pages", "folder": "/work/out", "keep_in": "files"}).`);
        else if (output.keep_in !== 'files') problems.push(`invoke.outputs[${index}].keep_in must be "files": a file your tool leaves is kept in the files of the person who ran it, and returned at $.files.${output.name}.`);
      });
    }
    else if (invoke?.kind === 'worker-module') {
      if (!nonempty(invoke.module) || !/^[A-Za-z0-9._/-]+\.(?:m?js)$/.test(invoke.module)
        || invoke.module.split('/').some(part => !part || part === '.' || part === '..'))
        problems.push('invoke.module: a JavaScript entry in the saved files, such as "main.mjs".');
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(invoke.export ?? '')) problems.push('invoke.export: the exported function to run, such as "run".');
      if (!sent && !/^1f:[a-f0-9]{64}$/.test(invoke.files ?? '')) problems.push('files: a saved worker module needs its immutable code archive.');
      if (row.bytes_fingerprint !== invoke.files) problems.push('bytes_fingerprint: it must name the same immutable archive as invoke.files.');
      if (invoke.capabilities !== undefined && (!Array.isArray(invoke.capabilities)
        || new Set(invoke.capabilities).size !== invoke.capabilities.length
        || invoke.capabilities.some(name => typeof name !== 'string' || name === 'context' || !/^[a-z][a-z0-9_.:-]{0,95}$/.test(name))))
        problems.push('invoke.capabilities: distinct named capabilities declared by the installed tool; context is reserved.');
      if (invoke.workdir !== undefined && invoke.workdir !== '/work') problems.push('invoke.workdir: saved worker modules use /work.');
    }
    // What a tool run on the person's computer may reach there (harness/wake-handlers/tool-reach.json names the kinds the
    // computer enforces); everything it does not declare is refused there.
    if (row.reach !== undefined && (!Array.isArray(row.reach) || row.reach.some(item => !object(item) || !nonempty(item.kind)))) problems.push('reach: what the tool reaches on the person\'s computer, a list of rows such as {"kind": "files-read", "path": "~/Documents"}, {"kind": "network", "port": 443} or {"kind": "accessibility"}. Leave it out for a tool that needs only its own files.');
    if (providerOf(row) && sharedProviders.has(providerOf(row))) problems.push(`invoke.provider: ${providerOf(row)} is a service Trillion already connects (tool:connect-service-${providerOf(row)}). A connector you save connects a service of its own: give it a provider name no shared tool uses.`);
    const placementsOwed = !onlyScreen || row.placements !== undefined;
    if (placementsOwed && (!Array.isArray(row.placements) || !row.placements.length)) problems.push(`placements: where it runs, a list of placement ids. Known: ${[...placementsById.keys()].join(', ')}.`);
    else if (placementsOwed) {
      const unknown = row.placements.filter(id => !placementsById.has(id));
      if (unknown.length) problems.push(`placements: unknown ${unknown.join(', ')}. ${RUNS_WHERE_TRILLION_RUNS} Known: ${[...placementsById.keys()].join(', ')}.`);
    }
    const licence = licences.get(row.licence_class);
    if (!licence) problems.push(`licence_class: unknown ${row.licence_class ?? '(missing)'}. Known: ${[...licences.keys()].join(', ')}. Your own code is licence:maker-own.`);
    else if (Array.isArray(row.placements) && row.placements.length && !row.placements.some(id => licence.allowed_placements.map(currentPlacement).includes(currentPlacement(id)))) {
      problems.push(`licence_class ${licence.id} lets a tool run only at ${licence.allowed_placements.join(', ')}, and placements names none of those.`);
    }
    if (row.screen !== undefined) {
      if (!object(row.screen)) problems.push('screen: an object. Leave it out for a tool only AIs use, or give it a kind: {"kind": "web-address", "url": "https://..."} (your own web frontend) or {"kind": "app-entry", "entry": "<a Trillion screen>"}.');
      else if (row.screen.kind === undefined) {
        const extra = Object.keys(row.screen).filter(key => !OFFERED_ON_A_FILE.has(key));
        if (extra.length) problems.push(`screen: a screen with no kind only says how the tool is offered on a file (${[...OFFERED_ON_A_FILE].join(', ')}); ${extra.join(', ')} needs a kind: {"kind": "web-address", "url": "https://..."} or {"kind": "app-entry", "entry": "<a Trillion screen>"}.`);
      } else if (!SCREEN_KINDS.has(row.screen.kind)) problems.push(`screen.kind: the way the screen is shown, one of ${[...SCREEN_KINDS].join(', ')}. A tool with no screen of its own declares none.`);
      else if (row.screen.url !== undefined && !/^https:\/\/[^\s]+$/.test(String(row.screen.url))) problems.push('screen.url: a full https:// web address.');
      if (object(row.screen) && row.screen.asked !== undefined && !askedWordsValid(row.screen.asked)) problems.push(`screen.asked: the person's own words that asked for this screen, a list of up to ${screenSpecLimits.asked_lines} different lines of at most ${screenSpecLimits.asked_chars} characters each, like ["timer 25 min"]. The same words typed again open this screen at once.`);
    }
    const verifyOwed = !onlyScreen || row.verify !== undefined;
    if (verifyOwed && (!Array.isArray(row.verify) || !row.verify.length)) problems.push('verify: how to tell the job was done, a list of checks. Include a sample-run: {"kind": "sample-run", "input": {<a real input>}, "output_selector": "$.<field>", "contains": "<text the right answer contains>"}; publish_tool requires one.');
    else if (verifyOwed) {
      const kinds = ['sample-run', ...Object.keys(OUTPUT_CHECKS)];
      row.verify.forEach((check, index) => {
        if (!object(check) || !kinds.includes(check.kind)) problems.push(`verify[${index}].kind must be one of ${kinds.join(', ')}.`);
        else if (check.kind === 'sample-run') {
          if (!object(check.input)) problems.push(`verify[${index}].input: the sample input, an object that matches input_schema.`);
          else if (object(row.input_schema)) problems.push(...schemaProblems(check.input, row.input_schema, `verify[${index}].input`));
          if (check.contains === undefined || check.contains === null || String(check.contains) === '') problems.push(`verify[${index}].contains: text the output at output_selector must contain when the tool worked on the sample.`);
        }
      });
      // Where the tool runs decides which samples may run there (src/workshop-sample-rules.json).
      for (const rule of new Set((Array.isArray(row.placements) ? row.placements : []).map(id => sampleRuleOf(placementsById.get(currentPlacement(id)))).filter(Boolean))) {
        row.verify.forEach((check, index) => {
          const unsafe = object(check) && check.kind === 'sample-run' ? unsafeSample(rule, row, check) : null;
          if (unsafe) problems.push(`verify[${index}].safety: ${unsafe}`);
        });
      }
    }
    return problems;
  }

  // What save_tool and a failed save hand back as the shape to copy.
  const saveExample = { tool: 'save_tool', arguments: SAVE_TOOL_EXAMPLE };

  // Plain text files an AI sends ({ "main.py": "..." }) become one gzipped tar placed in /work, the same bytes every
  // time for the same files, so the tool's identity follows its code.
  function filesAsBytes(files, workdir) {
    if (!object(files) || !Object.keys(files).length) throw new WorkshopError('files must be an object of file names to their text, for example {"main.py": "print(1)"}.', saveExample);
    const root = String(workdir ?? '/work').replace(/^\/+|\/+$/g, '');
    const entries = Object.entries(files).map(([name, text]) => {
      if (!nonempty(name) || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '')) throw new WorkshopError(`files: "${name}" must be a path inside the tool, like "main.py" or "lib/util.py".`, saveExample);
      if (typeof text !== 'string') throw new WorkshopError(`files: "${name}" must be the file's text. Send other bytes as bytes_base64 (a gzipped tar).`, saveExample);
      return { name: `${root}/${name}`, bytes: new TextEncoder().encode(text), executable: text.startsWith('#!') };
    });
    return tarGz(entries);
  }

  // A saved screen is a separate public bundle. The AI names the entry and any sibling modules it intends to import;
  // files omitted from that allowlist remain only in the account's private tool archive.
  async function bindSavedScreen(row, bytes, files) {
    if (row.screen?.kind !== 'module') return;
    try { validateModuleSurfaceRequests(row.screen.requests ?? {}); }
    catch (error) { throw new WorkshopError(error.reason ?? 'screen.requests must declare fixed account paths and supported methods, or typed addressed resource operations with their required inputs.'); }
    const module = row.screen.module;
    const validModulePath = value => nonempty(value) && /\.(?:m?js)$/.test(value)
      && !value.startsWith('/') && !value.includes('\\')
      && value.split('/').every(part => part && part !== '..' && part !== '.' && /^[A-Za-z0-9._~-]+$/.test(part));
    if (!object(module) || !validModulePath(module.file)) {
      throw new WorkshopError('screen.module.file must name a JavaScript file in the files saved with this tool, for example "screen.mjs".');
    }
    if (module.package !== undefined || module.entry !== undefined) throw new WorkshopError('A saved screen uses its own files, not a product package or entry.');
    if (module.files !== undefined && (!Array.isArray(module.files) || module.files.some(file => !validModulePath(file)))) {
      throw new WorkshopError('screen.module.files must be an array of JavaScript file paths in this tool, for example ["lib/view.mjs"]. The entry file is included automatically.');
    }
    const fingerprint = row.bytes_fingerprint ?? row.invoke?.files;
    if (!nonempty(fingerprint)) throw new WorkshopError('Send files with this screen. Its bundle is filled in from those files.');
    const archive = bytes ?? await store.readBytes(fingerprint);
    if (!archive) throw new WorkshopError('The screen\'s saved files could not be read. Send them with the tool.');
    let entries;
    try { entries = untarGz(archive); } catch { throw new WorkshopError('A screen needs files as a gzipped tar archive, or plain file names and text in files.'); }
    const root = String(row.invoke?.workdir ?? '/work').replace(/^\/+|\/+$/g, '');
    const sourceFile = module.source_file ?? module.file;
    if (!validModulePath(sourceFile)) throw new WorkshopError('screen.module.source_file is invalid. Save the tool again from its own files.');
    const sourceName = file => files && Object.hasOwn(files, file) ? `${root}/${file}` : file;
    const entryName = sourceName(sourceFile);
    const requested = [...new Set([sourceFile, ...(module.files ?? [])])];
    const names = requested.map(sourceName);
    const byName = new Map(entries.map(entry => [entry.name, entry]));
    for (const name of names) {
      const entry = byName.get(name);
      if (!entry || entry.text === null) throw new WorkshopError(`screen.module file "${name}" is not a text file in this tool's files.`);
    }
    // A fixed public/ prefix makes the screen archive structurally distinct from the complete private tool archive,
    // even when the tool consists of only the screen entry file.
    const publicNames = names.map(name => `public/${name}`);
    const included = new Set(publicNames);
    const importPatterns = [
      /\bimport\s+(?:[^'";]*?\s+from\s+)?(['"])([^'"]+)\1/g,
      /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
      /\bexport\s+(?:\*|\{[^}]*\})\s+from\s*(['"])([^'"]+)\1/g,
    ];
    for (let index = 0; index < names.length; index += 1) {
      const name = publicNames[index];
      const source = byName.get(names[index]).text;
      for (const pattern of importPatterns) for (const match of source.matchAll(pattern)) {
        const specifier = match[2];
        if (!specifier.startsWith('.')) continue;
        let imported;
        try { imported = new URL(specifier, `https://screen.invalid/${name}`).pathname.slice(1); }
        catch { throw new WorkshopError(`screen.module file "${name}" has an invalid relative import.`); }
        if (!included.has(imported)) throw new WorkshopError(`screen.module file "${name}" imports "${specifier}", which is not listed in screen.module.files.`);
      }
    }
    const screenBytes = tarGz(names.map((name, index) => ({ name: publicNames[index], bytes: new TextEncoder().encode(byName.get(name).text) })));
    const screenFingerprint = fingerprintOf(screenBytes);
    row.screen = { ...row.screen, runtime: 'isolated', module: { bundle: screenFingerprint, file: `public/${entryName}`, source_file: entryName, files: names.filter(name => name !== entryName) } };
    return { identity: screenFingerprint, bytes: screenBytes };
  }

  // A screen made of shared parts carries no files: its spec is checked against each part's declared props (and fixed
  // where it can be, the fixes said back), its requests are the same declarations a module screen makes, and a screen
  // with nothing to run gets the screen-only licence when it names none. Answers what was fixed.
  function bindPartsScreen(row) {
    if (row.screen?.kind !== PARTS_SCREEN) return [];
    try { validateModuleSurfaceRequests(row.screen.requests ?? {}); }
    catch (error) { throw new WorkshopError(error.reason ?? 'screen.requests must declare fixed account paths and supported methods, or typed addressed resource operations with their required inputs.'); }
    const { spec, fixes, problems } = checkSpec(row.screen.spec, { requests: row.screen.requests ?? {} });
    if (problems.length) throw new WorkshopError(`The screen was not saved. Fix all of these and send it again:\n- ${problems.join('\n- ')}`);
    row.screen = { ...row.screen, spec };
    if (screenOnly(row) && row.licence_class === undefined) row.licence_class = SCREEN_ONLY_LICENCE;
    return fixes;
  }

  // `check` (default true) runs the tool's own sample-run right after saving, so the AI learns now, not at publish,
  // whether the tool does its job. The tool is kept either way; a failed check says what it returned.
  async function saveTool({ descriptor, bytes_base64, files, check = true, open_now, screen_input }) {
    if (!object(descriptor)) throw new WorkshopError('descriptor is required. Copy the example in next_call and change it for your tool.', saveExample);
    const { shared, tools, savedRows, placementsById, licences } = await everything({ only: descriptor.id, saving: true });
    const row = { ...descriptor, kind: 'ai-tool-descriptor', status: 'active' };
    if (files !== undefined && bytes_base64 !== undefined) throw new WorkshopError('Send the tool\'s code as files or as bytes_base64, not both.', saveExample);
    let bytes = null;
    if (files !== undefined) bytes = filesAsBytes(files, row.invoke?.workdir);
    if (bytes_base64 !== undefined) {
      if (!nonempty(bytes_base64)) throw new WorkshopError('bytes_base64 must be the tool\'s files as a base64 gzipped tar. Or send files as {"main.py": "<text>"} instead.', saveExample);
      bytes = Uint8Array.from(atob(bytes_base64), char => char.charCodeAt(0));
    }
    if (bytes) {
      if (bytes.length > MAX_SAVED_BYTES) throw new WorkshopError(`The files are ${bytes.length} bytes; at most ${MAX_SAVED_BYTES} can be saved.`);
      const fingerprint = fingerprintOf(bytes);
      if (row.bytes_fingerprint !== undefined && row.bytes_fingerprint !== fingerprint) throw new WorkshopError(`bytes_fingerprint does not match the files: they are ${fingerprint}. Leave it out and it is filled in.`);
      row.bytes_fingerprint = fingerprint;
      // Executable archives always run the exact bytes admitted here.
      if (object(row.invoke) && ['container', 'worker-module'].includes(row.invoke.kind)) {
        if (row.invoke.files !== undefined && row.invoke.files !== fingerprint) throw new WorkshopError(`invoke.files names ${row.invoke.files}, and the files sent are ${fingerprint}. Leave invoke.files out and it is filled in.`);
        row.invoke = { ...row.invoke, files: fingerprint };
      }
    }
    if (row.invoke?.kind === 'worker-module' && bytes) {
      let entries;
      try { entries = untarGz(bytes, { maxBytes: MAX_SAVED_BYTES }); }
      catch { throw new WorkshopError('The worker module files must be a gzipped tar archive.'); }
      const entry = `work/${row.invoke.module}`;
      if (entries.filter(file => file.name === entry && file.text !== null).length !== 1)
        throw new WorkshopError('invoke.module must name exactly one JavaScript source file in the saved archive.');
    }
    const screenArchive = await bindSavedScreen(row, bytes, files);
    const screenFixes = bindPartsScreen(row);
    const problems = descriptorProblems(row, { placementsById, licences, sharedIds: new Set(shared.default_makers?.includes(maker) ? [] : shared.tools.map(tool => tool.id)), sharedProviders: servicesShipped(shared.tools), sent: Boolean(bytes) });
    const admitted = problems.length ? null : admitToolDescriptor(row);
    if (admitted && 'refused' in admitted) problems.push(admitted.refused.reason);
    if (problems.length) throw new WorkshopError(`The tool was not saved. Fix all of these and send it again:\n- ${problems.join('\n- ')}`, saveExample);
    const tool = admitted.item;
    if (screen_input !== undefined && (tool.screen?.kind !== 'module' || !object(screen_input))) {
      throw new WorkshopError('screen_input must be an object and is available only for a saved module screen.');
    }
    if (bytes) await store.putBytes(tool.bytes_fingerprint, bytes);
    if (screenArchive) await store.putBytes(screenArchive.identity, screenArchive.bytes);
    if (screenArchive && publishBundle) await publishBundle(screenArchive.identity);
    const savedAt = now().toISOString();
    const savedRow = { ...row, saved_at: savedAt };
    const previousSaved = savedRows.find(item => item.id === tool.id && item.status !== 'deleted') ?? null;
    let privateContext;
    // What the save answers, from the saved row and its private screen context. The store keeps this reply with the
    // row in one write (`reply`), so a save whose invocation is gone answers the same reply when it is asked again.
    const replyOf = context => ({
      tool_id: tool.id, ...(tool.bytes_fingerprint ? { bytes_fingerprint: tool.bytes_fingerprint } : {}),
      visible_to: 'only the account that saved it', replaced: tools.some(item => item.id === tool.id),
      ...(tool.invoke?.internet === true ? { network: SEALED_WORDS } : {}),
      next_call: { tool: 'run_tool', arguments: { tool_id: tool.id, ...RUN_HINT } },
      ...(screenFixes.length ? { screen_fixes: screenFixes } : {}),
      ...((screenArchive && tool.screen?.kind === 'module' || tool.screen?.kind === PARTS_SCREEN) && open_now !== false ? { 'trillion/screen': {
        id: 'trillion.use-tool', label: tool.label ?? tool.id,
        input: { tool_id: tool.id, ...(context?.screen_context_id ? { screen_context_id: context.screen_context_id } : {}) },
        address: `/use/${encodeURIComponent(tool.id)}`,
        presentation: 'focused',
      } } : {}),
    });
    const hasPrivateOwner = typeof store.writeScreenContext === 'function' && typeof store.preserveScreenContext === 'function' && typeof store.forgetScreenContext === 'function';
    if (screen_input !== undefined && !hasPrivateOwner) throw new WorkshopError('This Workshop cannot safely retain private screen input. No screen input was saved.');
    if (hasPrivateOwner && typeof store.saveScreenTool === 'function') {
      await store.authorizeScreenToolWrite?.({ tool_id: tool.id, current_tool: tools.find(item => item.id === tool.id) ?? null });
      privateContext = await store.saveScreenTool({ row: savedRow, input: screen_input, has_input: screen_input !== undefined, expected_saved_at: previousSaved?.saved_at ?? null, expected_version: previousSaved ? workshopToolVersion(previousSaved) : null, preserve: Boolean(previousSaved) && tool.screen?.kind === 'module', reply: replyOf });
    } else {
      if (screen_input !== undefined) throw new WorkshopError('This Workshop cannot atomically retain private screen input. No screen input was saved.');
      await store.writeSavedTool(savedRow, { reply: replyOf });
    }
    const saved = replyOf(privateContext ?? null);
    if (!check || !(tool.verify ?? []).some(item => item.kind === 'sample-run')) return saved;
    return { ...saved, sample_check: await checkOnSample(tool) };
  }

  // Runs a tool's own sample where it would run, for at most the usual wait. The check keeps going after the reply.
  async function checkOnSample(tool) {
    let place, available;
    try {
      available = await everything({ only: tool.id });
      ({ place } = choosePlacement(tool, available));
    }
    catch (error) { return { passed: false, said: error.message }; }
    if (place.executor === 'caller') return { passed: null, said: 'This tool runs on each caller\'s own computer, so its sample is not run here.' };
    const held = heldInRun(undefined);
    const work = requireEnabledCapability(tool, available).then(() => sampleChecked(tool, place, executionReach(tool, available, held), held)).then(owed => (owed.length ? { passed: null, said: sampleRuleOf(place).words.owed } : { passed: true, said: 'It did its job on its own sample.' }), error => (error?.no_container_free === true ? { passed: null, said: NO_CONTAINER_FREE }
      : error?.retryable === true ? { passed: null, said: 'Trillion restarted while its sample ran. save_tool again, or run_tool on the sample input, checks it.' } : { passed: false, said: error.message }));
    keepAlive(work);
    let timer;
    const done = await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(null), WAIT_SECONDS.default * 1000); })]);
    clearTimeout(timer);
    return done ?? { passed: null, said: 'Its sample is still running. run_tool on the sample input shows the result.' };
  }

  // A run handed to the caller's own computer (for_you_to_run) is claimed by one computer before it runs it, so two
  // computers that both heard it never both run it. One claim at a time per run (`claiming`); a claim is held for
  // `lease_seconds` (60 s to a day), after which a computer that stopped without answering can be followed by another.
  const claiming = new Map();
  const submittingInput = new Map();
  async function claimCallerRun({ task_id, by, lease_seconds } = {}) {
    if (!nonempty(task_id) || !nonempty(by)) throw new WorkshopError('task_id and by are needed: the run, and the computer claiming it.');
    const lease = Math.min(Math.max(Number(lease_seconds) || 60, 60), 86_400) * 1000;
    const turn = (claiming.get(task_id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const task = await store.readTask(task_id);
      if (!task) throw new WorkshopError(`There is no run ${task_id}.`);
      if (task.state !== 'for_you_to_run') return { claimed: false, state: task.state };
      const held = task.claimed_by && task.claimed_by !== by && now().getTime() - Date.parse(task.claimed_at ?? 0) < (task.claim_lease_ms ?? 0);
      if (held) return { claimed: false, state: task.state, claimed_by: task.claimed_by };
      const everythingNow = await everything({ only: task.tool_id, share: task.share });
      const tool = await toolById(everythingNow, task.tool_id);
      if (task.resource_authorization) await requireResourceTask(task.resource_authorization, tool, task.input);
      await store.writeTask({ ...task, claimed_by: by, claimed_at: now().toISOString(), claim_lease_ms: lease });
      return claimedReply(task, tool, everythingNow);
    });
    claiming.set(task_id, turn);
    turn.finally(() => { if (claiming.get(task_id) === turn) claiming.delete(task_id); }).catch(() => {});
    return turn;
  }

  // The computer that holds the run gets the tool as saved: its descriptor, who made it, and its code archive, whose
  // fingerprint that computer checks before running a byte of it. A tool whose placement runs on the caller's computer
  // is code its maker chose to run there, so another maker's archive is handed to the run's own computer only.
  async function claimedReply(task, tool, everythingNow) {
    const fingerprint = typeof tool?.invoke?.files === 'string' ? tool.invoke.files : tool?.bytes_fingerprint;
    const archive = fingerprint && store.readBytes ? await store.readBytes(fingerprint) : null;
    return {
      claimed: true, state: task.state,
      ...(tool ? { descriptor: tool, made_by: madeByOf(everythingNow, tool) } : {}),
      ...(archive ? { bytes_fingerprint: fingerprint, bytes_base64: FETCHES.base64(new Uint8Array(archive)) } : {}),
    };
  }

  // Lost caller-computer calls read from the run they changed, never by asking again (a readback only reads):
  //   claim: the run held by this computer is that claim (answered as it answered); held by another computer, the lease
  //          may have passed it on; held by none, never claimed.
  //   answer: a finished run is answered as a repeat answers it; a run still waiting with no payment begun was never
  //          finished; anything else stopped part way.
  async function claimOutcome({ task_id, by } = {}) {
    const task = nonempty(task_id) && nonempty(by) ? await store.readTask(task_id) : null;
    if (!task) return { state: 'aborted' };
    if (task.claimed_by !== by) return task.claimed_by ? { state: 'unknown' } : { state: 'aborted' };
    const everythingNow = await everything({ only: task.tool_id, share: task.share });
    return { state: 'committed', result: await claimedReply(task, await toolById(everythingNow, task.tool_id), everythingNow) };
  }
  async function answerOutcome({ task_id } = {}) {
    const task = nonempty(task_id) ? await store.readTask(task_id) : null;
    if (!task) return { state: 'aborted' };
    if (task.state === 'completed' || task.state === 'failed') return { state: 'committed', result: { ...view(task), repeated: true } };
    return task.state === 'for_you_to_run' && !task.payment_finish ? { state: 'aborted' } : { state: 'unknown' };
  }

  // A run handed to the caller's own computer (for_you_to_run), answered by that computer: `raw` is what the tool
  // returned there, in the shape the container road returns ({ stdout, stderr, exit_code, result }), or `error` is what
  // went wrong. The same finish checks it against the tool's contract, so read_task reads it like any run. The stream
  // route's helper answers through here; an answered run is returned as it is.
  async function answerCallerRun({ task_id, raw, error } = {}) {
    if (!nonempty(task_id)) throw new WorkshopError('task_id is needed: the run to answer.');
    const task = await store.readTask(task_id);
    if (!task) throw new WorkshopError(`There is no run ${task_id}.`);
    if (task.space_authorization) await authorizeSpaceTask(task.space_authorization, await toolById(await everything({ only: task.tool_id }), task.tool_id));
    if (task.state === 'completed' || task.state === 'failed') return { ...view(task), repeated: true };
    if (task.state !== 'for_you_to_run') throw new WorkshopError(`${task_id} is ${task.state}, not waiting for its caller's computer.`);
    if (raw === undefined && !nonempty(error)) throw new WorkshopError('Give raw (what the tool returned) or error (what went wrong).');
    const tool = await toolById(await everything({ only: task.tool_id, share: task.share }), task.tool_id);
    if (!tool) throw new WorkshopError(`There is no tool ${task.tool_id} any more.`);
    await requireResourceTask(task.resource_authorization, tool, task.input);
    return view(await finish(task, tool, raw !== undefined ? { raw } : { error: String(error).slice(0, 600) }));
  }

  // A tool's whole row, so an AI can learn from how any tool is written: its invoke, placements, licence class and
  // checks, and the text of its files when it has them. A shared row that is only a screen (`screens` below) is
  // described too, since its own screen is drawn from this row; there is nothing of it to run.
  async function describeTool({ tool_id, share, include_files = true }) {
    if (share !== undefined && !nonempty(share)) throw new WorkshopError('share is the link someone sent you for this tool.');
    const everythingNow = await everything({ only: tool_id, share });
    // A screen that is one of the workspace's own (its row names a surface) is not shelved twice, but it is described:
    // an AI reads what it takes (input_schema, controls) like any other tool's.
    const tool = await toolById(everythingNow, tool_id) ?? everythingNow.screens.find(item => item.id === tool_id)
      ?? everythingNow.shared.tools.find(item => item.id === tool_id && !item.invoke && object(item.screen) && (item.status ?? 'active') === 'active') ?? null;
    if (!tool) throw Object.assign(new WorkshopError(`There is no tool ${tool_id}. find_tool_for_job lists tools by job.`, { tool: 'find_tool_for_job', arguments: { job: '(the job in plain words)' } }), { status: 404 });
    const madeBy = madeByOf(everythingNow, tool);
    const fingerprint = typeof tool.invoke?.files === 'string' ? tool.invoke.files : tool.bytes_fingerprint;
    let files;
    if (include_files && fingerprint && store.readBytes && madeBy !== 'another account') {
      const bytes = await store.readBytes(fingerprint);
      if (bytes) {
        try { files = untarGz(bytes).map(entry => (entry.text !== null ? { name: entry.name, text: entry.text } : { name: entry.name, bytes: entry.size })); }
        catch { files = undefined; }
      }
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

  async function screenContext({ tool_id, screen_context_id }) {
    const tool = store.readSavedTool ? await store.readSavedTool(tool_id) : (await store.readSavedTools()).find(item => item.id === tool_id);
    if (!tool && screen_context_id === undefined) return { input: { tool_id } };
    if (!tool || tool.status === 'deleted' || tool.screen?.kind !== 'module' || !store.readScreenContext) throw Object.assign(new WorkshopError('This saved screen context is unavailable.'), { status: 410 });
    const resolved = store.readScreenContext({ tool_id, screen_context_id, current_tool: tool });
    if (!resolved && screen_context_id !== undefined) throw Object.assign(new WorkshopError('This saved screen context has changed. Reopen the current saved screen.'), { status: 410 });
    return resolved ?? { input: { tool_id } };
  }

  // A saved tool this account never published (or withdrew) can be deleted: it is no longer found or run, and its id
  // can be saved again. Its earlier rows stay in the account's history.
  async function deleteTool({ tool_id }) {
    const everythingNow = await everything({ only: tool_id });
    if (!everythingNow.saved.some(item => item.id === tool_id)) throw new WorkshopError(`${tool_id} is not one of this account's saved tools.`);
    if (everythingNow.publishers.get(tool_id) === maker && maker) throw new WorkshopError(`${tool_id} is published. Withdraw it with unpublish_tool first; then it can be deleted.`, { tool: 'unpublish_tool', arguments: { tool_id } });
    if (store.deleteScreenTool) {
      const prior = everythingNow.savedRows.find(item => item.id === tool_id);
      await store.authorizeScreenToolWrite?.({ operation: 'tools:delete', tool_id });
      await store.deleteScreenTool({ row: { id: tool_id, status: 'deleted', deleted_at: now().toISOString() }, expected_saved_at: prior.saved_at ?? null, expected_version: workshopToolVersion(prior) });
    }
    else if (store.transaction) await store.transaction(() => { store.forgetScreenContext?.(tool_id); store.writeSavedTool({ id: tool_id, status: 'deleted', deleted_at: now().toISOString() }); });
    else { await store.forgetScreenContext?.(tool_id); await store.writeSavedTool({ id: tool_id, status: 'deleted', deleted_at: now().toISOString() }); }
    return { tool_id, deleted: true };
  }

  // Publishing puts one of this account's saved tools in the shared Workshop, where every account's AI can find
  // and run it. It must do its job on its own known sample where it will run for others (a deployed placement its
  // licence allows, never the caller's sandbox), and it may name a published price. The row carries names of
  // connections, never values: each caller's own locked box supplies them when that caller runs it.
  async function publishTool({ tool_id, price_ref, usage_price, show_on_public_site = false, public_run }) {
    if (!market || !maker) throw new WorkshopError('Publishing is only possible on the deployed service.');
    const everythingNow = await everything({ only: tool_id });
    const tool = everythingNow.saved.find(item => item.id === tool_id);
    if (!tool) throw new WorkshopError(`${tool_id} is not one of this account's saved tools. Save it with save_tool first.`, { tool: 'save_tool', arguments: { descriptor: '(the tool)' } });
    const original = structuredClone(everythingNow.savedRows.find(item => item.id === tool_id && item.status !== 'deleted'));
    const originalVersion = workshopToolVersion(tool);
    const publicationCurrent = async () => {
      const current = store.readSavedTool ? await store.readSavedTool(tool_id)
        : (await store.readSavedTools()).find(item => item.id === tool_id && item.status !== 'deleted');
      if (!current || current.status === 'deleted' || current.saved_at !== original.saved_at
        || workshopToolVersion(current) !== originalVersion)
        throw new WorkshopError('This tool changed while it was being checked for publication. Publish its current version so that version is checked.');
    };
    let publicRun;
    try { publicRun = checkedPublicRunPermission(public_run); }
    catch (error) { throw new WorkshopError(error.message); }
    if (publicRun && (!show_on_public_site || price_ref !== undefined || usage_price !== undefined || !publicRunEligible({ ...tool, show_on_public_site: true }))) {
      throw new WorkshopError('public_run is available only for a public-site tool that runs in a no-network container without credentials, external effects, or a visitor price.');
    }
    // Its sample runs here, so this Trillion must be one the release runs on.
    if (!compatibleRelease(original, hostVersion)) throw new WorkshopError(`${tool_id} says it needs Trillion ${original.minimum_host_version} or newer, and the Trillion publishing it is ${hostVersion}, so its sample cannot be checked here.`);
    if (!(tool.verify ?? []).some(check => check.kind === 'sample-run')) throw new WorkshopError(`${tool_id} has no sample-run check, so nobody else can tell it does its job. Add one to verify and save it again.`);
    const { place, licence } = choosePlacement(tool, everythingNow);
    if (place.executor === 'caller') throw new WorkshopError(`${tool_id}'s licence (${licence.label ?? licence.id}) lets it run only in each caller's own sandbox, so it cannot be offered to everyone from here.`);
    if (price_ref !== undefined && usage_price !== undefined) throw new WorkshopError('Choose either an existing offer price or a price for each completed run.');
    if (price_ref !== undefined && !everythingNow.shared.prices?.some(item => item.id === price_ref)) throw new WorkshopError(`There is no published price ${price_ref}. Known prices: ${(everythingNow.shared.prices ?? []).map(item => item.id).join(', ') || 'none'}.`);
    if (tool.billing?.payers?.includes('trillion-credit') && usage_price === undefined) throw new WorkshopError('Set the Marketplace usage price when publishing this tool, so the charge belongs to this maker.');
    if (usage_price !== undefined && tool.billing) throw new WorkshopError('This tool already has billing terms. Remove those before setting a Marketplace usage price, so a run has one charge.');
    if (usage_price !== undefined && (!object(usage_price) || !Number.isSafeInteger(usage_price.amount_micros) || usage_price.amount_micros < 100 || usage_price.amount_micros % 100 !== 0 || usage_price.currency !== 'usd')) throw new WorkshopError('usage_price needs USD in whole $0.0001 steps. For $0.01, amount_micros is 10000.');
    const price = usage_price === undefined ? null : {
      kind: 'tool-price', id: `price:${identityOf({ maker, tool_id, amount_micros: usage_price.amount_micros, currency: 'usd' }).slice(0, 32)}`,
      label: tool.label ?? tool.job, amount_micros: usage_price.amount_micros, currency: 'usd', per: 'completed run',
    };
    const held = heldInRun(undefined);
    await sampleChecked(tool, place, executionReach(tool, everythingNow, held), held);
    await publicationCurrent();
    const { saved_at, price_ref: savedPriceRef, ...kept } = original;
    if (typeof show_on_public_site !== 'boolean') throw new WorkshopError('Choose true or false for show_on_public_site.');
    const previous = market.publishedOne ? await market.publishedOne(tool_id) : null;
    const row = withEarlierReleases({ ...kept, ...(price_ref !== undefined ? { price_ref } : {}), ...(price ? { price_ref: price.id, billing: { payers: ['trillion-credit'], price_micros: price.amount_micros, per: price.per, seller: maker } } : {}), show_on_public_site, ...(publicRun ? { public_run: publicRun } : {}), published_at: now().toISOString() }, previous?.maker === maker ? previous.row : null);
    const admitted = admitToolDescriptor(row);
    if ('refused' in admitted) throw new WorkshopError(admitted.refused.reason);
    const bundles = new Set();
    if (['container', 'worker-module'].includes(row.invoke?.kind)) bundles.add(row.invoke.files);
    if (row.screen?.runtime === 'isolated') bundles.add(row.screen.module.bundle);
    if (bundles.size) {
      if (!publishBundle) throw new WorkshopError('This service cannot keep the tool files for everyone yet.');
      for (const identity of bundles) {
        await publishBundle(identity);
        await publicationCurrent();
      }
    }
    if (price) await market.publishPriced({ row, price, maker });
    else await market.publish({ row, maker });
    return { ...publishedToolReply(tool_id, place.label, row, price, publicRun), samples: await sampleStates(tool) };
  }

  // A lost publish is read from its effect and never by publishing again (no sample run, no write): this account's
  // Marketplace row for the tool, at the saved version and on the asked terms, is that publish; no row of this
  // account's for it is no publish; a row on other terms or a version saved since cannot say which publish it was.
  async function publishOutcome({ tool_id, price_ref, usage_price, show_on_public_site = false, public_run }) {
    if (!market || !maker || !nonempty(tool_id) || typeof market.publishedOne !== 'function') return { state: 'unknown' };
    const found = await market.publishedOne(tool_id);
    if (!found || found.maker !== maker) return { state: 'aborted' };
    let publicRun;
    try { publicRun = checkedPublicRunPermission(public_run); } catch { return { state: 'unknown' }; }
    const everythingNow = await everything({ only: tool_id });
    const tool = everythingNow.saved.find(item => item.id === tool_id);
    const { row } = found;
    const priced = usage_price !== undefined;
    const price = priced ? { amount_micros: row.billing?.price_micros, per: row.billing?.per } : null;
    const sameTerms = Boolean(tool) && row.show_on_public_site === show_on_public_site
      && canonical(row.public_run ?? null) === canonical(publicRun ?? null)
      && (priced ? row.billing?.seller === maker && row.billing.price_micros === usage_price?.amount_micros
        : price_ref === undefined || row.price_ref === price_ref)
      && workshopToolVersion({ ...row, billing: priced ? undefined : row.billing }) === workshopToolVersion(tool);
    if (!sameTerms) return { state: 'unknown' };
    try { return { state: 'committed', result: { ...publishedToolReply(tool_id, choosePlacement(tool, everythingNow).place.label, row, price, publicRun), samples: await sampleStates(tool) } }; }
    catch (error) { if (error instanceof WorkshopError) return { state: 'unknown' }; throw error; }
  }

  // A computer connecting (its agent publishing its card) runs the samples this account's own tools owe to it: each
  // saved tool whose placement names that agent and whose rule records an unreached computer's sample as owed
  // (src/workshop-sample-rules.json). Each result is kept on the tool's sample record (sampleStates); one tool's failure
  // never stops the next.
  async function settleOwedSamples({ agent_id }) {
    if (!nonempty(agent_id)) return [];
    // Only an account that keeps a tool with its own samples reads its whole catalogue.
    const sampled = new Set((await store.readSavedTools()).filter(row => row.status !== 'deleted' && (row.verify ?? []).some(check => check?.kind === 'sample-run')).map(row => row.id));
    if (!sampled.size) return [];
    const everythingNow = await everything();
    const settled = [];
    for (const tool of everythingNow.saved.filter(row => sampled.has(row.id))) {
      let place;
      try { ({ place } = choosePlacement(tool, everythingNow)); } catch (error) { if (error instanceof WorkshopError) continue; throw error; }
      const named = place.settings?.agent_id;
      if (sampleRuleOf(place)?.unconnected !== 'owed' || !nonempty(named) || ![named, ...formerAgentIds(named)].includes(agent_id)) continue;
      if (!(await sampleStates(tool)).some(row => row.state === 'owed')) continue;
      const held = heldInRun(undefined);
      try { await sampleChecked(tool, place, executionReach(tool, everythingNow, held), held); }
      catch (error) { console.warn('an owed sample did not pass on the connected computer', { tool_id: tool.id, error: error?.message }); }
      settled.push({ tool_id: tool.id, samples: await sampleStates(tool) });
    }
    return settled;
  }

  async function unpublishTool({ tool_id }) {
    if (!market || !maker) throw new WorkshopError('Publishing is only possible on the deployed service.');
    if (!(await market.unpublish({ id: tool_id, maker }))) throw new WorkshopError(`${tool_id} is not a tool this account published.`);
    return unpublishedToolReply(tool_id);
  }

  // The box is asked to send only after every value the request names may go to the request's host. The box is handed
  // that same host as the request's grant, so its compiled sender checks it again with its own URL parser.
  // A service at the person's own address (a self-hosted site) names the connection field holding that address
  // (`invoke.host_is_connection_field`); its value may go only to the host that field holds for this account.
  const sendThroughBox = (grants, tool, sawResponse = null) => async request => {
    const address = new URL(request.url);
    const hostName = address.hostname.toLowerCase();
    const scheme = address.protocol.slice(0, -1);
    const field = tool?.invoke?.host_is_connection_field;
    const ownHost = field && connectionFields ? plainHost((await connectionFields(tool.invoke.connection_id))?.[field]) : null;
    for (const { secret_name } of request.credential_injections ?? []) {
      const grant = grants.get(secret_name) ?? publishedGrantForInstance(grants, secret_name);
      const allowed = [...(grant?.allowed_hosts ?? []), ...(ownHost ? [ownHost] : [])];
      const schemes = grant?.allowed_schemes ?? ['https'];
      if (!allowed.length) throw notSent(`No shared connection says where ${secret_name} may be sent, so it is not sent anywhere.`);
      if (!allowed.includes(hostName)) throw notSent(`This tool would send the connection ${secret_name} to ${hostName}, and it may only be sent to ${allowed.join(', ')}.`);
      if (!schemes.includes(scheme)) throw notSent(`The connection ${secret_name} may only be sent over ${schemes.join(', ')}.`);
    }
    // A connection that says where its requests leave from (src/send-from.mjs) is sent from there.
    const transport = sendFromConnection && tool?.invoke?.connection_id ? await sendFromConnection(tool.invoke.connection_id) : null;
    // What a send on the person's own account costs them is counted here, the one place every such request leaves
    // (src/api-spend.mjs): a reached cap refuses before anything is sent, and the answer's usage is kept after.
    // A derived account identity cannot create a fresh allowance. Keep the admitted base tool's cost owner while
    // the vault, custom host and transport below still use the exact selected connection.
    const meterTool = boundToolParts(tool.id) ? { ...tool, id: tool.provenance.bound_from,
      invoke: { ...tool.invoke, connection_id: tool.provenance.bound_connection } } : tool;
    const metered = sendMeter?.covers(meterTool) ? sendMeter : null;
    const permit = metered ? await metered.before(meterTool) : null;
    try {
      if (tool.invoke.source_connection) {
        requireCurrentConnection(tool.invoke.source_connection, await connections());
        if (tool.invoke.source_connection.source_id) await authorizeConnection(tool.invoke.source_connection);
      }
      const reply = await box.send(request, { allowed_hosts: [hostName], allowed_schemes: [scheme], ...(transport ? { transport } : {}) });
      if (sawResponse) sawResponse(request, reply);
      if (metered) {
        try { metered.after(meterTool, request, reply?.status_code, replyText(reply?.body), permit); }
        catch (error) { console.warn('workshop send meter', String(error?.message ?? error)); }
      }
      return reply;
    } finally {
      if (metered) metered.release?.(permit);
    }
  };

  // Samples and ordinary runs use the same sealed sender and host grants.
  // Only shipped shared rows may keep values or mount a connection in a container.
  function executionReach(tool, { shared, saved, live = [] }, held, sawResponse = null) {
    const fromSharedRow = shared.tools.some(item => item.id === tool.id);
    const placeInContainer = async requests => {
      const mounts = await box.mount(requests);
      held.add(mounts.map(mount => new TextDecoder().decode(mount.source.bytes)));
      return mounts;
    };
    return {
      from_shared_row: fromSharedRow,
      ...(files ? { files } : {}),
      ...(box ? { send: sendThroughBox(grantsOf(shared.tools, saved, live), tool, sawResponse), ...(fromSharedRow ? { keep: (name, value) => box.keep(name, value), mount: placeInContainer } : {}) } : {}),
    };
  }

  // `input` here is the whole input, write-only fields included; it lives only in memory for this call. Anything a
  // run returns or throws has those values replaced before it is written.
  // A reply that carries a key is kept in the box (`keep`) only for a SHARED row, so a saved or published tool can
  // never overwrite one of this account's connections with a value its own service chose.
  async function requireEnabledCapability(tool, { shared, saved }) {
    if(shared.default_makers?.length&&shared.tools.some(item=>item.id===tool.id)){
      const latest=await data({only:tool.id});
      const current=latest.tools.find(item=>item.id===tool.id);
      if(!current||(current.status??'active')!=='active'||workshopToolVersion(current)!==workshopToolVersion(tool))
        throw new WorkshopError('This default Marketplace tool was changed or withdrawn. Find its current published version before running it.');
    }
    const boundParts = boundToolParts(tool.id);
    const baseToolId = boundParts?.tool_id ?? tool.id;
    const explicitCapability = tool.invoke?.required_capability_id;
    const binding = boundParts?.binding ?? tool.invoke?.source_connection;
    const declaredVendor = tool.invoke?.provider ?? connectionVendor(binding?.connection_id ?? tool.invoke?.connection_id);
    const serviceDefinitions = connectRowsOf(shared.tools, saved);
    const connect = serviceDefinitions.find(row => row.invoke?.provider === declaredVendor)?.invoke?.connects;
    const requiredCapability = explicitCapability ?? connect?.capabilities?.find(capability => (capability?.userChoice === true || capability?.user_choice === true)
      && (capability.toolIds ?? capability.tool_ids)?.includes(baseToolId))?.id;
    if (typeof requiredCapability === 'string' && requiredCapability) {
      const connectionId = binding?.connection_id ?? tool.invoke?.connection_id;
      if (!connections || typeof connectionId !== 'string' || !connectionId) {
        throw new WorkshopError('This tool needs a current connected account before its capability choice can be checked.');
      }
      const currentConnections = await connections();
      if (binding) requireCurrentConnection(binding, currentConnections);
      const account = currentConnections.find(row => row.connection_id === connectionId);
      const vendor = account?.vendor ?? declaredVendor;
      const ownerConnect = serviceDefinitions.find(row => row.invoke?.provider === vendor)?.invoke?.connects;
      const declared = ownerConnect?.capabilities?.some(capability => capability?.id === requiredCapability
        && (capability.userChoice === true || capability.user_choice === true));
      if (!declared) throw new WorkshopError('This tool names a capability that is not a selectable choice for its connected service.');
      if (account?.status !== 'connected' || account.can_send === false || typeof account.connected_at !== 'string'
        || binding?.connected_at && account.connected_at !== binding.connected_at) {
        throw new WorkshopError('The selected account connection is disconnected or changed; check that same connection before continuing.');
      }
      if (account.capabilityChoices?.[requiredCapability] === 'disabled') {
        throw new WorkshopError('This account owner has turned off the capability this tool needs.');
      }
    }
  }

  async function execute(task, tool, place, input, { held, shared, saved, live = [] }) {
    const heldHere = heldInRun(held);
    // A row the deploy shipped (not one someone saved or published) may be trusted with more: keeping a reply value,
    // having a connection's value placed in its container, and for a container tool the network and the files it
    // leaves behind.
    const fromSharedRow = shared.tools.some(item => item.id === tool.id);
    let readResponses = [];
    let capture = {};
    const sawReadResponse = (request, reply) => {
      if (!tool.observes) return;
      const method = String(request.method ?? 'POST').toUpperCase();
      const connection = tool.invoke?.connection_id;
      const credentials = request.credential_injections ?? [];
      const bound = nonempty(connection) && credentials.length > 0
        && credentials.every(item => item.secret_name.startsWith(connectionFieldName(connection, '')));
      if (!bound || !['GET', 'HEAD'].includes(method) || !(reply?.status_code >= 200 && reply.status_code < 300)) { readResponses.push(null); return; }
      const address = new URL(request.url);
      let value = replyText(reply.body);
      try { value = JSON.parse(value); } catch {}
      readResponses.push({ connection_id: connection, provider_origin: address.origin,
        dispatch_route: `${method} ${address.origin}${address.pathname}`, basis: 'authorized_provider_read', value });
    };
    const reach = executionReach(tool, { shared, saved, live }, heldHere, sawReadResponse);
    const opened = fromSharedRow ? await openRelay(task, tool) : null;
    if (opened) {
      heldHere.add([opened.key]);
      reach.relay_mounts = [opened.mount];
      // The gateway stands in for the person's own connection, so none of their values is placed.
      delete reach.mount;
    }
    try {
      await requireEnabledCapability(tool, { shared, saved });
      await sampleChecked(tool, place, reach, heldHere, task.space_authorization ?? null);
      const { input: withFiles, placements } = await runFiles(tool, input, fromSharedRow);
      const invocation = await buildInvocation(tool.invoke, { input: fromSharedRow ? await yourRecords(withFiles, tool.input_schema, records) : withFiles, task, needs: tool.needs, fetchBytes, request: true });
      readResponses = [];
      let actual;
      const raw = await underEffectLedger(tool, { ref: task.task_id, authorization: task.input_identity, space_authorization: task.space_authorization, execution_ref: task.execution_ref, input: task.input, origin: task.execution?.origin, invocation, captureResult: value => { capture = value; } },
        async () => {
          // Samples, file materialization and invocation bindings can await.
          // Recheck at the send boundary too. This refusal precedes dispatch,
          // so the effect owner must not classify it as an unknown send.
          try {
            await requireEnabledCapability(tool,{shared,saved});
            await requireResourceTask(task.resource_authorization, tool, task.input);
          } catch(error) { error.not_sent=true; throw error; }
          return executors[place.executor]({
          tool, placement: place, invocation, input, task, ...reach, placements, held: held !== undefined,
          // Large sealed namespace-file inputs advance one bounded window per
          // request. The cursor is part of the working task, so a Worker restart
          // or duplicate alarm resumes at the last exact byte.
          onStagingProgress: async state => {
            const current = await store.readTask(task.task_id);
            if (current?.state === 'failed' || current?.state === 'completed') {
              throw new Error('The tool task was settled while its input was being staged.');
            }
            // Preserve any current task fields written by another host while
            // keeping the cursor from this claim. A terminal task is never
            // resurrected by a late range callback after revocation/cleanup.
            await store.writeTask({ ...(current ?? task), input_staging: state });
          },
          report: ({ cost_micros }) => { actual = cost_micros; },
          });
        });
      // A grant revoked while a long-running executor works must stop its result being saved or shared.
      if (task.space_authorization) await authorizeSpaceTask(task.space_authorization, tool);
      await requireResourceTask(task.resource_authorization, tool, task.input);
      await requireEnabledCapability(tool,{shared,saved});
      const readback_response = readResponses.length === 1 && readResponses[0] ? { ...readResponses[0], value: heldHere.value(readResponses[0].value) } : null;
      const completed = await finish(task, tool, { raw: heldHere.value(raw), actual_micros: actual, readback_response, ...capture }, fromSharedRow ? records : null);
      await cleanupTerminalTask(completed, place);
      return completed;
    } catch (error) {
      // The same effect already being sent by this host: that run writes the task.
      if (error instanceof EffectNotSent && error.effect_state === 'in-flight') return (await store.readTask(task.task_id)) ?? task;
      // A bounded input window is progress, not a failed tool. The durable task
      // cursor was written by onStagingProgress; the existing working alarm will
      // wake it and begin the next window.
      if (error instanceof InputStagingPending || error?.input_staging_pending === true) return (await store.readTask(task.task_id)) ?? task;
      // A run the platform cut off (the service restarted under it: Cloudflare marks such an error retryable) did not
      // finish; the same request_key starts it over. A send that may have happened is an EffectNotSent and never is.
      const cutOff = error?.retryable === true && !(error instanceof EffectNotSent);
      const busy = error?.no_container_free === true;
      // A run cut off under an executor that keeps runs across restarts (a deploy restarts every store and container)
      // stays working and is taken up again by itself shortly, a bounded number of times; a run given a key is not.
      if (cutOff && held === undefined && canTakeUp(task, place)) {
        keepAlive(new Promise(resolve => setTimeout(resolve, TAKE_UP_AFTER_MS)).then(async () => {
          const now = await store.readTask(task.task_id);
          if (now?.state === 'working' && !running.has(task.task_id) && !(await resumableRunIsActive(now, await taskPlacement(now)))) await begin({ ...now, taken_up: (now.taken_up ?? 0) + 1 }, { wait_seconds: 0 });
        }).catch(error => console.error('taking a run up again', error)));
        return task;
      }
      const failed = await finish(task, tool, { error: busy ? NO_CONTAINER_FREE : cutOff ? RESTARTED : heldHere.text(String(error.message ?? error)).slice(0, 600), ...(error instanceof EffectNotSent ? { effect: { state: error.effect_state } } : {}), ...capture, ...(cutOff || busy ? { cut_off: true } : {}) });
      await cleanupTerminalTask(failed, place);
      return failed;
    } finally {
      if (opened) relays.delete(opened.hash);
    }
  }

  // A run paid through a gateway whose row relays its calls gets a relay key for as long as it works here. Returns
  // { key, hash, mount } (the file placed in its container), or null when this run has no relay.
  async function openRelay(task, tool) {
    const at = tool.invoke?.gateway_relay;
    if (!relay || !payers || !task.payer?.through || !object(at) || !nonempty(at.mount_path)) return null;
    const key = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const hash = relayHash(key);
    if(nonempty(relay.resource)){
      const actual=await store.readTask(task.task_id);
      if(!actual||actual.state!=='working')throw new WorkshopError('The original native relay task is not working.');
      await store.writeTask({...actual,relay_key_hash:actual.relay_key_hash??hash,relay_label:actual.relay_label??tool.label??tool.id});
      task.relay_key_hash=actual.relay_key_hash??hash;task.relay_label=actual.relay_label??tool.label??tool.id;
    }
    relays.set(hash, { task, label: tool.label ?? tool.id, calls: 0, tools: new Map(), requests: new Map() });
    // The address names the run, and the resource holding it when it has one; it selects the owner, never the
    // authority. The run's live key and the captured task remain the admission proof at the selected owner.
    const address = new URL(relay.url);
    if (nonempty(relay.resource)) address.searchParams.set('resource', relay.resource);
    address.searchParams.set('task', task.task_id);
    const bytes = new TextEncoder().encode(JSON.stringify({ url: address.href, person: relay.person, key,
      ...(nonempty(relay.resource) ? { resource: relay.resource, task_id: task.task_id, request_key_required: true } : {}) }));
    return { key, hash, mount: { mount_path: at.mount_path, content_type: 'application/json', source: { kind: 'inline', bytes: Array.from(bytes) } } };
  }

  // One call a relayed run sends through its gateway: a tool that calls that same gateway (invoke.kind gateway-call),
  // with its input checked against that tool's schema. Each call is its own charge (`<task id>~<n>`), taken before it
  // is sent, given back when it fails, and lowered to what the gateway says it cost. Returns the gateway's answer.
  async function relayCall({ key, tool_id, input, task_id, request_key }) {
    const open = await restoredRelay(key,task_id);
    if (!open) throw new WorkshopError('This key is not for a run that is working now.');
    if (task_id !== undefined && task_id !== open.task.task_id) throw new WorkshopError('This relay key belongs to another original task.');
    if (nonempty(relay?.resource) && !nonempty(request_key)) throw new WorkshopError('A native relay call needs its stable request_key; use the same key when checking the same call again.');
    if (!nonempty(tool_id) || !object(input)) throw new WorkshopError('Send tool_id and input.');
    const authorize = () => typeof relay?.authorize === 'function' ? relay.authorize(open.task) : null;
    await authorize();
    const everythingNow = await everything({ only: tool_id });
    const tool = open.tools.get(tool_id) ?? await toolById(everythingNow, tool_id);
    const through = open.task.payer.through;
    if (tool?.invoke?.kind !== 'gateway-call' || tool.invoke.gateway !== through) throw new WorkshopError(`${tool_id} is not a call through ${open.task.payer.through_label}.`);
    open.tools.set(tool_id, tool);
    const problems = schemaProblems(input, tool.input_schema, 'input');
    if (problems.length) throw new WorkshopError(`${problems.join('; ')}. The input must match ${tool_id}'s input_schema.`);
    const payer = await payers.plan({ tool });
    await authorize();
    if (payer?.through !== through) throw new WorkshopError(`${open.task.payer.through_label} cannot be paid for ${tool_id} now.`);
    const { place } = choosePlacement(tool, everythingNow);
    if (nonempty(request_key)) return capturedRelayCall({open,tool,input,request_key,payer,place,authorize});
    open.calls += 1;
    const call = { task_id: `${open.task.task_id}~${open.calls}`, tool_id, label: open.label, payer, ...(open.task.caller_app ? { caller_app: open.task.caller_app } : {}) };
    await payers.take(call);
    let actual, value;
    try {
      const invocation = await buildInvocation(tool.invoke, { input, task: call, needs: tool.needs, fetchBytes, request: true });
      await authorize();
      value = await executors[place.executor]({ tool, placement: place, invocation, input, task: call, report: ({ cost_micros }) => { actual = cost_micros; } });
      await payers.settle(call, { failed: false, actual_micros: actual });
    } catch (error) {
      await payers.settle(call, { failed: true });
      throw error;
    }
    // Withholding a returned value cannot refund a gateway call that succeeded.
    await authorize();
    return value;
  }

  async function restoredRelay(key,task_id){
    if(!nonempty(key))return null;
    const hash=relayHash(key),active=relays.get(hash);if(active)return active;
    if(!nonempty(relay?.resource)||!nonempty(task_id))return null;
    const task=await store.readTask(task_id);
    if(!task||task.state!=='working'||task.payment_finish||task.relay_key_hash!==hash)return null;
    const open={task,label:task.relay_label??task.tool_id,calls:0,tools:new Map(),requests:new Map()};
    relays.set(hash,open);return open;
  }

  // Reconciliation can settle/read only a durably returned original call.
  // A missing/prepared/uncertain receipt never reaches the gateway executor.
  async function reconcileRelay({key,tool_id,input,task_id,request_key}={}){
    const open=await restoredRelay(key,task_id);
    if(!open||open.task.task_id!==task_id||!nonempty(request_key)||typeof store.readRelayCall!=='function')return {state:'unknown'};
    const authorize=()=>typeof relay?.authorize==='function'?relay.authorize(open.task):null;
    await authorize();
    const id=`${task_id}~${relayHash(request_key)}`,saved=await store.readRelayCall(id);
    if(saved?.state!=='returned')return {state:'unknown'};
    const tool=open.tools.get(tool_id)??await toolById(await everything({only:tool_id}),tool_id);
    if(!tool||saved.identity!==identityOf(canonical([task_id,request_key,tool.id,workshopToolVersion(tool),input])))throw new WorkshopError('This relay request_key names different original input.');
    const call={task_id:id,parent_task_id:task_id,tool_id:tool.id,payer:saved.payer,...(open.task.caller_app?{caller_app:open.task.caller_app}:{})};
    await payers.settle(call,{failed:false,actual_micros:saved.actual_micros});await authorize();
    return {state:'committed',result:{status:200,value:saved.value}};
  }

  async function capturedRelayCall({open,tool,input,request_key,payer,place,authorize}) {
    if(typeof store.readRelayCall!=='function'||typeof store.writeRelayCall!=='function')
      throw new WorkshopError('The relay has no durable original-call receipt owner. Nothing was dispatched.');
    const id=`${open.task.task_id}~${relayHash(request_key)}`;
    const identity=identityOf(canonical([open.task.task_id,request_key,tool.id,workshopToolVersion(tool),input]));
    const active=open.requests.get(id);
    if(active){if(active.identity!==identity)throw new WorkshopError('This relay request_key already names different input.');return active.result;}
    const result=(async()=>{
      let saved=await store.readRelayCall(id);
      await authorize();
      if(saved&&saved.identity!==identity)throw new WorkshopError('This relay request_key already names different original input.');
      const call={task_id:id,tool_id:tool.id,label:open.label,payer:saved?.payer??payer,...(open.task.caller_app?{caller_app:open.task.caller_app}:{})};
      if(saved?.state==='returned'){
        await payers.settle(call,{failed:false,actual_micros:saved.actual_micros});
        await authorize();return saved.value;
      }
      if(saved&&['dispatching','unknown'].includes(saved.state))
        throw new EffectNotSent('The original relay call may have happened. It is not sent again; reconcile its original provider receipt.',saved.state);
      saved={task_id:id,parent_task_id:open.task.task_id,identity,payer:call.payer,state:'prepared'};
      await store.writeRelayCall(saved);
      await payers.take(call);
      let actual,value;
      try{
        const invocation=await buildInvocation(tool.invoke,{input,task:call,needs:tool.needs,fetchBytes,request:true});
        await authorize();
        saved={...saved,state:'dispatching'};await store.writeRelayCall(saved);
        await authorize();
        value=await executors[place.executor]({tool,placement:place,invocation,input,task:call,report:({cost_micros})=>{actual=cost_micros;}});
      }catch(error){
        const notDispatched=saved.state==='prepared'||error.not_sent===true||(error.service_answered>=400&&error.service_answered<500);
        await store.writeRelayCall({...saved,state:notDispatched?'rejected':'unknown'});
        if(notDispatched)await payers.settle(call,{failed:true});
        throw error;
      }
      // Capture the accepted response before billing or output admission yields.
      // A failed settlement/output check must not erase it or refund that send.
      saved={...saved,state:'returned',value,...(Number.isFinite(actual)?{actual_micros:actual}:{})};
      await store.writeRelayCall(saved);
      await payers.settle(call,{failed:false,actual_micros:actual});
      await authorize();return value;
    })();
    open.requests.set(id,{identity,result});
    try{return await result;}finally{if(open.requests.get(id)?.result===result)open.requests.delete(id);}
  }

  function dispatchStart(request, publicRunLimits = null) {
    if (!nonempty(request?.tool_id) || !nonempty(request?.request_key)) return startOnce(request ?? {});
    const task_id = workshopTaskId(request);
    const earlier = starting.get(task_id);
    const inputSubmission = submittingInput.get(task_id);
    const run = (earlier ? earlier.catch(() => {}) : Promise.resolve())
      .then(() => inputSubmission ? inputSubmission.catch(() => {}) : undefined)
      .then(() => startOnce({ ...request, ...(publicRunLimits ? { public_run_limits: publicRunLimits } : {}) }));
    const settled = run.finally(() => { if (starting.get(task_id) === settled) starting.delete(task_id); });
    starting.set(task_id, settled);
    return settled;
  }

  // Public app limits come only from the host-side permission check. Ordinary callers cannot set a larger cap.
  function start(request) {
    const { public_run_limits: _ignored, ...ordinary } = request ?? {};
    return dispatchStart(ordinary);
  }
  function runPublicApp(request, permission) {
    const checked = checkedPublicRunPermission(permission);
    if (!checked) throw new WorkshopError('This tool is not available to public app visitors.');
    const { tool_id, tool_version, input, request_key } = request ?? {};
    if (!/^1f:[a-f0-9]{64}$/.test(tool_version ?? '')) throw new WorkshopError('This public app tool version is unavailable.');
    return dispatchStart({ tool_id, public_tool_version: tool_version, input, request_key, wait_seconds: 20, caller_app: 'public-app' }, checked).catch(error => {
      if (/has reached its \d+ runs for today/.test(String(error?.message ?? ''))) error.public_run_limit = true;
      throw error;
    });
  }

  async function readPublicApp({ task_id, tool_id, tool_version, request_key_prefix }) {
    const task = nonempty(task_id) ? await store.readTask(task_id) : null;
    if (!task || task.caller_app !== 'public-app' || !task.public_run_limits || task.tool_id !== tool_id ||
        (task.public_tool_version !== undefined && task.public_tool_version !== tool_version) ||
        !nonempty(request_key_prefix) || !task.request_key.startsWith(request_key_prefix)) {
      throw new WorkshopError('This public app run is unavailable.');
    }
    // A visitor status read is a bounded projection of this verified task. The
    // ordinary read path also retries executor cleanup and reconciles old task
    // states; neither operation should make a public result disappear.
    return { state: task.state, ...(task.state === 'completed' && task.output !== undefined ? { output: task.output } : {}) };
  }

  // The run of a read_only row: what a screen's answer or the work tree costs when asked through run_tool. It writes no
  // task, no execution and no pool run and shows nothing to the person, so nothing is armed after it (src/person-store.mjs
  // arms only when a write happened); the answer is the same completed run, checked against the row's contract, but
  // read_task has no record of it and its next_call is none. Asking again with the same request_key asks again.
  async function readOnce({ tool, task_id, input, shared }) {
    const startedAt = now();
    const resolved = await resolveRefs(input);
    const problems = schemaProblems(resolved, tool.input_schema, 'input');
    if (problems.length) throw new WorkshopError(`${problems.join('; ')}. The input must match this tool's input_schema.`);
    const { place } = choosePlacement(tool, shared);
    const asked = { task_id, request_key: task_id, in_memory: true };
    const done = { task_id, tool_id: tool.id, job: tool.job ?? tool.label ?? tool.id, placement_label: place.label, started_at: startedAt.toISOString(), reports: [] };
    try {
      await requireEnabledCapability(tool, shared);
      const invocation = await buildInvocation(tool.invoke, { input: resolved, task: asked, needs: tool.needs, fetchBytes, request: true });
      await requireEnabledCapability(tool, shared);
      const output = outputOf(tool, await executors[place.executor]({ tool, placement: place, invocation, input: resolved, task: asked }));
      await requireEnabledCapability(tool, shared);
      const wrong = object(output) && 'selector_contract_error' in output ? [`the result has no ${tool.result_selector}`] : [...schemaProblems(output, tool.output_schema, 'output'), ...jobProblems(tool, resolved, output)];
      Object.assign(done, { state: wrong.length ? 'failed' : 'completed', output, contract: { passed: !wrong.length, problems: wrong } });
    } catch (error) {
      Object.assign(done, { state: 'failed', error: String(error.message ?? error).slice(0, 600) });
    }
    const finishedAt = now();
    Object.assign(done, { finished_at: finishedAt.toISOString(), seconds: Math.round((finishedAt - startedAt) / 100) / 10 });
    return { ...view(done), next_call: null };
  }

  // The finished task an exact retry of `request` repeats (its request_key, input and schedule), or null. A shipped tool
  // wins over saved, published and registry rows for its id. An exact retry of an already-kept ordinary task needs that
  // current schema and its authoritative task row, not the account's connector catalog. Share/Space/public/bound tools
  // and restart recovery retain their live authority and execution paths in startOnce.
  async function finishedRepeat({ tool_id, input = {}, request_key, run_at, repeat_every_hours, space_authorization, resource_authorization, public_run_limits, share, for_handoff }) {
    if (space_authorization || resource_authorization || public_run_limits || share !== undefined || for_handoff || boundToolParts(tool_id)) return null;
    const shared = await data();
    const replayTool = shared.tools.find(item => item.id === tool_id);
    if (!replayTool?.invoke || !replayTool.placements || (replayTool.status ?? 'active') !== 'active') return null;
    const { kept, held } = splitWriteOnly(input, replayTool.input_schema);
    if (readsOnce(replayTool, shared, { run_at, repeat_every_hours, share, space_authorization, public_run_limits, for_handoff, held })) return null;
    const prior = await store.readTask(workshopTaskId({ tool_id, request_key }));
    const identity = identityOf({ input: kept, run_at: run_at ?? null, repeat_every_hours: repeat_every_hours ?? null });
    return prior && prior.state !== 'working' && prior.cut_off !== true && !prior.waiting_on && !prior.public_run_limits
      && canonical(prior.space_authorization ?? null) === canonical(space_authorization ?? null)
      && (prior.share ?? null) === (share ?? null) && prior.input_identity === identity ? prior : null;
  }

  async function startOnce({ tool_id, input = {}, request_key, wait_seconds, run_at, repeat_every_hours, job, started_by, caller_app, space_authorization, resource_authorization, public_run_limits, public_tool_version, share, execution: source, for_handoff, reads_once = false }) {
    if (!nonempty(tool_id)) throw new WorkshopError('tool_id is required. find_tool_for_job returns tool ids for a job.', { tool: 'find_tool_for_job', arguments: { job: '(the job in plain words)' } });
    if (!nonempty(request_key)) throw new WorkshopError('request_key is required: any unique text. Sending the same request_key again returns the same task instead of running twice.');
    if (!object(input)) throw new WorkshopError('input must be an object matching the tool\'s input_schema.');
    if (run_at !== undefined && Number.isNaN(Date.parse(run_at))) throw new WorkshopError('run_at must be a date and time, for example 2026-10-01T09:00:00Z.');
    if (repeat_every_hours !== undefined && !(Number(repeat_every_hours) >= 1)) throw new WorkshopError('repeat_every_hours must be at least 1.');
    if (share !== undefined && !nonempty(share)) throw new WorkshopError('share is the link someone sent you for this tool.');
    if (share !== undefined && (space_authorization || public_run_limits)) throw new WorkshopError('A tool shared by a link runs in your own Trillion, not in a pursuit or a public app.');
    const task_id = workshopTaskId({ tool_id, request_key });
    const repeated = await finishedRepeat({ tool_id, input, request_key, run_at, repeat_every_hours, space_authorization, resource_authorization, public_run_limits, share, for_handoff });
    if (repeated) return view(repeated);
    const everythingNow = await everything({ only: tool_id, share });
    const tool = await toolById(everythingNow, tool_id);
    await requireResourceTask(resource_authorization, tool, input);
    if (public_run_limits) {
      const publishedPermission = tool && publicRunPermissionFor(tool);
      if (!publishedPermission || canonical(publishedPermission) !== canonical(public_run_limits) || workshopToolVersion(tool) !== public_tool_version) {
        throw new WorkshopError('This tool is no longer available to public app visitors.');
      }
    }
    if (space_authorization) await authorizeSpaceTask(space_authorization, tool);
    // Write-only fields never reach the task, its identity, the pool or the job text.
    const { kept, held } = tool ? splitWriteOnly(input, tool.input_schema) : { kept: input, held: undefined };
    if (!resource_authorization && readsOnce(tool, everythingNow.shared, { run_at, repeat_every_hours, share, space_authorization, public_run_limits, for_handoff, held })) return readOnce({ tool, task_id, input: kept, shared: everythingNow });
    // A run admitted as keeping nothing (keepsNothingAsked) keeps no journal of its own, so it never keeps a task either.
    if (reads_once) throw new WorkshopError('This run was asked as a read of a read-only tool, and the tool now keeps its run. Ask again.');
    const input_identity = identityOf({ input: kept, run_at: run_at ?? null, repeat_every_hours: repeat_every_hours ?? null });
    const existing = await store.readTask(task_id);
    if (existing) {
      if (canonical(existing.resource_authorization ?? null) !== canonical(resource_authorization ?? null)) throw new WorkshopError('This request key belongs to a different resource binding or operation definition.');
      if (public_run_limits && existing.public_tool_version !== undefined && existing.public_tool_version !== public_tool_version) throw new WorkshopError('This request key belongs to a different published tool version. Use a new run key.');
      if (canonical(existing.space_authorization ?? null) !== canonical(space_authorization ?? null)) throw new WorkshopError('This request_key belongs to a different place (your own Trillion or a pursuit). Use a new request_key.');
      if ((existing.share ?? null) !== (share ?? null)) throw new WorkshopError('This request_key was used with a different share link. Use a new request_key.');
      if (existing.input_identity !== input_identity) throw new WorkshopError('This request_key was already used with different input. Use a new request_key for new work.');
      if(existing.payment_finish)return view(await finish(existing,existing.payment_finish.tool,{}));
      // Accepted missing-input submissions are durable before begin() rechecks placement and rights. If that
      // preflight fails or the Worker stops before recording a placement, resume the saved task, never reconstruct it
      // from run_tool's original (incomplete) request. No executor or effect can have started without a placement.
      if (existing.state === 'working' && !existing.placement && Object.keys(existing.input_submissions ?? {}).length
        && !running.has(task_id) && !submittingInput.has(task_id) && !(store.readEffect && await store.readEffect(task_id))) {
        return begin(existing, { wait_seconds });
      }
      // A run cut off by a restart (marked so when it stopped, or still marked working while no host runs it) starts
      // over under the same request_key; every other task is returned as it is, so nothing runs twice.
      if (existing.waiting_on) return view(await retiredWait(existing));
      const cutOff = existing.cut_off === true || (existing.state === 'working' && !running.has(task_id) && !(store.readEffect && await store.readEffect(task_id)) && !(await resumableRunIsActive(existing, everythingNow.placementsById.get(existing.placement))));
      if (!cutOff) return view(existing);
      // A cold run retry reaches here before begin() and may otherwise build a
      // replacement task. Fence its accepted definition before that write too.
      if(existing.tool_version&&(!tool||existing.tool_version!==workshopToolVersion(tool)))throw Object.assign(
        new WorkshopError('This task pins an earlier tool definition. Its original run and effect evidence are retained; a changed tool cannot resume it.'),
        {status:409,code:'tool_definition_changed'});
      if (existing.http_reconnect_before) {
        if (canTakeUp(existing, everythingNow.placementsById.get(existing.placement))) return begin({ ...existing, taken_up: (existing.taken_up ?? 0) + 1 }, { wait_seconds });
        const stopped = { ...existing, state: 'failed', cut_off: false, finished_at: now().toISOString(), error: 'The original web request has not reported its result. Check that job before starting another.' };
        await store.writeTask(stopped);
        return view(stopped);
      }
    }
    // A screen with nothing to run (a parts screen) is opened, never run.
    if (!tool && everythingNow.screens.some(item => item.id === tool_id)) throw new WorkshopError(`${tool_id} is a screen with nothing to run. show_screen opens it.`, { tool: 'show_screen', arguments: { screen: tool_id } });
    if (!tool) throw new WorkshopError(`There is no tool ${tool_id}.`, { tool: 'find_tool_for_job', arguments: { job: '(the job in plain words)' } });
    const later = (run_at !== undefined && Date.parse(run_at) > now().getTime()) || repeat_every_hours !== undefined;
    if (held !== undefined && later) throw new WorkshopError('A key can only be given to a tool that runs now. Leave out run_at and repeat_every_hours.');
    // Who pays, in order: the person's own connected account, then Trillion credit (through Trillion's account at a
    // gateway, or a maker's price), then the maker's own billing; otherwise the refusal names what is missing.
    const names = [...credentialInjections(tool.invoke), ...credentialMounts(tool.invoke)].map(item => item.secret_name);
    // A row with billing names its payers; the person's own account preempts only where the row lists it.
    const ownFirst = !tool.billing || (tool.billing.payers ?? []).includes('own-account');
    const own = ownFirst && names.length > 0 && Boolean(box) && (await Promise.all(names.map(name => box.check_exists(name)))).every(Boolean);
    const payer = own ? { paid_by: 'own-account' } : payers ? await payers.plan({ tool }) : null;
    const connections = grantsOf(everythingNow.shared.tools, everythingNow.saved);
    const mounts = credentialMounts(tool.invoke);
    if (mounts.length && !everythingNow.shared.tools.some(item => item.id === tool.id)) throw new WorkshopError(`${tool.id} asks for a connection's value inside its container, and only a tool this service ships may have one.`);
    // A gateway account stands in for the person's own connection: for a request it sends, and for a SHARED container
    // tool whose row relays its calls (`invoke.gateway_relay`), which then gets no value of the person's.
    const relayed = Boolean(payer?.through) && object(tool.invoke?.gateway_relay);
    for (const { secret_name } of [...(payer?.through ? [] : credentialInjections(tool.invoke)), ...(relayed ? [] : mounts)]) {
      if (box && await box.check_exists(secret_name)) continue;
      const connect = connections.get(secret_name)?.tool_id ? connections.get(secret_name) : null;
      throw new WorkshopError(`${tool.id} needs a connection named ${secret_name}, and this account has none.${connect ? ` Connect it with ${connect.tool_id}; the key goes into this account's locked box and is never shown again.` : ''}`,
        connect ? { tool: 'run_tool', arguments: { tool_id: connect.tool_id, ...RUN_HINT } } : { tool: 'find_tool_for_job', arguments: { job: `connect the service ${tool.id} uses` } }, secret_name);
    }
    const price = priceOf(tool, everythingNow.shared);
    if (price?.access_ref && !(access && await access.grants(price.access_ref))) {
      throw new WorkshopError(`${tool.id} is part of ${price.label}, which this account does not have yet. The person can take it on their Trillion account page.`);
    }
    const captured = source?.execution_ref ? source : execution
      ? await execution.begin({ operation: tool.id, capture_kind: 'internal_dispatch', claimed: { ...(for_handoff ? { handoff_id: for_handoff } : {}), ...(caller_app ? { app: caller_app } : {}) } })
      : executionContext({ operation: tool.id, capture_kind: 'internal_dispatch', origin: 'unknown' });
    if (execution) await execution.update(captured.execution_ref, { links: { task_id, ...(for_handoff ? { handoff_id: for_handoff } : {}) } });
    const task = {
      execution_ref: captured.execution_ref, execution: captured, ...(for_handoff ? { for_handoff } : {}),
      task_id, tool_id, tool_version:workshopToolVersion(tool), job: tool.job ?? tool.label ?? tool.id, ...(nonempty(job) ? { caller_job: scrubText(job, heldTexts(held)) } : {}), request_key, input: kept, input_identity,
      started_at: now().toISOString(), reports: [], ...(price ? { price } : {}), ...(started_by ? { started_by } : {}),
      ...(payer ? { payer } : {}), ...(nonempty(caller_app) ? { caller_app } : {}), ...(public_run_limits ? { public_run_limits, public_tool_version } : {}),
      ...(object(space_authorization) ? { space_authorization: { space_id: String(space_authorization.space_id ?? ''), grant_id: String(space_authorization.grant_id ?? ''), tool_version: String(space_authorization.tool_version ?? '') } } : {}),
      ...(object(resource_authorization) ? { resource_authorization: structuredClone(resource_authorization) } : {}),
      ...(repeat_every_hours ? { repeat_every_hours: Number(repeat_every_hours) } : {}),
      ...(share !== undefined ? { share } : {}),
    };
    if (run_at !== undefined && Date.parse(run_at) > now().getTime()) {
      const scheduled = { ...task, state: 'scheduled', due_at: new Date(run_at).toISOString(), history: [{ at: task.started_at, state: 'scheduled' }] };
      await store.writeTask(scheduled);
      return view(scheduled);
    }
    return begin(task, { wait_seconds, held });
  }

  // Resolve references, check the input, pick a place, and run (or queue, or hand back).
  async function begin(task, { wait_seconds, held }) {
    if(task.payment_finish)return view(await finish(task,task.payment_finish.tool,{}));
    // A tool shared by a link is asked of its owner again here, so a link that ended while a run waited stops it.
    const everythingNow = await everything({ only: task.tool_id, share: task.share }).catch(error => {
      if (!task.share) throw error;
      return { failedShare: error };
    });
    if (everythingNow.failedShare) {
      if (!task.due_at) throw everythingNow.failedShare;
      const failed = { ...task, state: 'failed', error: everythingNow.failedShare.message, history: [...(task.history ?? []), { at: now().toISOString(), state: 'failed' }] };
      await store.writeTask(failed);
      return view(failed);
    }
    const tool = await toolById(everythingNow, task.tool_id);
    // Keep one start time for the task across take-up attempts. Scheduled work
    // gets its actual execution time when its first attempt begins.
    const startedAt = task.state === 'working' && nonempty(task.started_at) ? task.started_at : now().toISOString();
    let input;
    let place;
    let licence;
    let reconnectMs;
    try {
      if (!tool) throw new WorkshopError(`There is no tool ${task.tool_id} any more.`);
      // A missing-input prompt has not selected a placement or sent an effect.
      // Preserve its existing schema-refresh contract, asking the caller to
      // accept the new fields/version before execution can begin.
      if(task.tool_version!==workshopToolVersion(tool)&&task.state==='waiting_for_input'&&!task.placement
        &&!(store.readEffect&&await store.readEffect(task.task_id)))task={...task,tool_version:workshopToolVersion(tool)};
      // The task owns the version it accepted. A current publication is not
      // permission to reinterpret an old container/effect with a replacement
      // definition. Refuse before dispatch and retain its original recovery
      // state; original effect receipts remain at their existing owner.
      // A visitor's public app run says so in the words below it: that is the answer the visitor's page reads.
      if(task.tool_version&&task.tool_version!==workshopToolVersion(tool))throw Object.assign(
        new WorkshopError(task.public_run_limits?'This public app tool changed before its run began.':'This task pins an earlier tool definition. Its original run and effect evidence are retained; a changed tool cannot resume it.'),
        {status:409,code:'tool_definition_changed'});
      await requireResourceTask(task.resource_authorization, tool, task.input);
      // A scheduled Space task must fail closed in its own row when its grant was revoked while it waited.
      // Keep this inside the due-task error boundary so the alarm does not leave the task scheduled forever.
      if (task.space_authorization) await authorizeSpaceTask(task.space_authorization, tool);
      if (task.repeat_every_hours) {
        const nextAt = new Date(Date.parse(task.due_at ?? startedAt) + task.repeat_every_hours * 3600000).toISOString();
        const nextKey = `${task.request_key.replace(/@[^@]*$/, '')}@${nextAt}`;
        const next_id = workshopTaskId({ tool_id: task.tool_id, request_key: nextKey });
        if (!(await store.readTask(next_id))) {
          // Each recurrence owns its provider receipt; it points to the original scheduling call instead of
          // overwriting an earlier occurrence's provider id on the same execution record.
          const parent = task.execution?.call_id;
          const nextSource = execution ? await execution.begin({ operation: task.tool_id, capture_kind: 'internal_dispatch',
            origin: task.execution?.origin ?? 'unknown', ...(parent ? { parent_call_id: parent } : {}) })
            : executionContext({ operation: task.tool_id, origin: task.execution?.origin ?? 'unknown', ...(parent ? { parent_call_id: parent } : {}) });
          if (execution) await execution.update(nextSource.execution_ref, { links: { task_id: next_id } });
          await store.writeTask({ ...task, task_id: next_id, execution_ref: nextSource.execution_ref, execution: nextSource,
            request_key: nextKey, state: 'scheduled', due_at: nextAt, started_at: startedAt, history: [{ at: startedAt, state: 'scheduled' }] });
        }
      }
      if (task.public_run_limits) {
        if (workshopToolVersion(tool) !== task.public_tool_version ||
            canonical(publicRunPermissionFor(tool)) !== canonical(task.public_run_limits)) {
          throw new WorkshopError('This public app tool changed before its run began.');
        }
        const fields = tool.input_schema?.properties ?? {};
        if (!publicRunEligible(tool) || Object.keys(task.input ?? {}).some(key => !Object.hasOwn(fields, key))) {
          throw new WorkshopError('This input cannot be used for a public app run.');
        }
        input = task.input;
      } else input = await resolveRefs(task.input);
      const problems = schemaProblems(joinHeld(input, held), tool.input_schema, 'input');
      if (problems.length) {
        const missing = !task.public_run_limits && !task.space_authorization && !task.share && !task.due_at && !task.repeat_every_hours
          ? pendingInputFields(problems, tool.input_schema) : null;
        if (missing) {
          const version = `1f:${identityOf({ task_id: task.task_id, tool_version: workshopToolVersion(tool), fields: missing })}`;
          const pending_input = { version, fields: missing.map(name => ({ name, schema: tool.input_schema.properties[name] })) };
          if (task.state === 'waiting_for_input' && task.pending_input?.version === version
            && canonical(task.pending_input.fields) === canonical(pending_input.fields)) return view(task);
          const pending = {
            ...task, state: 'waiting_for_input', input,
            pending_input,
            history: [...(task.history ?? []), { at: now().toISOString(), state: 'waiting_for_input' }],
          };
          await store.writeTask(pending);
          return view(pending);
        }
        throw new WorkshopError(`${problems.join('; ')}. The input must match this tool's input_schema.`);
      }
      ({ place, licence } = choosePlacement(tool, everythingNow, task.resource_authorization));
      if (place.executor === 'caller') await requireEnabledCapability(tool, everythingNow);
      reconnectMs = httpReconnectDuration(tool);
      if (task.http_reconnect_before && (!reconnectMs || place.executor !== 'http')) throw new WorkshopError('This web tool no longer declares the same reconnect protocol.');
      if (task.public_run_limits) {
        if (!store.claimUse) throw new WorkshopError(`${tool.id} cannot run in a public app because this account cannot count public runs.`);
        const refused = await store.claimUse(`public-app:${tool.id}`, task.task_id, { runs_per_day: task.public_run_limits.runs_per_day }, startedAt.slice(0, 10));
        if (refused) throw new WorkshopError(`${tool.id}: ${refused}`);
      }
      if (tool.use_limits) {
        if (!store.claimUse || !store.recordUseFailure) throw new WorkshopError(`${tool.id} has use limits, but this account cannot count runs here.`);
        const refused = await store.claimUse(tool.id, task.task_id, tool.use_limits, startedAt.slice(0, 10));
        if (refused) throw new WorkshopError(`${tool.id}: ${refused}`);
      }
      // The charge is taken before the paid work starts, keyed by the task, so a retry is charged once.
      if (payers && task.payer && place.executor !== 'caller') await payers.take(task);
    } catch (error) {
      if (!task.due_at) throw error;
      const failed = { ...task, state: 'failed', error: error.message, history: [...(task.history ?? []), { at: startedAt, state: 'failed' }] };
      await store.writeTask(failed);
      return view(failed);
    }
    const placed = {
      ...task, input, placement: place.id, placement_label: place.label, started_at: startedAt,
      ...(licence.serve_source_link && tool.provenance?.repository ? { source_link: tool.provenance.repository } : {}),
    };
    if (reconnectMs && place.executor === 'http') placed.http_reconnect_before = task.http_reconnect_before ?? new Date(now().getTime() + reconnectMs).toISOString();
    if (place.executor === 'caller') {
      const handed = { ...placed, state: 'for_you_to_run', how: { invoke: tool.invoke, provenance: tool.provenance ?? null }, history: [...(task.history ?? []), { at: startedAt, state: 'for_you_to_run' }] };
      await store.writeTask(handed);
      try { await handedToCaller(handed); } catch (error) { console.error('telling the computer that runs it', error); }
      return view(handed);
    }
    const working = { ...placed, state: 'working', ...(held !== undefined ? { key_given: true } : {}), history: [...(task.history ?? []), { at: startedAt, state: 'working' }] };
    await store.writeTask(working);
    if (!task.public_run_limits) await told(working, tool);
    const work = execute(working, tool, place, joinHeld(input, held), { held, shared: everythingNow.shared, saved: everythingNow.saved, live: everythingNow.live });
    running.add(working.task_id);
    work.finally(() => running.delete(working.task_id));
    keepAlive(work);
    const wait = Math.min(Math.max(Number(wait_seconds ?? WAIT_SECONDS.default), 0), WAIT_SECONDS.max);
    let timer;
    const finished = await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(null), wait * 1000); })]);
    clearTimeout(timer);
    return view(finished ?? working);
  }

  // Tools whose result is a tool: what to run when no tool does a job yet, and how long that usually takes.
  function makers(tools) {
    return tools.filter(tool => tool.result_saved_as_tool).map(tool => ({
      tool_id: tool.id, label: tool.label ?? tool.id, job: tool.job, input_schema: tool.input_schema ?? { type: 'object' },
      expected_minutes: Math.max(1, Math.round((Number(tool.needs?.expected_seconds) || 60) / 60)),
      next_call: { tool: 'run_tool', arguments: { tool_id: tool.id, ...RUN_HINT } },
    }));
  }

  return {
    // The descriptors of `ids` (tools this account has), each read alone, so this never lists the whole Marketplace; a tool
    // that cannot be read now is null, never guessed.
    async descriptors(ids) {
      return Promise.all(ids.map(id => everything({ only: id }).then(now => now.tools.find(tool => tool.id === id) ?? null).catch(() => null)));
    },
    // A lost input submission read from the run it kept under its replay_key (never begun again): kept, it is answered
    // as a repeat answers it; not kept, it never reached the run.
    async provideInputOutcome({ task_id, input_version, replay_key, input } = {}) {
      const task = nonempty(task_id) && nonempty(replay_key) ? await store.readTask(task_id) : null;
      if (!task || !Object.hasOwn(task.input_submissions ?? {}, replay_key)) return { state: 'aborted' };
      return task.input_submissions[replay_key] === identityOf({ input_version, input }) ? { state: 'committed', result: { ...view(task), repeated: true } } : { state: 'unknown' };
    },
    async provideInput({ task_id, input_version, replay_key, input } = {}) {
      if (!nonempty(task_id) || !nonempty(input_version) || !nonempty(replay_key) || replay_key.length > 200
        || ['__proto__', 'prototype', 'constructor'].includes(replay_key) || !object(input)) {
        throw new WorkshopError('task_id, input_version, replay_key and an input object are required.');
      }
      // Capture the earlier start before exposing this submission. A later
      // retry waits for this turn; waiting back on that retry would deadlock.
      const pendingStart = starting.get(task_id);
      const turn = (submittingInput.get(task_id) ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (pendingStart) await pendingStart.catch(() => {});
        let task = await store.readTask(task_id);
        if (!task) throw new WorkshopError(`There is no task ${task_id} for this account.`);
        const submissionIdentity = identityOf({ input_version, input });
        if (Object.hasOwn(task.input_submissions ?? {}, replay_key)) {
          if (task.input_submissions[replay_key] !== submissionIdentity) throw new WorkshopError('This replay_key was already used with different inputs. Use a new replay_key.');
          return { ...view(task), repeated: true };
        }
        if (task.state !== 'waiting_for_input' || !task.pending_input) throw new WorkshopError(`Task ${task_id} is ${task.state}, not waiting for input.`);
        if (task.pending_input.version !== input_version) throw new WorkshopError('The requested inputs changed. Read the run again and submit the current fields.');
        const permitted = new Set(task.pending_input.fields.map(field => field.name));
        const extras = Object.keys(input).filter(name => !permitted.has(name));
        if (!Object.keys(input).length || extras.length) throw new WorkshopError(extras.length ? `Only these missing fields can be supplied: ${[...permitted].join(', ')}.` : 'Supply at least one requested field.');
        const merged = { ...task.input, ...input };
        const everythingNow = await everything({ only: task.tool_id });
        const tool = await toolById(everythingNow, task.tool_id);
        if (!tool) throw new WorkshopError(`There is no tool ${task.tool_id} any more.`);
        const currentMissing = pendingInputFields(schemaProblems(task.input, tool.input_schema, 'input'), tool.input_schema);
        const currentVersion = currentMissing
          ? `1f:${identityOf({ task_id: task.task_id, tool_version: workshopToolVersion(tool), fields: currentMissing })}` : null;
        if (currentVersion !== task.pending_input.version || canonical(task.pending_input.fields.map(field => field.name)) !== canonical(currentMissing ?? [])) {
          throw new WorkshopError('The tool input contract changed. Read the run again before supplying its current fields.');
        }
        const invalid = schemaProblems(merged, tool.input_schema, 'input');
        const stillMissing = pendingInputFields(invalid, tool.input_schema);
        if (stillMissing) throw new WorkshopError(`Supply all currently requested fields: ${stillMissing.join(', ')}.`);
        if (invalid.length) throw new WorkshopError(`${invalid.join('; ')}. The input must match this tool's input_schema.`);
        if (task.space_authorization) await authorizeSpaceTask(task.space_authorization, tool);
        task = { ...task, state: 'working', input: merged,
          pending_input: undefined, input_submissions: { ...(task.input_submissions ?? {}), [replay_key]: submissionIdentity },
          history: [...(task.history ?? []), { at: now().toISOString(), state: 'working' }] };
        await store.writeTask(task);
        return begin(task, { wait_seconds: WAIT_SECONDS.default, held: undefined });
      });
      submittingInput.set(task_id, turn);
      try { return await turn; }
      finally { if (submittingInput.get(task_id) === turn) submittingInput.delete(task_id); }
    },
    // Whether run() would answer this request at once and keep nothing (readOnce): the account takes no receipt for it.
    async answersOnce(request) { return answersOnceFrom(await data(), request); },
    // A run_tool call repeating the request_key of a task that already finished is answered with that task as it is
    // (startOnce), so the call writes nothing and needs no receipt. On 2026-10-10 the Mac app asked tool:voice-for up to
    // ten times within a second under one request_key, and each repeat wrote a receipt into the person's store.
    // The task kept under a request's tool and request_key, when it is that request's own: made from the same input (its
    // write-only fields left out, as the task keeps it), in the same place, share and binding (startOnce). Otherwise
    // null: a task the same key made from other input is another request's, so a run refused for it did nothing. A lost
    // run is decided by this (src/standalone-resource-behavior.mjs ownReadbacks tools:run).
    async answering({ tool_id, input = {}, request_key, run_at, repeat_every_hours, share, space_authorization, resource_authorization } = {}) {
      if (!nonempty(tool_id) || !nonempty(request_key) || !object(input)) return null;
      const task = await store.readTask(workshopTaskId({ tool_id, request_key }));
      if (!task) return null;
      const tool = await toolById(await everything({ only: tool_id, share }), tool_id);
      const { kept } = tool ? splitWriteOnly(input, tool.input_schema) : { kept: input };
      const own = task.input_identity === identityOf({ input: kept, run_at: run_at ?? null, repeat_every_hours: repeat_every_hours ?? null })
        && canonical(task.space_authorization ?? null) === canonical(space_authorization ?? null)
        && canonical(task.resource_authorization ?? null) === canonical(resource_authorization ?? null)
        && (task.share ?? null) === (share ?? null);
      return own ? task : null;
    },
    async repeatsFinished(request) {
      const task_id = workshopTaskId(request ?? {});
      const task = task_id ? await store.readTask(task_id) : null;
      return Boolean(task) && (task.state === 'completed' || task.state === 'failed') && task.cut_off !== true && !task.waiting_on;
    },
    // One shared row asked from Trillion's own code, and nothing about it is kept: no task, input or output, so the
    // conversation it carries stays in memory and a call made many times a minute writes nothing. A web row is sent
    // through the locked box with this account's connection, exactly as a run sends it (one of the person's own AIs asking the
    // model the person chose, src/own-ais-routing.mjs). Any other row runs through its placement's executor, the way
    // begin() picks it, and its output is checked against the row's schema (a model on the person's own computer,
    // src/model-routes.mjs). A row with a price is charged per run, and a charge is kept on its run, so it is refused
    // here and runs with run(). `timeout_ms` bounds the wait; a late answer is let go.
    // tools:execute: one attempt of one tool run whose own owner keeps the run (src/tool-run-owner.mjs). Nothing is
    // kept here: no task, no receipt, no retry. The run owner journals the attempt before it asks and keeps what this
    // answers; write-only input (held) lives only in this call and is scrubbed from what it answers. A tool that
    // needs something only a kept task carries today is refused by name (runOwnerGaps), never run half-way.
    async executeForRun({ tool_id, input = {}, held, run_id, attempt }) {
      if (!/^task_[0-9a-f]{32}$/.test(String(run_id)) || !Number.isInteger(attempt) || attempt < 1) throw Object.assign(new WorkshopError('An attempt names its run and its attempt number.'), { not_sent: true });
      if (!object(input) || (held !== undefined && !object(held))) throw Object.assign(new WorkshopError('input must be an object matching the tool\'s input_schema.'), { not_sent: true });
      const heldHere = heldInRun(held);
      // Whether its tool was asked: a refusal before that is known not to have run it (not_sent), anything after is not.
      let sent = false;
      try {
        const everythingNow = await everything({ only: tool_id });
        const tool = await toolById(everythingNow, tool_id);
        if (!tool) throw new WorkshopError(`There is no tool ${tool_id}.`);
        const { place } = choosePlacement(tool, everythingNow);
        const gaps = runOwnerGaps(tool, place);
        // A connection the account does not hold would be paid for through a gateway: that is a charge too.
        for (const { secret_name } of credentialInjections(tool.invoke)) if (!box || !(await box.check_exists(secret_name))) { gaps.push(`the connection ${secret_name}`); break; }
        if (gaps.length) throw new WorkshopError(`${tool_id} needs ${gaps.join(', ')}, which a tool run's own owner does not carry yet.`);
        // Held input is only the tool's own write-only fields: it never stands in for input the run kept and admitted.
        const notWriteOnly = Object.keys(held ?? {}).filter(field => tool.input_schema?.properties?.[field]?.writeOnly !== true);
        if (notWriteOnly.length) throw new WorkshopError(`${notWriteOnly.join(', ')} ${notWriteOnly.length === 1 ? 'is' : 'are'} not write-only input of ${tool_id}, so ${notWriteOnly.length === 1 ? 'it' : 'they'} can only come from the run.`);
        const resolved = await resolveRefs(input);
        const problems = schemaProblems(joinHeld(resolved, held), tool.input_schema, 'input');
        if (problems.length) throw new WorkshopError(`${problems.join('; ')}. The input must match this tool's input_schema.`);
        const reach = executionReach(tool, everythingNow, heldHere);
        const asked = { task_id: run_id, request_key: `${run_id}:${attempt}`, in_memory: true };
        await requireEnabledCapability(tool, everythingNow);
        await sampleChecked(tool, place, reach, heldHere);
        const { input: withFiles, placements } = await runFiles(tool, resolved, reach.from_shared_row);
        const invocation = await buildInvocation(tool.invoke, { input: reach.from_shared_row ? await yourRecords(withFiles, tool.input_schema, records) : withFiles, task: asked, needs: tool.needs, fetchBytes, request: true });
        // Samples, files and bindings can await: the capability is checked again at the send, and again at the result.
        await requireEnabledCapability(tool, everythingNow);
        // A tool placed on the caller's own computer is handed to it, not run here: the run's owner keeps the run waiting
        // for that computer (for_you_to_run), which takes it (handOver) and answers it (checkAnswer). A key cannot wait.
        if (place.executor === 'caller') {
          if (held !== undefined) throw new WorkshopError(`${tool_id} runs on your own computer, which takes the run later, so a key cannot be given to it with the run.`);
          try { await handedToCaller({ task_id: run_id, tool_id, placement: place.id }); } catch (error) { console.error('telling the computer that runs it', error); }
          return { handed_to_caller: { placement: place.id, placement_label: place.label } };
        }
        sent = true;
        const raw = await executors[place.executor]({ tool, placement: place, invocation, input: joinHeld(resolved, held), task: asked, ...reach, placements, held: held !== undefined });
        await requireEnabledCapability(tool, everythingNow);
        const output = outputOf(tool, heldHere.value(raw));
        const wrong = object(output) && 'selector_contract_error' in output ? [`the result has no ${tool.result_selector}`] : [...schemaProblems(output, tool.output_schema, 'output'), ...jobProblems(tool, resolved, output)];
        if (wrong.length) throw new WorkshopError(`${tool.label ?? tool_id} answered something else: ${wrong.join('; ')}.`);
        return { output, placement: place.id };
      } catch (error) {
        const notSentMark = sent ? {} : { not_sent: true };
        if (error instanceof WorkshopError) throw Object.assign(new WorkshopError(heldHere.text(error.message)), notSentMark);
        throw Object.assign(new Error(heldHere.text(String(error?.message ?? error)).slice(0, 600)), { status: error?.status ?? 502, ...(error?.retryable === true ? { retryable: true } : {}), ...notSentMark });
      }
    },
    // The tool of a run its owner handed to the caller's own computer, for the computer the owner let take it: the tool
    // as saved, who made it, and its code archive, whose fingerprint that computer checks before running a byte of it.
    // Nothing is kept here; the run's owner keeps who took it and for how long.
    async handOver({ tool_id }) {
      const everythingNow = await everything({ only: tool_id });
      const tool = await toolById(everythingNow, tool_id);
      if (!tool) throw new WorkshopError(`There is no tool ${tool_id}.`);
      if (choosePlacement(tool, everythingNow).place.executor !== 'caller') throw new WorkshopError(`${tool_id} does not run on the caller's own computer.`);
      await requireEnabledCapability(tool, everythingNow);
      const fingerprint = typeof tool.invoke?.files === 'string' ? tool.invoke.files : tool.bytes_fingerprint;
      const archive = fingerprint && store.readBytes ? await store.readBytes(fingerprint) : null;
      return { descriptor: tool, made_by: madeByOf(everythingNow, tool),
        ...(archive ? { bytes_fingerprint: fingerprint, bytes_base64: FETCHES.base64(new Uint8Array(archive)) } : {}) };
    },
    // What the caller's computer answered for a run, checked against the tool's contract as any run's answer is: the
    // output, or the refusal saying what is wrong with it. Nothing is kept here; the run's owner keeps the answer.
    async checkAnswer({ tool_id, input = {}, raw, error }) {
      const everythingNow = await everything({ only: tool_id });
      const tool = await toolById(everythingNow, tool_id);
      if (!tool) throw new WorkshopError(`There is no tool ${tool_id} any more.`);
      if (raw === undefined) {
        if (!nonempty(error)) throw new WorkshopError('Give raw (what the tool returned) or error (what went wrong).');
        return { error: String(error).slice(0, 600) };
      }
      await requireEnabledCapability(tool, everythingNow);
      const output = outputOf(tool, raw);
      const problems = object(output) && 'selector_contract_error' in output ? [`the result has no ${tool.result_selector}`] : [...schemaProblems(output, tool.output_schema, 'output'), ...jobProblems(tool, input, output)];
      return problems.length ? { error: `${tool.label ?? tool_id} answered something else: ${problems.join('; ')}.`, contract: { passed: false, problems } }
        : { output, contract: { passed: true, problems: [] } };
    },
    async askInMemory({ tool_id, input, timeout_ms, priority, take_within_ms }) {
      // This road admits only shipped tools and the one published row of a default publisher (src/marketplace-defaults.mjs:
      // the Marketplace publisher's screen reads). Loading every saved and published tool for a model check can hold
      // several full catalogs in one person's isolate while the model answers.
      const shared = await data();
      const tool = shared.tools.find(item => item.id === tool_id && item.invoke) ?? await defaultPublishedTool(shared, tool_id);
      if (!tool) throw new WorkshopError(`${tool_id} is not a tool this service ships or a default publisher publishes.`);
      if (tool.invoke.kind === 'http') {
        if (!box) throw new WorkshopError('This service holds no connections, so it cannot ask a model with one.');
        for (const { secret_name } of credentialInjections(tool.invoke)) {
          if (!(await box.check_exists(secret_name))) throw new WorkshopError(`${tool.label ?? tool_id} needs its account connected first (${tool.invoke.connection_id}).`);
        }
        const invocation = await buildInvocation(tool.invoke, { input, task: {}, needs: tool.needs, fetchBytes, request: true });
        if (Number.isFinite(timeout_ms) && timeout_ms > 0) invocation.timeout_ms = Math.min(Number(invocation.timeout_ms) || 300000, timeout_ms);
        let grants = grantsOf(shared.tools, []);
        if (credentialInjections(tool.invoke).some(({ secret_name }) => !grants.has(secret_name) && !publishedGrantForInstance(grants, secret_name))) {
          const saved = readToolData((await store.readSavedTools()).filter(row => row.status !== 'deleted').map(row => ({ payload: { listed_on: row.saved_at, ...row } })), shared.placements).tools;
          grants = grantsOf(shared.tools, saved);
        }
        await requireEnabledCapability(tool,{shared,saved:[]});
        const output=await httpJson({ invocation, send: sendThroughBox(grants, tool) });
        await requireEnabledCapability(tool,{shared,saved:[]});
        return output;
      }
      if (priceOf(tool, shared) || tool.billing) throw new WorkshopError(`${tool_id} is charged per run, so it runs with run_tool and its run is kept.`);
      const problems = schemaProblems(input, tool.input_schema, 'input');
      if (problems.length) throw new WorkshopError(`${problems.join('; ')}. The input must match this tool's input_schema.`);
      const { place } = choosePlacement(tool, { placementsById: new Map(shared.placements.map(item => [item.id, item])), licences: new Map(shared.licence_classes.map(item => [item.id, item])) });
      const key = `ask_${crypto.randomUUID()}`;
      // A caller's priority (0-9) orders the ask on a computer's queue (src/agent-tool-runs.mjs invariant 4).
      // in_memory: the ask is kept nowhere, so a computer is handed it in memory too (src/agents.mjs invariants).
      const task = { task_id: key, request_key: key, in_memory: true, ...(Number.isInteger(priority) && priority >= 0 && priority <= 9 ? { priority } : {}) };
      const invocation = await buildInvocation(tool.invoke, { input, task, needs: tool.needs, fetchBytes, request: true });
      // The asker's wait goes with the work, so a computer's queue never hands it out after nobody reads its answer.
      // An executor may answer at once (an account action such as tool:voice-for returns its value, not a promise), so
      // the ask is always a promise: a plain value ".catch"ed below refused every quiet account row with
      // "G.catch is not a function" (2026-10-07).
      await requireEnabledCapability(tool,{shared,saved:[]});
      const asked = (async () => executors[place.executor]({ tool, placement: place, invocation, input, task, ...(Number.isFinite(timeout_ms) && timeout_ms > 0 ? { wait_ms: timeout_ms } : {}),
        ...(Number.isFinite(take_within_ms) && take_within_ms > 0 ? { take_within_ms } : {}) }))();
      let timer;
      const late = Number.isFinite(timeout_ms) && timeout_ms > 0
        ? new Promise((_, reject) => { timer = setTimeout(() => reject(new WorkshopError(`${tool.label ?? tool_id} did not answer within ${Math.round(timeout_ms / 1000)} seconds.`)), timeout_ms); })
        : null;
      asked.catch(() => {});
      try {
        const output = outputOf(tool, await (late ? Promise.race([asked, late]) : asked));
        await requireEnabledCapability(tool,{shared,saved:[]});
        const wrong = object(output) && 'selector_contract_error' in output ? [`the result has no ${tool.result_selector}`] : schemaProblems(output, tool.output_schema, 'output');
        if (wrong.length) throw new WorkshopError(`${tool.label ?? tool_id} answered something else: ${wrong.join('; ')}.`);
        return output;
      } finally {
        clearTimeout(timer);
      }
    },
    // A shared web row marked `runs_quietly` (a light following the sound, sent every second or two) sent from the
    // person's own screen: the same locked-box send as askInMemory, and nothing kept, so ambient effects never fill
    // the person's runs. A row not marked so is refused; it runs through run() and is kept like any run.
    async sendQuietly({ tool_id, input }) {
      const everythingNow = await everything({ only: tool_id });
      const tool = everythingNow.shared.tools.find(item => item.id === tool_id);
      if (!tool?.runs_quietly) throw new WorkshopError(`${tool_id} is not a tool that runs quietly; run it with run_tool.`);
      return this.askInMemory({ tool_id, input });
    },
    async find({ job, limit = 5, allowed_tool_ids = null, search_mode = null }) {
      if (!nonempty(job)) throw new WorkshopError('job is required: say what needs doing in plain words, for example "transcribe this audio file".');
      const allowed = Array.isArray(allowed_tool_ids) ? new Set(allowed_tool_ids) : null;
      if (allowed?.size === 0) return { job, candidates: [] };
      // A Space already names the definitions its members may discover. Read those exact IDs instead of assembling
      // the whole Marketplace before filtering it down to the Space's grants.
      const catalogs = allowed ? await Promise.all([...allowed].map(id => everything({ only: id }))) : null;
      const everythingNow = catalogs ? {
        ...catalogs[0],
        tools: catalogs.flatMap(catalog => catalog.tools.filter(tool => allowed.has(tool.id))).filter((tool, index, tools) => tools.findIndex(other => other.id === tool.id) === index),
        screens: catalogs.flatMap(catalog => catalog.screens.filter(tool => allowed.has(tool.id))).filter((tool, index, screens) => screens.findIndex(other => other.id === tool.id) === index),
        publishers: new Map(catalogs.flatMap(catalog => [...catalog.publishers])),
        sharedIds: new Set(catalogs.flatMap(catalog => [...catalog.sharedIds])),
        savedIds: new Set(catalogs.flatMap(catalog => [...catalog.savedIds])),
        liveIds: new Set(catalogs.flatMap(catalog => [...catalog.liveIds])),
        throughIds: new Set(catalogs.flatMap(catalog => [...catalog.throughIds])),
      } : await everything({ wait: true });
      const { placementsById, shared } = everythingNow;
      const runnable = allowed ? everythingNow.tools.filter(tool => allowed.has(tool.id)) : everythingNow.tools;
      // The pursuit Tools picker can add any shared screen-only tool as a place, even when the screen has no run
      // controls (Write and Edit on canvas are examples). Ordinary job search still includes only runnable tools and
      // screen tools with live controls; a screen with no action must not look like something an AI can run.
      const screenTools = search_mode === 'space-tools'
        ? everythingNow.screens.filter(tool => !allowed || allowed.has(tool.id))
        : (shared.tools ?? []).filter(tool => !tool.invoke && object(tool.screen) && object(tool.controls) && (tool.status ?? 'active') === 'active' && (!allowed || allowed.has(tool.id)));
      const tools = search_mode === 'words' ? runnable : [...runnable, ...screenTools.filter(tool => !runnable.some(other => other.id === tool.id))];
      const madeBy = tool => madeByOf(everythingNow, tool);
      const wanted = words(job);
      // The command palette needs names a person can choose, not marketplace discovery or run-history ranking.
      // Keep this path to the account's already-available tools and lexical matching; typing must not trigger
      // embeddings, run-stat reads, or a registry search for every query.
      if (search_mode === 'words') {
        const wantedCount = Math.min(Math.max(Number(limit) || 5, 1), 20);
        const candidates = tools.map(tool => {
          const match = wordShare(wanted, toolWords(tool));
          return { tool, match };
        }).filter(item => item.match > 0).sort((a, b) => b.match - a.match)
          .slice(0, wantedCount)
          .map(({ tool }) => ({ tool_id: tool.id, label: tool.label ?? tool.id, job: tool.job ?? '' }));
        return { job, candidates };
      }
      // relevance answers null when meaning cannot be had now (the model road is stopped): the word match ranks alone and
      // the answer says so.
      const [stats, meaning] = await Promise.all([pool.stats(tools.map(tool => tool.id), job), pool.relevance ? pool.relevance(job, tools.map(tool => ({ id: tool.id, job: toolMeaning(tool) }))) : {}]);
      const byWords = meaning === null ? { matched_by_words: MATCHED_BY_WORDS } : {};
      // Proven means people said the tool did the job (report_result). A contract that passed only says the output had
      // the right shape, so passes never raise a tool; a broken contract is a failure, and one on a job like this one
      // counts twice. A tool nobody has reported on ranks with a new one.
      const proven = run => {
        const similar = run?.similar_jobs ?? { runs: 0, contract_passed: 0 };
        const met = run?.reported_met ?? 0;
        const failed = (run?.reported_failed ?? 0) + ((run?.runs ?? 0) - (run?.contract_passed ?? 0)) + (similar.runs - similar.contract_passed);
        return (met + 1) / (met + failed + 2);
      };
      const scored = tools.map(tool => {
        const lexical = wordShare(wanted, toolWords(tool));
        return { tool, match: Math.max(lexical, meaning?.[tool.id] ?? 0), proven: proven(stats[tool.id]) };
      }).filter(item => item.match > 0).sort((a, b) => b.match - a.match || b.proven - a.proven);
      const wantedCount = Math.min(Math.max(Number(limit) || 5, 1), 20);
      const candidates = scored.slice(0, wantedCount).map(item => toolCard(item.tool, placementsById, stats[item.tool.id], host, madeBy(item.tool)));
      // Ask registries at find time even when broad local matches fill the usual slots. Sources marked
      // provenance.surface='alongside' are independent candidates: surface them without displacing local results.
      const asked = sources ? await sources.search(job, wantedCount) : { rows: [], unread: [] };
      const fromSources = readToolData(asked.rows.map(payload => ({ payload })), shared.placements).tools.filter(tool => (!allowed || allowed.has(tool.id)) && !candidates.some(card => card.tool_id === tool.id));
      const sourceStats = fromSources.length ? await pool.stats(fromSources.map(tool => tool.id), job) : {};
      const ordinarySources = fromSources.filter(tool => tool.provenance?.surface !== 'alongside');
      const alongsideSources = fromSources.filter(tool => tool.provenance?.surface === 'alongside');
      candidates.push(...ordinarySources.slice(0, Math.max(wantedCount - candidates.length, 0)).map(tool => toolCard(tool, placementsById, sourceStats[tool.id], host, `a registry (${tool.billing?.source ?? 'outside'})`)));
      candidates.push(...alongsideSources.slice(0, wantedCount).map(tool => toolCard(tool, placementsById, sourceStats[tool.id], host, `a registry (${tool.billing?.source ?? 'outside'})`)));
      const unreadSources = asked.unread.length ? asked.unread : undefined;
      const unavailableReply = unavailableFields(everythingNow.unavailable);
      const makeOne = makers(tools).filter(maker => !candidates.some(card => card.tool_id === maker.tool_id));
      return candidates.length
        ? { job, candidates, ...byWords, ...(unreadSources ? { unread_sources: unreadSources } : {}), ...unavailableReply, ...(makeOne.length ? { or_make_one: makeOne } : {}) }
        : { job, candidates: [], ...byWords, ...(unreadSources ? { unread_sources: unreadSources } : {}), ...unavailableReply, make_one: makeOne, next_call: makeOne[0]?.next_call ?? { tool: 'save_tool', arguments: { descriptor: '(a tool you built for this job: id, job, input_schema, output_schema, invoke, placements, licence_class)' } }, note: 'No tool here does this job yet. A tool in make_one can make one from a public repository, and save_tool keeps any tool you build.' };
    },

    run: start,
    // Whether a run of `request` keeps nothing of its own: a read of a read_only row (readOnce), or an exact retry of a
    // finished run (answered with its task). Its command keeps no journal of its own (src/resource-behavior-commands.mjs
    // keepsNothing), and the run asked with reads_once refuses to keep a task.
    keepsNothingAsked: async request => nonempty(request?.tool_id) && nonempty(request?.request_key) && object(request.input ?? {})
      && !request.resource_authorization && !boundToolParts(request.tool_id)
      && (answersOnceFrom(await data(), request) || Boolean(await finishedRepeat(request))),
    runPublicApp: (input, permission) => runPublicApp(input, permission),
    readPublicApp: input => readPublicApp(input),
    relay: relayCall,reconcileRelay,

    // The whole shelf, for a person to browse rather than an AI to match a job: every tool this account can use (the
    // cards find returns, unranked, each with who made it, whether this account published it and the places it may
    // run), and this account's newest runs (RUNS_LISTED, src/workshop-tasks.mjs), each with what the person reported about it. With tool_id, that one
    // tool (a registry's tool too, read by its id) and only its runs. It runs nothing and changes nothing.
    async list({ tool_id, takes_input, for_thing, runs_only = false } = {}) {
      if (runs_only) {
        const cards = await store.taskCards({});
        const ids = [...new Set(cards.map(card => card.tool_id).filter(Boolean))];
        const labels = new Map(await Promise.all(ids.map(async id => {
          const catalog = await everything({ only: id });
          const tool = catalog.tools.find(item => item.id === id) ?? catalog.screens.find(item => item.id === id);
          return [id, tool?.label ?? id];
        })));
        return { tools: [], runs: cards.map(card => ({ ...card, label: labels.get(card.tool_id) ?? card.tool_id })) };
      }
      const everythingNow = await everything({ only: nonempty(tool_id) ? tool_id : undefined });
      const unavailableReply = unavailableFields(everythingNow.unavailable);
      const one = nonempty(tool_id) ? await toolById(everythingNow, tool_id) ?? everythingNow.screens.find(item => item.id === tool_id) ?? null : null;
      if (nonempty(tool_id) && !one) throw new WorkshopError(`There is no tool ${tool_id}.`);
      const shelf = one ? [one] : [...everythingNow.tools, ...everythingNow.screens.filter(tool => !object(tool.screen.surface))];
      const matched = nonempty(takes_input) ? shelf.filter(tool => tool.invoke && Object.hasOwn(tool.input_schema?.properties ?? {}, takes_input)) : shelf;
      const tools = for_thing && typeof for_thing === 'object' ? matched.filter(tool => thingActions([toolCard(tool, everythingNow.placementsById, undefined, host, madeByOf(everythingNow, tool))], for_thing).length > 0) : matched;
      const selected = nonempty(takes_input) || for_thing;
      const [stats, cards] = await Promise.all([selected ? {} : pool.stats(tools.map(tool => tool.id)), selected ? [] : store.taskCards({ tool_id: one?.id })]);
      const labelOf = new Map(tools.map(tool => [tool.id, tool.label ?? tool.id]));
      return {
        tools: tools.map(tool => ({
          ...toolCard(tool, everythingNow.placementsById, stats[tool.id], host, madeByOf(everythingNow, tool)),
          places: tool.placements ?? [],
          published_by_you: Boolean(maker) && everythingNow.publishers.get(tool.id) === maker,
        })),
        runs: cards.map(card => ({ ...card, label: labelOf.get(card.tool_id) ?? one?.label ?? card.tool_id })),
        ...unavailableReply,
      };
    },

    // The sources whose tools are read live here (an API with a description, an open tool server): every account's
    // (records/live-tool-sources.json) and this account's own, each as last read (its version, when, any failure, the
    // tools it gave and what was held back with why). `add` names one more for this account ({ kind, url, name?,
    // headers?, connection?, only? }); `remove` takes one of this account's own away by id. A tool server that takes a
    // sign-in or a key is added with add-a-tool-server, which keeps the sign-in or key in this account's locked box.
    async sources({ add = null, remove = null } = {}) {
      if (!sourced?.put) throw new WorkshopError('This service keeps no tool sources.');
      const config = typeof sourced.config === 'function' ? await sourced.config() : sourced.config;
      const own = async () => (await sourced.own()).filter(row => row.status !== 'deleted');
      if (add) {
        if (!object(add)) throw new WorkshopError('add must be { kind, url, name?, headers?, connection?, only? }.');
        let host = '';
        try { host = new URL(String(add.url)).hostname; } catch { host = ''; }
        const row = Object.fromEntries(['kind', 'url', 'name', 'headers', 'connection', 'only'].filter(field => add[field] !== undefined).map(field => [field, add[field]]));
        row.id = String(add.id ?? `${host}-${row.kind}`).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 63);
        const problems = liveSourceProblems(row, config.kinds);
        if (problems.length) throw new WorkshopError(`This source cannot be read: ${problems.join(' ')}`, { problems });
        if (config.sources.some(item => item.id === row.id)) throw new WorkshopError(`${row.id} is already read for every account.`);
        await sourced.put({ ...row, added_at: now().toISOString() });
      }
      if (remove) {
        const row = (await own()).find(item => item.id === remove);
        if (!row) throw new WorkshopError(`${remove} is not a source this account added.`);
        await sourced.put({ ...row, status: 'deleted', removed_at: now().toISOString() });
      }
      const mine = await own();
      const reads = await sourced.reads(mine);
      if (typeof sourced.config === 'function' && canonical(await sourced.config()) !== canonical(config))
        throw new WorkshopError('The tool-source definitions changed during this read; read the current sources again.');
      const shown = (source, read) => ({ ...source, ...(read ? { version: read.version, read_at: read.read_at, checked_at: read.checked_at, ...(read.error ? { error: read.error } : {}), tools: read.tools ?? [], held: read.held ?? [] } : {}) });
      const readOf = (id, scope) => reads.find(read => read.source_id === id && (!read.scope || read.scope === scope));
      const ownIds = new Set(mine.map(source => source.id));
      return {
        every_account: config.sources.map(source => ownIds.has(source.id) ? {...source,overridden_by_account:true} : shown(source, readOf(source.id, 'default'))),
        yours: mine.map(source => shown(source, readOf(source.id, 'account'))),
        kinds: Object.entries(config.kinds).map(([id, kind]) => ({ id, label: kind.label, becomes: kind.becomes })),
      };
    },

    // The screens this account's page offers, one page at a time, so opening Trillion costs the same with one tool or ten
    // thousand: on the first page every screen the service ships (a fixed set of shared rows), then this account's own
    // saved tools, each with either its custom screen or the shared described form, `limit` saved rows a page in id order, read through an index (store.savedToolsPage);
    // `next` names the page after. Nothing here reads every tool, their runs or how often each ran: a tool another account
    // published is found on the Marketplace and opened by its id (describe), never loaded with every page.
    async screens({ after = '', limit }) {
      const shared = await data();
      const active = tool => (tool.status ?? 'active') === 'active';
      const shipped = after ? [] : shared.tools.filter(tool => active(tool) && (tool.invoke ? Boolean(tool.placements) : object(tool.screen) && !object(tool.screen.surface)));
      const page = await store.savedToolsPage({ after, limit });
      const shippedIds = new Set(shared.tools.map(tool => tool.id));
      const saved = readToolData(page.rows.filter(row => row.status !== 'deleted' && !shippedIds.has(row.id)).map(row => ({ payload: { listed_on: row.saved_at, ...row } })), shared.placements).tools
        .filter(tool => (tool.invoke ? tool.placements : screenOnly(tool)) && active(tool));
      const placementsById = new Map(shared.placements.map(place => [place.id, place]));
      return {
        tools: [...shipped.map(tool => toolCard(tool, placementsById, undefined, host, 'shared')), ...saved.map(tool => toolCard(tool, placementsById, undefined, host, 'this account'))],
        next: page.next,
      };
    },

    // Scheduled tasks whose time has come start now; a repeating one leaves its next occurrence scheduled.
    async runDue() {
      const due = await store.dueTasks(now().getTime());
      for (const task of due) await startDue(task);
      return due.length;
    },
    async publishTelemetry({ task_id }) {
      return withReport(task_id,async()=>{
        let task=await store.readTask(task_id);
        if(!task)return {projected:true,erased:true};
        const run=task.run_pool_pending;
        if(run){
          const {notice_pending,...row}=run;
          const answer=await pool.recordRun(row);
          if(answer?.kept!==true)throw new WorkshopError('The shared owner has not acknowledged the exact original run.');
          const current=await store.readTask(task_id);
          if(current?.run_pool_pending?.run_key===run.run_key){
            task={...current,run_pool_pending:null,run_pool_key:run.run_key};
            if(notice_pending)task.notice_pool_pending=true;
            await store.writeTask(task);
          }else task=current;
        }
        const source=task?.source_pool_pending;
        if(source){
          const answer=await (sources.publish??sources.keep)(source);
          if(answer!==true&&answer?.kept!==true)throw new WorkshopError('The registry owner has not acknowledged the checked tool definition.');
          const current=await store.readTask(task_id);
          if(current?.source_pool_pending&&workshopToolVersion(current.source_pool_pending)===workshopToolVersion(source)){task={...current,source_pool_pending:null};await store.writeTask(task);}else task=current;
        }
        const pending=task?.report_pool_pending;
        if(pending){
          const answer=await pool.recordReport({tool_id:task.report_pool_tool_id??task.tool_id,report_key:task.report_pool_key,revision:pending.revision,result:pending.result,day:task.report_pool_day??task.reports?.find(report=>report.outcome_revision===pending.revision)?.reported_at?.slice(0,10),answered_by:'person',attribution_basis:'trusted_person_source'});
          if(answer?.kept!==true)throw new WorkshopError('The shared owner has not acknowledged the exact original report.');
          const current=await store.readTask(task_id);
          if(current?.report_pool_pending?.revision===pending.revision){task={...current,report_pool_pending:null,report_pool_revision:pending.revision};await store.writeTask(task);}else task=current;
        }
        if(task?.notice_pool_pending){
          const tool=await toolById(await everything({only:task.tool_id}),task.tool_id);
          if(tool)await checkNotices(tool);
          const current=await store.readTask(task_id);
          if(current?.notice_pool_pending){task={...current,notice_pool_pending:false};await store.writeTask(task);}
        }
        return {projected:!task?.run_pool_pending&&!task?.source_pool_pending&&!task?.report_pool_pending&&!task?.notice_pool_pending};
      });
    },
    async nextDue() {
      return store.nextDueAt();
    },

    // Inspect only saved task state. Recovery, executor observation and cleanup remain in read().
    async snapshot({ task_id }) {
      const task = nonempty(task_id) ? await store.readTask(task_id) : null;
      if (!task) throw Object.assign(new WorkshopError(`There is no task ${task_id} for this account. Tasks are readable by any AI signed in as the same person.`), { status: 404, code: 'task-not-found', task_id });
      if (task.resource_authorization) {
        const tool = await toolById(await everything({ only: task.tool_id, persistedOnly: true }), task.tool_id, { resolve: false });
        await requireResourceTask(task.resource_authorization, tool, task.input);
      }
      if (task.space_authorization) {
        const tool = await toolById(await everything({ only: task.tool_id, persistedOnly: true }), task.tool_id, { resolve: false });
        if (!tool) throw new WorkshopError('This pursuit tool definition is not available to inspect this saved run.');
        await authorizeSpaceTask(task.space_authorization, tool, 'read');
      }
      return { ...view(task), snapshot_only: true, next_call: { tool: 'snapshot_task', arguments: { task_id: task.task_id } } };
    },

    async read({ task_id, expected_input, expected_tool_id, expected_run_at, expected_repeat_every_hours }) {
      const checking = expected_input !== undefined || expected_tool_id !== undefined;
      const verifyOriginal = async original => {
        if (!original || original.task_id !== task_id || expected_tool_id !== undefined && original.tool_id !== expected_tool_id) throw new WorkshopError("The original task/tool does not match this workflow commitment.");
        if (expected_input !== undefined) {
          if (!object(expected_input)) throw new WorkshopError("expected_input must be the original request input object.");
          const declared = await toolById(await everything({ only: original.tool_id }), original.tool_id);
          if (!declared) throw new WorkshopError("The original task input contract is unavailable; its result was not attributed to different work.");
          const { kept } = splitWriteOnly(expected_input, declared.input_schema);
          const expectedIdentity = identityOf({ input: kept, run_at: expected_run_at ?? null, repeat_every_hours: expected_repeat_every_hours ?? null });
          if (!original.input_identity || original.input_identity !== expectedIdentity) throw new WorkshopError("The original task input does not match this workflow commitment; the original task was retained.");
        }
      };
      const checked = async result => {
        if (!checking) return result;
        if (result?.task_id !== task_id) throw new WorkshopError("The read settled a different original task.");
        await verifyOriginal(await store.readTask(task_id));
        return { ...result, ...(expected_input !== undefined ? { input_matches: true } : {}), ...(expected_tool_id !== undefined ? { tool_matches: true } : {}) };
      };
      let task = nonempty(task_id) ? await store.readTask(task_id) : null;
      if (!task) throw new WorkshopError(`There is no task ${task_id} for this account. Tasks are readable by any AI signed in as the same person.`);
      const inputSubmission = submittingInput.get(task_id);
      if (inputSubmission) {
        try { await inputSubmission; } catch { /* recover from the durable task state below */ }
        task = await store.readTask(task_id);
        if (!task) throw new WorkshopError(`There is no task ${task_id} for this account.`);
      }
      // The task came from this person's store. Release a finished run even when its Space grant was revoked;
      // the grant check below still decides whether the result may be shown.
      await cleanupTerminalTask(task);
      if (task.resource_authorization) {
        const tool = await toolById(await everything({ only: task.tool_id }), task.tool_id);
        await requireResourceTask(task.resource_authorization, tool, task.input);
      }
      if (task.space_authorization) {
        try {
          await authorizeSpaceTask(task.space_authorization, await toolById(await everything({ only: task.tool_id }), task.tool_id), 'read');
        } catch (error) {
          // A revoked queued or staged run is settled as failed by the task
          // owner. It carries no output, releases its container, and removes
          // the indexed working wake instead of retrying forever. A completed
          // result remains terminal but is still hidden by the authorization
          // error; only an unfinished run is mutated here.
          if (task.state === 'working' && /grant|authoriz|revok|space/i.test(String(error?.message ?? ''))) {
            const at = now();
            const failed = { ...task, state: 'failed', finished_at: at.toISOString(), error: String(error.message ?? error).slice(0, 600), history: [...(task.history ?? []), { at: at.toISOString(), state: 'failed' }] };
            await store.writeTask(failed);
            await cleanupTerminalTask(failed);
            return checked(await view(failed));
          }
          // A revoked completed result is still unreadable; preserving the
          // existing authorization error avoids leaking its output.
          if (task.state !== 'failed' || !/grant|authoriz|revok|space/i.test(String(error?.message ?? ''))) throw error;
        }
      }
      if (checking) await verifyOriginal(task);
      if (task.waiting_on) {
        const settled = await retiredWait(task);
        await cleanupTerminalTask(settled);
        return checked(await view(settled));
      }
      if(task.state==='working'&&task.payment_finish){
        const finished=await finish(task,task.payment_finish.tool,{});
        await cleanupTerminalTask(finished);return checked(await view(finished));
      }
      if (task.state === 'scheduled' && Date.parse(task.due_at) <= now().getTime()) return startDue(task);
      // A tool definition may change while this task waits for input. Re-run
      // the same preflight so the task exposes its current fields and version.
      // begin() preserves the task's saved input and does not rewrite an
      // unchanged prompt.
      if (task.state === 'waiting_for_input') {
        const pendingStart = starting.get(task.task_id);
        if (pendingStart) return checked(await pendingStart);
        const refresh = begin(task, { wait_seconds: 0, held: undefined });
        const settled = refresh.finally(() => { if (starting.get(task.task_id) === settled) starting.delete(task.task_id); });
        starting.set(task.task_id, settled);
        return checked(await settled);
      }
      // A submitted input is durably accepted before its first placement check. If the host stopped or that
      // preflight failed before placement, the stored task is the only source of the submitted values. Resume it
      // only when no local submission is still driving it and the effect owner has no attempt for this task.
      if (task.state === 'working' && !task.placement && Object.keys(task.input_submissions ?? {}).length
        && !running.has(task.task_id) && !submittingInput.has(task.task_id)
        && !(store.readEffect && await store.readEffect(task.task_id))) {
        return checked(await begin(task, { wait_seconds: 0, held: undefined }));
      }
      // A task marked working that this host is not running was cut off (the host restarted mid-run). It is
      // reported as failed, so no caller waits on it forever.
      if (task.state === 'working' && !running.has(task.task_id)) {
        const at = now();
        // A run that charges, calls or messages someone and was cut off after it sent may have happened: it is recorded
        // as unknown and never invited to run again.
        const sent = store.readEffect ? await store.readEffect(task.task_id) : null;
        // Otherwise a run whose executor keeps it going across a restart (a container holds the run and how it ended) is
        // taken up again, a bounded number of times; one given a key cannot be, as the key is gone.
        const placement = await taskPlacement(task);
        if (!sent && canTakeUp(task, placement)) {
          if (await resumableRunIsActive(task, placement)) return checked(await view(task));
          return checked(await begin({ ...task, taken_up: (task.taken_up ?? 0) + 1 }, { wait_seconds: 0 }));
        }
        const unknown = sent?.state === 'dispatching' ? recordExternalEffectResult(sent, { outcome: 'timeout-after-dispatch' }) : null;
        if (unknown) await store.writeEffect(unknown);
        const stopped = {
          ...task, state: 'failed', finished_at: at.toISOString(), history: [...(task.history ?? []), { at: at.toISOString(), state: 'failed' }],
          ...(unknown
            ? { error: 'The service restarted after this request was sent, so it may have happened. It is not sent again: check with the service before asking for it again.', effect: { state: unknown.state } }
            : sent ? { error: 'The run stopped without finishing because Trillion restarted while it worked.' }
              : task.http_reconnect_before ? { error: 'The original web request has not reported its result. Check that job before starting another.', cut_off: false }
                : { error: RESTARTED, cut_off: true }),
        };
        await store.writeTask(stopped);
        await cleanupTerminalTask(stopped, placement);
        return checked(await view(stopped));
      }
      return checked(await view(task));
    },

    // This observes two already executed tasks. It never calls read(), which may resume unfinished execution.
    async observe({ task_id, target_task_id, binding = null }) {
      if (!nonempty(task_id) || !nonempty(target_task_id) || task_id === target_task_id) throw new WorkshopError('Independent observation needs a readback task and a different original action task.');
      const tasks = [];
      for (const id of [task_id, target_task_id]) {
        const task = await store.readTask(id);
        if (!task) throw new WorkshopError(`There is no task ${id} for this account.`);
        if (task.space_authorization) await authorizeSpaceTask(task.space_authorization, await toolById(await everything({ only: task.tool_id }), task.tool_id));
        tasks.push(task);
      }
      const [readback, target] = tasks;
      const seen = readback.last_observation;
      if (readback.state !== 'completed' || !readback.contract?.passed || seen?.capture_kind !== 'provider-readback') throw new WorkshopError('This task has no captured independent provider readback. A contract pass alone is not an observation.');
      const actual = taskEffectBinding(target);
      if (!actual || binding && !sameObservationTarget(binding, actual)) throw new WorkshopError('The original effect identity changed or was not captured.');
      const observedBinding = { ...actual, ...Object.fromEntries(['provider', 'account', 'object_id', 'route', 'connection_id', 'provider_origin'].map(field => [field, seen[field]])) };
      if (!sameObservationTarget(actual, observedBinding)) throw new WorkshopError('The readback is for another provider, account, object or route, or the original identity is unknown.');
      const targetAt = Date.parse(target.effect?.observation?.observed_at ?? target.finished_at ?? target.started_at);
      const seenAt = Date.parse(seen.observed_at);
      if (!Number.isFinite(targetAt) || !Number.isFinite(seenAt) || seenAt < targetAt) throw new WorkshopError('The readback predates the original effect or has no verifiable time.');
      return { source_ref: seen.source_ref, observed: seen.observed, observed_at: seen.observed_at, binding: observedBinding };
    },

    // Reports retain their actual author. Only explicit person testimony enters the anonymous per-task projection;
    // an agent's claim is not "You said" and a repeated or corrected report cannot inflate rankings.
    // A lost report read from the run's kept reports (never pushed to the Pool again): the report under its source_ref,
    // or the same words when it named none, is that report, answered as a repeat answers it; none, it was never kept.
    async reportOutcome({ task_id, result, summary, answered_by, source_ref, observed_at, supersedes } = {}, { person_source = null } = {}) {
      const task = nonempty(task_id) ? await store.readTask(task_id) : null;
      const reports = task?.reports ?? [];
      const kept = reports.find(report => source_ref !== undefined ? report.source_ref === source_ref
        : report.result === result && report.summary === summary && report.answered_by === answered_by && report.supersedes === supersedes
          && canonical(report.person_source ?? null) === canonical(person_source) && (observed_at === undefined || report.observed_at === observed_at));
      return kept ? { state: 'committed', result: { ...view(task), repeated: true } } : { state: 'aborted' };
    },
    report(input, { recorder = null, person_source = null } = {}) {
      const { task_id, result, summary, answered_by, source_ref, observed_at, supersedes } = input;
      if (person_source && !personReportVerified({ answered_by, person_source })) throw new WorkshopError('A trusted person source needs its verified origin and reference.');
      return withReport(task_id, async () => {
        let task = await store.readTask(task_id);
        if (!task) throw new WorkshopError(`There is no task ${task_id} for this account.`);
        if (task.space_authorization) await authorizeSpaceTask(task.space_authorization, await toolById(await everything({ only: task.tool_id }), task.tool_id));
        task = await store.readTask(task_id);
        if (!['completed', 'failed', 'for_you_to_run'].includes(task.state)) throw new WorkshopError('This run is still executing. Read its terminal result before reporting its outcome.');
        if (!['met', 'failed', 'unknown'].includes(result) || !nonempty(summary) || !nonempty(answered_by)) throw new WorkshopError('A report needs result (met, failed or unknown), summary and answered_by.');
        if (source_ref !== undefined && !nonempty(source_ref)) throw new WorkshopError('source_ref must name the original report.');
        const at = now().toISOString();
        const observed = observed_at === undefined ? at : claimedTime(observed_at, { now: new Date(at), field: 'observed_at' });
        const reports = task.reports ?? [];
        const same = report => report.result === result && report.summary === summary && report.answered_by === answered_by && report.supersedes === supersedes
          && canonical(report.person_source ?? null) === canonical(person_source)
          && (observed_at === undefined || report.observed_at === observed);
        const named = source_ref ? reports.find(report => report.source_ref === source_ref) : null;
        if (named && !same(named)) throw new WorkshopError('This report source already has different words. Keep a new source_ref and name the earlier report in supersedes.');
        if (named || reports.some(report => same(report) && (source_ref === undefined || report.source_ref === source_ref))) return { ...view(await poolReportedTask(task)), repeated: true };
        if (supersedes !== undefined && (!nonempty(supersedes) || supersedes === source_ref || !reports.some(report => report.source_ref === supersedes && report.answered_by === answered_by))) throw new WorkshopError('supersedes must name an earlier report from this author on this task.');
        if (supersedes && personReportVerified(reports.find(report => report.source_ref === supersedes)) && !person_source) throw new WorkshopError('An unverified claim cannot supersede a trusted person source. Keep it as a separate report.');
        const report = { result, summary, answered_by, ...(answered_by === 'person' ? { reported_for: 'person' } : {}),
          attribution_basis: person_source ? 'trusted_person_source' : 'caller_claim', ...(person_source ? { person_source } : {}), ...(recorder ? { recorded_by: recorder } : {}),
          source_ref: source_ref ?? `task-report:${task_id}:${reports.length + 1}`,
          observed_at: observed, reported_at: at, outcome_revision: reports.length + 1, ...(supersedes ? { supersedes } : {}) };
        const updated = { ...task, reports: [...reports, report] };
        if (personReportVerified(report) && latestTaskReport(updated, { personOnly: true }) === report) {
          if(!updated.report_pool_key){updated.report_pool_key=crypto.randomUUID();if(pool.deferred)updated.report_pool_tool_id=workshopLearningToolId(task.tool_id);}
          updated.report_pool_pending = { revision: report.outcome_revision, result: report.result };
          if(pool.deferred)updated.report_pool_day=at.slice(0,10);
        }
        await store.writeTask(updated);
        return view(await poolReportedTask(updated));
      });
    },

    async bind({ tool_id, binding }) {
      const all = await everything({ only: tool_id });
      const base = await toolById(all, tool_id);
      if (!base) throw new WorkshopError(`There is no tool ${tool_id}.`);
      const id = boundToolId(base.id, workshopToolVersion(base), binding);
      await toolById(all, id);
      return id;
    },
    save: input => saveTool(input),
    describe: input => describeTool(input),
    screenContext: input => screenContext(input),
    // A host supplies actual executors. Declaring a new transport string cannot make one exist.
    async admitOperation({ tool_id, tool_version, placements }) {
      const current = await everything({ only: tool_id });
      const tool = await toolById(current, tool_id);
      if (!tool?.invoke || workshopToolVersion(tool) !== tool_version) throw new WorkshopError('The executable operation definition changed.');
      const admitted = [];
      for (const id of placements ?? tool.placements ?? []) {
        try {
          const { place } = choosePlacement(tool, current, { placements: [id] });
          if (typeof executors[place.executor] === 'function') admitted.push(id);
        } catch (error) { if (!(error instanceof WorkshopError)) throw error; }
      }
      if (!admitted.length) throw new WorkshopError('No admitted host executor can run this operation.');
      return { placements: admitted };
    },
    answer: input => answerCallerRun(input),
    answerOutcome: input => answerOutcome(input),
    claim: input => claimCallerRun(input),
    claimOutcome: input => claimOutcome(input),
    delete: input => deleteTool(input),
    publish: input => publishTool(input),
    publishOutcome: input => publishOutcome(input),
    settleOwedSamples: input => settleOwedSamples(input),
    unpublish: input => unpublishTool(input),
    async sales(ask = {}) {
      // Given a file's identity or the sale id its note names, the one question is which of this maker's sales it
      // came from (src/sold-copies.mjs).
      if (ask.file !== undefined || ask.sale !== undefined) {
        const traced = traceAsk(ask);
        if (!traced) throw new WorkshopError('Give file (a file identity, 1f: then 64 hex) or sale (the sale its note names).');
        const found = market?.traceSold ? await market.traceSold(traced) : [];
        return found.length
          ? { traced: found.map(({ sale_id, tool_id, at, refunded_at, buyer, files }) => ({ sale_id, tool_id, sold_at: at, buyer, files, ...(refunded_at ? { refunded_at } : {}) })) }
          : { traced: [], says: SOLD_COPIES.words.unknown };
      }
      const rows = market?.sales ? await market.sales() : [];
      return { sales: rows.map(({ sale_id, tool_id, micros, currency, at, refunded_at }) => ({ sale_id, tool_id, amount: `$${(micros / 1e6).toFixed(4)}`, currency, at, ...(refunded_at ? { refunded_at } : {}) })),
        earned: `$${(rows.filter(row => !row.refunded_at).reduce((sum, row) => sum + row.micros, 0) / 1e6).toFixed(4)}`,
        payout: await (payouts ?? makeMakerPayouts({ maker, sales: async () => rows, payee: { read: async () => null, keep: async () => {} } })).status() };
    },
    // A maker's payout setup: opens their payee account once and returns the payment service's page to open.
    async setUpPayouts(input = {}) {
      if (!payouts) throw new WorkshopError('Payouts are not open on this Trillion yet. What your tools earn is kept and shown with tool_sales until they are.');
      try { return await payouts.setUp(input); } catch (error) { throw new WorkshopError(error.message); }
    },
  };
}

// The Workshop routes, over standard Request and Response like the case routes.
// POST /workshop/relay: one call from a relayed run's container. The container names the person's store
// (`x-trillion-person`) and shows the run's key (`authorization: Bearer <key>`); the body is { tool_id, input }.
// storeFor(id) → that person's store, whose relayToolCall answers { status, value } or { status, error }.
export async function handleRelayRequest(request, storeFor) {
  const person = request.headers.get('x-trillion-person') ?? '';
  const key = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  if (!/^[0-9a-f]{64}$/.test(person) || !key) return Response.json({ error: 'Not allowed.' }, { status: 403 });
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Send { tool_id, input } as JSON.' }, { status: 400 }); }
  const url = new URL(request.url);
  const resource = url.searchParams.get('resource') ?? request.headers.get('x-trillion-resource') ?? null;
  const task_id = url.searchParams.get('task') ?? body?.task_id;
  if (resource !== null && (!nonempty(resource) || resource.length > 2048 || !nonempty(task_id)))
    return Response.json({ error: 'This relay needs its original resource and task address.' }, { status: 400 });
  let store;
  try { store = await storeFor(person, { resource, task_id }); }
  catch (error) {
    if (passing(error) || error?.status === 503) throw error;
    return Response.json({ error: 'Not allowed.' }, { status: 403 });
  }
  const answer = await store.relayToolCall({ key, task_id, request_key: body?.request_key,
    tool_id: body?.tool_id, input: body?.input });
  return Response.json(answer.status === 200 ? answer.value : { error: answer.error }, { status: answer.status });
}

export async function handleWorkshopRequest(workshop, request, { reportContext = {} } = {}) {
  const url = new URL(request.url);
  const body = async () => { const raw = await request.text(); if (raw.length > 30_000_000) throw new WorkshopError('Request too large'); return JSON.parse(raw || '{}'); };
  const reply = (value, status = 200) => Response.json(value, { status });
  try {
    const task = url.pathname.match(/^\/tasks\/([^/]+)(?:\/(result|answer|claim|snapshot))?$/);
    if (request.method === 'POST' && url.pathname === '/tools/find') return reply(await workshop.find(await body()));
    if (request.method === 'POST' && url.pathname === '/tools/run') return reply(await workshop.run(await body()));
    if (request.method === 'POST' && url.pathname === '/tools/send-quietly') return reply(await workshop.sendQuietly(await body()));
    if (request.method === 'POST' && url.pathname === '/tools/save') return reply(await workshop.save(await body()));
    if (request.method === 'POST' && url.pathname === '/tools/list') return reply(await workshop.list(await body()));
    if (request.method === 'POST' && url.pathname === '/tools/sources') return reply(await workshop.sources(await body()));
    if (request.method === 'POST' && url.pathname === '/tools/screens') return reply(await workshop.screens(await body()));
    if (request.method === 'POST' && url.pathname === '/tools/describe') return reply(await workshop.describe(await body()));
    if (request.method === 'POST' && ['/tools/screen-context', '/tools/screenContext'].includes(url.pathname)) return reply(await workshop.screenContext(await body()));
    if (request.method === 'POST' && url.pathname === '/tools/delete') return reply(await workshop.delete(await body()));
    if (request.method === 'POST' && url.pathname === '/tools/publish') return reply(await workshop.publish(await body()));
    if (request.method === 'POST' && url.pathname === '/tools/unpublish') return reply(await workshop.unpublish(await body()));
    if (request.method === 'GET' && url.pathname === '/tools/sales') return reply(await workshop.sales(Object.fromEntries(['file', 'sale'].filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)]))));
    if (request.method === 'POST' && url.pathname === '/tools/payouts') { const input = await body(); return reply(await workshop.setUpPayouts({ origin: url.origin, email: typeof input.email === 'string' ? input.email : null, country: typeof input.country === 'string' ? input.country : null })); }
    if (task) {
      const task_id = decodeURIComponent(task[1]);
      if (request.method === 'GET' && !task[2]) return reply(await workshop.read({ task_id }));
      if (request.method === 'GET' && task[2] === 'snapshot') return reply(await workshop.snapshot({ task_id }));
      if (request.method === 'POST' && task[2] === 'result') return reply(await workshop.report({ task_id, ...(await body()) }, reportContext));
      if (request.method === 'POST' && task[2] === 'input') return reply(await workshop.provideInput({ task_id, ...(await body()) }));
      // The caller's own computer answers a run handed to it (the stream route's helper).
      if (request.method === 'POST' && task[2] === 'answer') return reply(await workshop.answer({ task_id, ...(await body()) }));
      if (request.method === 'POST' && task[2] === 'claim') return reply(await workshop.claim({ task_id, ...(await body()) }));
    }
    return reply({ error: 'Not found' }, 404);
  } catch (error) {
    // A call the platform cut off in passing (a deploy reset a store this request reached) is no refusal: it is thrown
    // on, so the Worker's one catch answers 503 "send this again" and never the platform's own words.
    if (passing(error)) throw error;
    return reply({ error: String(error.message ?? error), ...(error.next_call ? { next_call: error.next_call } : {}), ...(error.missing_connection ? { missing_connection: error.missing_connection } : {}) }, 400);
  }
}

// The `http` executor both hosts use: one request, the JSON reply as the raw result. The body is encoded as the
// tool's `body_encoding` says (json unless it says form, or bytes for a file sent whole). A tool that uses a connection
// (`invoke.credential_injections: [{ secret_name, placement }]`) is sent by the locked box through `send`: the box
// places the held value, sends, and hands back the reply with every placed value replaced. Nothing here ever holds
// a value, so a failure's text is built only from that already-scrubbed reply.
// A reply that itself carries a key (`invocation.reply_holds_values: [{ from: "<field path in the reply>",
// keep_as_field }]`, DATA on the tool's row) has each such value kept in the box through `keep`, under the name of
// that field of the tool's connection, and "[held value]" in its place; nothing is sent when there is no `keep`.
// A tool for a place that takes what is sent and answers in no set shape (a webhook, a chat message) says so in DATA:
// `report_answer: true` returns { status, said, answer } (what the place answered, in words), `answer_ok_field: "ok"`
// refuses a 2xx reply whose field is false with the reply's own `error` (the web APIs that answer 200 and say no inside),
// and `follow_redirects: false` sends nothing on to an address the first one points at (a posted body stays where it was sent).
const replyText = body => (body === undefined || body === null ? '' : typeof body === 'string' ? body : new TextDecoder().decode(body instanceof Uint8Array ? body : Uint8Array.from(body)));
async function keepHeldReplyValues(value, invocation, keep) {
  for (const { from, keep_as_field: field } of invocation.reply_holds_values) {
    const parts = String(from).split('.');
    const parent = parts.slice(0, -1).reduce((at, part) => (object(at) ? at[part] : undefined), value);
    const last = parts.at(-1);
    if (!object(parent) || parent[last] === undefined || parent[last] === null || parent[last] === '') continue;
    await keep(connectionFieldName(invocation.connection_id, field), String(parent[last]));
    parent[last] = HELD;
  }
  return value;
}
/** A request's address with its `query` leaves (already filled) added as its query string. */
export function addressWithQuery(url, query) {
  if (!object(query) || !Object.keys(query).length) return url;
  const address = new URL(url);
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) address.searchParams.append(name, object(item) ? JSON.stringify(item) : String(item));
  }
  return address.href;
}
// Cursor APIs sometimes put an access token in paging URLs. Tools declaring reply_cursor_paging keep opaque
// cursors and continuation flags instead. No returned paging URL can be persisted, disclosed or followed later.
export function cursorPagingReply(value) {
  if (Array.isArray(value)) return value.map(cursorPagingReply);
  if (!object(value)) return value;
  const safe = Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key !== 'paging' || !object(item)) return [key, cursorPagingReply(item)];
    const { next, previous, ...rest } = item;
    return [key, { ...cursorPagingReply(rest), has_next: typeof next === 'string' && next.length > 0,
      has_previous: typeof previous === 'string' && previous.length > 0 }];
  }));
  if (Array.isArray(safe.data) && !object(safe.paging)) safe.paging = { has_next: false, has_previous: false };
  return safe;
}
export async function httpJson({ invocation: given, send, keep }, request = fetch) {
  const invocation = given.query === undefined ? given : { ...given, url: addressWithQuery(given.url, given.query) };
  const keepsReplyValues = Array.isArray(invocation.reply_holds_values) && invocation.reply_holds_values.length > 0;
  if (keepsReplyValues && !(keep && nonempty(invocation.connection_id))) throw notSent('This tool\'s reply carries a key, and there is no connection here to keep it in, so it was not sent.');
  const encoded = encodeBody(invocation.body !== undefined ? invocation.body : invocation.body_template, invocation.body_encoding ?? 'json');
  const named = Object.keys(invocation.headers ?? {}).some(name => name.toLowerCase() === 'content-type');
  const headers = { ...(encoded && !named ? { 'content-type': encoded.content_type } : {}), ...(invocation.headers ?? {}) };
  const method = invocation.method ?? 'POST';
  const timeout_ms = Number(invocation.timeout_ms) || (Number(invocation.timeout_seconds) || 300) * 1000;
  const injections = invocation.credential_injections ?? [];
  let status;
  let text;
  // A tool reaches only public sites (parts/http-client/do-work/public-address.mjs), and every redirect it is sent is
  // judged again. A send with a connection also goes only to that connection's own hosts over https, which the box checks.
  try { publicAddress(invocation.url, { schemes: ['https:', 'http:'] }); } catch (error) { if (error instanceof NotPublicAddress) throw notSent(`This tool's address cannot be used: ${error.message}`); throw error; }
  if (injections.length) {
    if (!send) throw notSent('This service holds no connections, so a tool that uses one cannot run here.');
    const reply = await send({ url: invocation.url, method, headers, ...(encoded ? { body: bodyBytes(encoded) } : {}), credential_injections: injections, timeout_ms });
    status = reply.status_code;
    text = replyText(reply.body);
  } else {
    let response;
    const sent = { method, headers, ...(encoded ? { body: bodyBytes(encoded) } : {}), signal: AbortSignal.timeout(timeout_ms) };
    try { response = invocation.follow_redirects === false ? await request(publicAddress(invocation.url, { schemes: ['https:', 'http:'] }), { ...sent, redirect: 'manual' }) : await fetchPublic(invocation.url, sent, { fetchImpl: request, schemes: ['https:', 'http:'] }); }
    catch (error) { if (error instanceof NotPublicAddress) throw notSent(`This tool's address cannot be used: ${error.message}`); throw error; }
    status = response.status;
    text = await response.text();
  }
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  if (!(status >= 200 && status < 300)) throw Object.assign(new Error(`The tool answered ${status}: ${(typeof value?.error === 'string' ? value.error : text).slice(0, 300)}`), { service_answered: status });
  if (typeof invocation.answer_ok_field === 'string' && object(value) && value[invocation.answer_ok_field] === false) {
    throw Object.assign(new Error(`${new URL(invocation.url).host} did not take it: ${String(value.error ?? 'no reason given').slice(0, 300)}`), { service_answered: status });
  }
  if (invocation.report_answer === true) {
    const answer = typeof value === 'string' ? value : JSON.stringify(value);
    return { status, said: `${new URL(invocation.url).host} answered ${status}.`, ...(answer ? { answer: answer.slice(0, 500) } : {}) };
  }
  const safe = invocation.reply_cursor_paging === true ? cursorPagingReply(value) : value;
  return keepsReplyValues ? keepHeldReplyValues(safe, invocation, keep) : safe;
}

// One placement capability that runs several invoke kinds (an isolated container runs frozen tools and the
// repository explorer alike) dispatches on the tool's own `invoke.kind`.
export const byInvokeKind = map => args => {
  const run = map[args.invocation.kind];
  if (!run) throw new Error(`This placement cannot run a tool invoked as "${args.invocation.kind}".`);
  return run(args);
};

// A decision's `execute` step runs through the Workshop: operation is the tool id, key is the request key.
export const executeThroughWorkshop = workshop => async ({ action }) => {
  const task = await workshop.run({ tool_id: action.operation, input: action.input, request_key: action.key, ...(action.execution ? { execution: action.execution } : {}), ...(action.for_handoff ? { for_handoff: action.for_handoff } : {}) });
  return { ref: `task:${task.task_id}`, status: task.state, task_id: task.task_id, ...(task.execution_ref ? { execution_ref: task.execution_ref } : {}), ...(task.source_capture ? { source_capture: task.source_capture } : {}), ...(task.binding ? { binding: task.binding } : {}), ...(task.effect ? { effect: task.effect } : {}), ...(task.output !== undefined ? { output: task.output } : {}), ...(task.error ? { error: task.error } : {}) };
};

export const isWorkshopPath = pathname => pathname.startsWith('/tools/') || pathname.startsWith('/tasks/');
export { readToolData };

// Required current native-owner API; existing owner behavior is retained.
