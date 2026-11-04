// packages/ai-tool-catalog/read-data/read-ai-tool-catalog.ts
//
// The one decoder for tool DATA: `ai-tool-descriptor` rows, the places a tool can
// run (`tool-placement`), the licence classes that decide which places a tool
// may use (`tool-licence-class`), the rules that start a new exploration when a
// tool's outcomes drop (`tool-outcome-notice`), and per-call prices (`tool-price`). Every reader of these rows, the in-app catalog
// and the hosted job endpoint alike, goes through this file.
//
// Invariants:
// - A field this file does not name never reaches a caller.
// - A row that carries a secret VALUE is refused whole. Secrets are named
//   (`secret_name`, `secret_names`), never held; the value is injected by the
//   credential owner at request time.
// - A `bytes_fingerprint` is a BLAKE3 identity (`1f:` + 64 lowercase hex). Any
//   other fingerprint refuses the row, because a tool's bytes are fetched and
//   deduplicated by that identity.
// - Refusals carry a reason that says which field to change.
import { validatedDeclaredSelector, type DeclaredSelector } from '../../ui/read-data/declared-selector.ts';
import { declaredEffectsProblem, type DeclaredEffect } from './declared-effects.ts';

export type PublishedRecord = {
  payload?: unknown;
};

export type ToolInvocation = { kind: string } & Record<string, unknown>;

export type ToolCatalogItem = {
  description?: string;
  handler_ref?: string;
  permission_capability_ref?: string;
  id: string;
  input_schema?: unknown;
  label?: string;
  output_schema?: unknown;
  status?: string;
  fixed_input?: Record<string, unknown>;
  trusted_context?: Record<string, unknown>;
  result_selector?: ValidatedSelector;
  surface_selector?: ValidatedSelector;
  cancellation_capability_ref?: CanonicalCapabilityRef;
  /** The job in plain words, what a caller asks for. */
  job?: string;
  /** What the tool does and what it cannot do, each a short plain line its maker wrote (TOOL_LINES), shown with the tool
   *  to people and AIs so the one choosing reads its limits before running it. */
  can_do?: string[];
  cannot_do?: string[];
  /** BLAKE3 identity of the tool's frozen bytes. */
  bytes_fingerprint?: string;
  /** The oldest Trillion it runs on (src/tool-releases.mjs). */
  minimum_host_version?: string;
  /** What a run changes on the screens that show it (declared-effects.ts), one list every runner reads. */
  effects?: DeclaredEffect[];
  /** How a JSON call becomes the tool's own invocation; `kind` selects the runner's capability. */
  invoke?: ToolInvocation;
  /** What a run needs: durations, memory, egress, and secret NAMES only. */
  needs?: Record<string, unknown>;
  licence_class?: string;
  /** Placement ids, in the order the tool prefers them. */
  placements?: string[];
  maker?: string;
  /** When the tool was first offered (ISO time): a list can hold what is new by it (apply-list-rules.ts). */
  listed_on?: string;
  price_ref?: string;
  /** Maker's explicit choice to display this tool's name and job on the public website. */
  show_on_public_site?: boolean;
  /** A bounded visitor-run permission. Its runtime eligibility is checked by the public-app owner. */
  public_run?: { runs_per_day: number; max_input_bytes?: number };
  /** How to tell the job was done, beyond the output's shape: each check has a `kind` the runner knows
   * (`output-contains`, `output-contains-input`, `sample-run`). */
  verify?: Array<{ kind: string } & Record<string, unknown>>;
  /** True when a successful run's output is itself a tool (`{ descriptor }`) to keep for the caller. */
  result_saved_as_tool?: boolean;
  /** True when a run leaves nothing behind (no task, input or output kept): an ambient effect sent many times a
   *  minute, such as a light following the sound (src/workshop.mjs sendQuietly). Honoured only for a shared web row. */
  runs_quietly?: boolean;
  /** True when the run only reads (a screen's answer, the work tree, what waits on the person): it is answered at once
   *  and kept as no task, no execution and no pool run, and it arms the scheduler only if it wrote something anyway
   *  (src/workshop.mjs readOnce). Honoured only for a shared row, run now, with no price and no one's key. */
  read_only?: boolean;
  /** What a completed run keeps in the person's own records: each record `output_selector` finds (one object or a
   *  list), typed and named by its own `type_field` and `id_field`. Honoured for a row the service ships. */
  keeps_records?: { output_selector: DeclaredSelector; type_field: string; id_field: string }[];
  /** A read-only provider response's identity and observed content. The runtime additionally requires a captured
   * authorized dispatch on the original connection; this declaration alone is not proof. */
  observes?: { fields: Record<string, { from: 'output'; path: DeclaredSelector } | { value: string }> };
  /** Where the bytes came from: a repository and commit, an export, an upload. */
  provenance?: Record<string, unknown>;
  /** The tool's own screen for a person (src/workspace/tool-screen.tsx): { kind, label?, icon?, ... }. */
  screen?: Record<string, unknown>;
  controls?: Record<string, unknown>;
  /** Who may pay for a call, in order (`payers`), and what it costs: a `gateway` row id whose account pays, the
   * source's quoted `price_micros` per `per`, a `markup`, or the maker's own billing page. Names only, never values. */
  billing?: Record<string, unknown>;
  /** Optional per-account limits applied before a tool run starts. Both counters reset at the start of each UTC day. */
  use_limits?: { runs_per_day?: number; failures_per_day?: number };
  /** Running it again is safe: a run a rule started that fails is started again by itself, at most `max_attempts`
   * times, waiting `first_after_seconds`, then `factor` times longer each time up to `longest_after_seconds`. */
  retry?: { max_attempts: number; first_after_seconds?: number; factor?: number; longest_after_seconds?: number };
  /** The jobs this tool does, by name (src/job-slots.mjs): code that needs a job asks for the tools serving it. */
  serves?: string[];
  /** For a tool serving `encode`: the space its vectors live in, the kinds of question it accepts, and the pieces it
   *  reads to make passage vectors (src/search.mjs). */
  encodes?: ToolEncodes;
};

/** A piece source an encoder reads: the pieces of a kept result kind (each piece's text at `text_field`, its times at
 *  `time_fields`), or the files of `media_types` themselves, handed to the tool by identity. `place` is where a match is. */
export type EncoderRead =
  | { result_kind: string; place: string; pieces_path: string; text_field: string; time_fields?: { start?: string; end?: string } }
  | { media_types: string[]; place: string };
export type ToolEncodes = {
  accepts: string[];
  space: { model: string; revision?: string; dim: number; query_prompt?: string; passage_prompt?: string };
  reads: EncoderRead[];
};

export type ToolPlacement = {
  id: string;
  label: string;
  /** The runner capability that carries work to this place. */
  executor: string;
  /** Hosts that can reach this place. Every shared placement is reachable from `hosted`, the deployed service. */
  reachable_from: string[];
  vendor?: string;
  billing?: string;
  idle_cost_usd_per_month?: number;
  settings?: Record<string, unknown>;
};

export type ToolLicenceClass = {
  id: string;
  label: string;
  /** SPDX ids and licence names this class covers. */
  licences: string[];
  allowed_placements: string[];
  serve_source_link: boolean;
  store_bytes: boolean;
};

export type Refusal = { id: string | null; kind: string; reason: string };
export type ValidatedSelector = DeclaredSelector;
export type CanonicalCapabilityRef = { canonicalAddress: string; canonicalRevision: string; payloadHash: string };

// The encoder declaration, admitted whole or refused with the field named; nothing in it names a model or a kind.
function admitEncodes(value: unknown): { encodes: ToolEncodes } | { refused: string } {
  if (!isRecord(value)) return { refused: 'encodes must be an object { accepts, space, reads }' };
  const accepts = texts(value.accepts);
  if (!accepts) return { refused: 'encodes.accepts must be a non-empty list of content kinds, for example ["text"]' };
  const space = value.space;
  if (!isRecord(space) || !text(space.model) || !Number.isSafeInteger(space.dim) || Number(space.dim) < 1) return { refused: 'encodes.space must name its model and a whole-number dim above 0' };
  for (const field of ['revision', 'query_prompt', 'passage_prompt']) if (space[field] !== undefined && typeof space[field] !== 'string') return { refused: `encodes.space.${field} must be text` };
  if (Object.keys(space).some(key => !['model', 'revision', 'dim', 'query_prompt', 'passage_prompt'].includes(key))) return { refused: 'encodes.space holds only model, revision, dim, query_prompt and passage_prompt' };
  if (!Array.isArray(value.reads) || !value.reads.length) return { refused: 'encodes.reads must be a non-empty list of the pieces it reads' };
  const reads: EncoderRead[] = [];
  for (const read of value.reads) {
    if (!isRecord(read) || !text(read.place)) return { refused: 'each encodes.reads row must name its place' };
    const times = read.time_fields;
    if (times !== undefined && !(isRecord(times) && Object.entries(times).every(([key, field]) => ['start', 'end'].includes(key) && text(field)))) return { refused: 'encodes.reads time_fields holds only start and end, each a field name' };
    if (text(read.result_kind) && text(read.pieces_path) && text(read.text_field)) reads.push({ result_kind: read.result_kind as string, place: read.place as string, pieces_path: read.pieces_path as string, text_field: read.text_field as string, ...(times ? { time_fields: times as { start?: string; end?: string } } : {}) });
    else if (texts(read.media_types)) reads.push({ media_types: read.media_types as string[], place: read.place as string });
    else return { refused: 'each encodes.reads row is { result_kind, place, pieces_path, text_field } or { media_types, place }' };
  }
  return { encodes: { accepts, space: { model: space.model as string, dim: Number(space.dim), ...(['revision', 'query_prompt', 'passage_prompt'] as const).reduce((kept, field) => (typeof space[field] === 'string' ? { ...kept, [field]: space[field] } : kept), {}) }, reads } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function texts(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((item) => text(item)) ? value as string[] : undefined;
}

/** The selector grammar is deliberately small and total: root plus named object
 * members. It cannot execute expressions, scan output, or enter prototype keys. */
export const validatedSelector = validatedDeclaredSelector;
export function canonicalCapabilityRef(value: unknown): CanonicalCapabilityRef | undefined {
  if (!isRecord(value)) return undefined;
  const canonicalAddress = text(value.canonical_address ?? value.canonicalAddress);
  const canonicalRevision = text(value.canonical_revision ?? value.canonicalRevision);
  const payloadHash = text(value.payload_hash ?? value.payloadHash);
  return canonicalAddress && canonicalRevision && payloadHash ? { canonicalAddress, canonicalRevision, payloadHash } : undefined;
}

/** The reachability every shared placement must have: the deployed service. */
export const DEPLOYED_HOST = 'hosted';

/** BLAKE3-256 identity in the engine's code:hex form. */
export const BLAKE3_FINGERPRINT = /^1f:[0-9a-f]{64}$/;
/** The oldest Trillion a tool runs on (server.json `version`): numbers joined by dots (src/tool-releases.mjs chooses a release by it). */
export const MINIMUM_HOST_VERSION = /^\d{1,9}(?:\.\d{1,9}){0,3}$/;

// A field NAME that says it holds a credential. A name or a reference to one is
// allowed; the value itself is not.
const SECRET_FIELD = /(secret|password|passphrase|token|api[_-]?key|private[_-]?key|credential|authorization)/i;
// A field ending in _url holds an address (an OAuth `token_url`), which names where a secret is exchanged, not the
// secret; a credential written inside an address is still caught by SECRET_VALUE or the field that carries it.
const NAMES_A_SECRET = /(_name|_names|_ref|_refs|_id|_ids|_url|_urls)$/i;
// Values whose shape is a credential by protocol, whatever field holds them.
const SECRET_VALUE = /^\s*(bearer\s+\S{8,}|basic\s+\S{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

/** The first place a secret value appears in `value`, as a field path, or null. */
export function secretValuePath(value: unknown, path: string[] = []): string | null {
  if (typeof value === 'string') return SECRET_VALUE.test(value) ? path.join('.') || '(value)' : null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = secretValuePath(value[index], [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && child.trim() && SECRET_FIELD.test(key) && !NAMES_A_SECRET.test(key)) return [...path, key].join('.');
    const found = secretValuePath(child, [...path, key]);
    if (found) return found;
  }
  return null;
}

/** How many `can_do` / `cannot_do` lines a tool may carry and how long each may be, so twenty tools' lines stay a
 *  bounded part of one find_tool_for_job answer. */
export const TOOL_LINES = { most: 8, longest: 160 } as const;
const TOOL_LINE_FIELDS = ['can_do', 'cannot_do'] as const;

/** The lines of one `can_do` / `cannot_do` value, trimmed, or null when it is not 1 to TOOL_LINES.most different
 *  plain one-line texts of at most TOOL_LINES.longest characters. */
function toolLines(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > TOOL_LINES.most) return null;
  const lines = value.map(line => (typeof line === 'string' ? line.trim() : ''));
  const plain = lines.every(line => line !== '' && line.length <= TOOL_LINES.longest && !/[\u0000-\u001f\u007f]/.test(line));
  return plain && new Set(lines.map(line => line.toLowerCase())).size === lines.length ? lines : null;
}

/** What is wrong with a descriptor's `can_do` / `cannot_do`, one line per field, for a save to list with its other
 *  problems. */
export function toolLineProblems(payload: Record<string, unknown>): string[] {
  return TOOL_LINE_FIELDS.filter(field => payload[field] !== undefined && !toolLines(payload[field])).map(field =>
    `${field} must be a list of 1 to ${TOOL_LINES.most} different short plain lines, one line each and at most ${TOOL_LINES.longest} characters, saying what the tool ${field === 'can_do' ? 'does' : 'cannot do'}`);
}

/** Admit one `ai-tool-descriptor` payload, or say exactly why it is refused. A `can_do` / `cannot_do` that is not
 *  well formed is left out rather than refusing the tool: a save refuses it first (toolLineProblems), and a tool kept
 *  before these fields were checked stays usable. */
export function admitToolDescriptor(payload: unknown): { item: ToolCatalogItem } | { refused: Refusal } {
  const refuse = (id: string | null, reason: string) => ({ refused: { id, kind: 'ai-tool-descriptor', reason } });
  if (!isRecord(payload) || payload.kind !== 'ai-tool-descriptor') return refuse(null, 'kind must be "ai-tool-descriptor"');
  const id = text(payload.id);
  if (!id) return refuse(null, 'id must be a non-empty string');
  const secret = secretValuePath(payload);
  if (secret) return refuse(id, `${secret} holds a secret value; name the secret with secret_name and let the credential owner inject it`);
  if (payload.bytes_fingerprint !== undefined && !(typeof payload.bytes_fingerprint === 'string' && BLAKE3_FINGERPRINT.test(payload.bytes_fingerprint))) {
    return refuse(id, 'bytes_fingerprint must be a BLAKE3 identity: "1f:" followed by 64 lowercase hex characters');
  }
  if (payload.invoke !== undefined && !(isRecord(payload.invoke) && text(payload.invoke.kind))) return refuse(id, 'invoke must be an object with a kind');
  if (payload.placements !== undefined && !texts(payload.placements)) return refuse(id, 'placements must be a non-empty list of placement ids');
  if (payload.show_on_public_site !== undefined && typeof payload.show_on_public_site !== 'boolean') return refuse(id, 'show_on_public_site must be true or false');
  const publicRun = payload.public_run;
  if (publicRun !== undefined && (!isRecord(publicRun) || !Number.isSafeInteger(publicRun.runs_per_day) || Number(publicRun.runs_per_day) < 1 || Number(publicRun.runs_per_day) > 100
    || Object.keys(publicRun).some(key => key !== 'runs_per_day' && key !== 'max_input_bytes')
    || (publicRun.max_input_bytes !== undefined && (!Number.isSafeInteger(publicRun.max_input_bytes) || Number(publicRun.max_input_bytes) < 1 || Number(publicRun.max_input_bytes) > 16384)))) {
    return refuse(id, 'public_run must name runs_per_day from 1 to 100 and optional max_input_bytes from 1 to 16384');
  }
  for (const field of ['needs', 'provenance'] as const) {
    if (payload[field] !== undefined && !isRecord(payload[field])) return refuse(id, `${field} must be an object`);
  }
  if (payload.verify !== undefined && !(Array.isArray(payload.verify) && payload.verify.length > 0 && payload.verify.every((check) => isRecord(check) && text(check.kind)))) {
    return refuse(id, 'verify must be a non-empty list of checks, each with a kind');
  }
  if (payload.keeps_records !== undefined && !(Array.isArray(payload.keeps_records) && payload.keeps_records.every((rule) => isRecord(rule) && validatedSelector(rule.output_selector) && text(rule.type_field) && text(rule.id_field)))) {
    return refuse(id, 'keeps_records must be a list of { output_selector, type_field, id_field }');
  }
  if (payload.observes !== undefined && (!isRecord(payload.observes) || !isRecord(payload.observes.fields)
    || Object.entries(payload.observes.fields).some(([field, spec]) => !isRecord(spec)
      || !(spec.from === 'output' && validatedSelector(spec.path) || ['provider', 'route'].includes(field) && text(spec.value))))) {
    return refuse(id, 'observes.fields must select actual output values; only provider and route may be declared constants');
  }
  const limits = payload.use_limits;
  if (limits !== undefined && (!isRecord(limits) || !Object.keys(limits).length || Object.keys(limits).some(key => !['runs_per_day', 'failures_per_day'].includes(key)) || Object.values(limits).some(value => !Number.isSafeInteger(value) || Number(value) < 1))) {
    return refuse(id, 'use_limits must name positive integer runs_per_day or failures_per_day');
  }
  const retry = payload.retry;
  const RETRY_FIELDS = ['max_attempts', 'first_after_seconds', 'factor', 'longest_after_seconds'];
  if (retry !== undefined && (!isRecord(retry) || !Number.isSafeInteger(retry.max_attempts) || Number(retry.max_attempts) < 1
    || Object.keys(retry).some(key => !RETRY_FIELDS.includes(key)) || Object.values(retry).some(value => typeof value !== 'number' || !(value > 0)))) {
    return refuse(id, 'retry must be { max_attempts (a whole number), first_after_seconds, factor, longest_after_seconds }, each above 0');
  }
  if (payload.serves !== undefined && !texts(payload.serves)) return refuse(id, 'serves must be a non-empty list of job names');
  if (payload.minimum_host_version !== undefined && !(typeof payload.minimum_host_version === 'string' && MINIMUM_HOST_VERSION.test(payload.minimum_host_version))) {
    return refuse(id, 'minimum_host_version must be a version such as 2026.9.28: numbers joined by dots');
  }
  const effectsProblem = declaredEffectsProblem(payload.effects);
  if (effectsProblem) return refuse(id, effectsProblem);
  const encodes = payload.encodes === undefined ? undefined : admitEncodes(payload.encodes);
  if (encodes && 'refused' in encodes) return refuse(id, encodes.refused);
  if (encodes && !(payload.serves as string[] | undefined)?.includes('encode')) return refuse(id, 'a tool that declares encodes must serve "encode"');
  const needs = isRecord(payload.needs) ? payload.needs : undefined;
  if (needs?.secret_names !== undefined && !texts(needs.secret_names)) return refuse(id, 'needs.secret_names must be a list of secret names');
  const optionalText = (field: string) => {
    const value = text(payload[field]);
    return value ? { [field]: value } : {};
  };
  const fixedInput = isRecord(payload.fixed_input) ? payload.fixed_input : undefined;
  const trustedContext = isRecord(payload.trusted_context) ? payload.trusted_context : undefined;
  const resultSelector = validatedSelector(payload.result_selector);
  const surfaceSelector = validatedSelector(payload.surface_selector);
  const cancellation = canonicalCapabilityRef(payload.cancellation_capability_ref);
  return {
    item: {
      ...optionalText('description'),
      ...optionalText('handler_ref'),
      ...optionalText('permission_capability_ref'),
      id,
      input_schema: payload.input_schema,
      ...optionalText('label'),
      output_schema: payload.output_schema,
      ...optionalText('status'),
      ...(fixedInput ? { fixed_input: fixedInput } : {}),
      ...(trustedContext ? { trusted_context: trustedContext } : {}),
      ...(resultSelector ? { result_selector: resultSelector } : {}),
      ...(surfaceSelector ? { surface_selector: surfaceSelector } : {}),
      ...(cancellation ? { cancellation_capability_ref: cancellation } : {}),
      ...optionalText('job'),
      ...Object.fromEntries(TOOL_LINE_FIELDS.flatMap(field => { const lines = toolLines(payload[field]); return lines ? [[field, lines]] : []; })),
      ...optionalText('bytes_fingerprint'),
      ...optionalText('minimum_host_version'),
      ...(Array.isArray(payload.effects) ? { effects: payload.effects as DeclaredEffect[] } : {}),
      ...(isRecord(payload.invoke) ? { invoke: payload.invoke as ToolInvocation } : {}),
      ...(needs ? { needs } : {}),
      ...optionalText('licence_class'),
      ...(texts(payload.placements) ? { placements: payload.placements as string[] } : {}),
      ...optionalText('maker'),
      ...optionalText('listed_on'),
      ...optionalText('price_ref'),
      ...(payload.show_on_public_site === true ? { show_on_public_site: true } : {}),
      ...(publicRun ? { public_run: { runs_per_day: Number(publicRun.runs_per_day), ...(publicRun.max_input_bytes === undefined ? {} : { max_input_bytes: Number(publicRun.max_input_bytes) }) } } : {}),
      ...(payload.result_saved_as_tool === true ? { result_saved_as_tool: true } : {}),
      ...(payload.runs_quietly === true ? { runs_quietly: true } : {}),
      ...(payload.read_only === true ? { read_only: true } : {}),
      ...(Array.isArray(payload.keeps_records) ? { keeps_records: payload.keeps_records as ToolCatalogItem['keeps_records'] } : {}),
      ...(isRecord(payload.observes) ? { observes: payload.observes as ToolCatalogItem['observes'] } : {}),
      ...(Array.isArray(payload.verify) ? { verify: payload.verify as ToolCatalogItem['verify'] } : {}),
      ...(isRecord(payload.provenance) ? { provenance: payload.provenance } : {}),
      ...(isRecord(payload.screen) && text(payload.screen.kind) ? { screen: payload.screen } : {}),
      // What a person adjusts by hand, in plain words, and how its result previews (src/made-controls.mjs).
      ...(isRecord(payload.controls) ? { controls: payload.controls } : {}),
      ...(isRecord(payload.billing) ? { billing: payload.billing } : {}),
      ...(limits ? { use_limits: limits as ToolCatalogItem['use_limits'] } : {}),
      ...(retry ? { retry: retry as ToolCatalogItem['retry'] } : {}),
      ...(texts(payload.serves) ? { serves: payload.serves as string[] } : {}),
      ...(encodes && 'encodes' in encodes ? { encodes: encodes.encodes } : {}),
    },
  };
}

function admitPlacement(payload: Record<string, unknown>): { item: ToolPlacement } | { refused: Refusal } {
  const id = text(payload.id) ?? null;
  const refuse = (reason: string) => ({ refused: { id, kind: 'tool-placement', reason } });
  const secret = secretValuePath(payload);
  if (secret) return refuse(`${secret} holds a secret value; name the secret instead`);
  const label = text(payload.label);
  const executor = text(payload.executor);
  const reachable = texts(payload.reachable_from);
  if (!id || !label || !executor || !reachable) return refuse('a placement needs id, label, executor and reachable_from');
  // Tools run where they are deployed or in the caller's own sandbox, never on one person's machine: a shared
  // placement must be reachable from the deployed service and must not be a single physical machine.
  if (!reachable.includes(DEPLOYED_HOST)) return refuse(`reachable_from must include "${DEPLOYED_HOST}": a shared placement runs where the service is deployed`);
  if (payload.singular !== undefined || payload.waiting_label !== undefined) return refuse('singular and waiting_label name one physical machine; a shared placement is never one machine');
  return {
    item: {
      id, label, executor, reachable_from: reachable,
      ...(text(payload.vendor) ? { vendor: payload.vendor as string } : {}),
      ...(text(payload.billing) ? { billing: payload.billing as string } : {}),
      ...(typeof payload.idle_cost_usd_per_month === 'number' ? { idle_cost_usd_per_month: payload.idle_cost_usd_per_month } : {}),
      ...(isRecord(payload.settings) ? { settings: payload.settings } : {}),
    },
  };
}

function admitLicenceClass(payload: Record<string, unknown>): { item: ToolLicenceClass } | { refused: Refusal } {
  const id = text(payload.id) ?? null;
  const label = text(payload.label);
  const licences = texts(payload.licences);
  const allowed = Array.isArray(payload.allowed_placements) && payload.allowed_placements.every((item) => text(item)) ? payload.allowed_placements as string[] : undefined;
  if (!id || !label || !licences || !allowed) return { refused: { id, kind: 'tool-licence-class', reason: 'a licence class needs id, label, licences and allowed_placements' } };
  return { item: { id, label, licences, allowed_placements: allowed, serve_source_link: payload.serve_source_link === true, store_bytes: payload.store_bytes === true } };
}

export type ToolOutcomeNotice = {
  id: string;
  /** Runs that must exist before the rule looks at the rate. */
  min_runs: number;
  /** The share of runs whose output met the contract, below which the rule fires. */
  pass_rate_below: number;
  /** The tool started when it fires, and its input: `{ fill: { from: 'tool' | 'last_input', field } }` values. */
  then: { tool_id: string; input: Record<string, unknown> };
};

/** A per-call price; `access_ref` names the access a caller must hold to run the tool (granted by any offer whose
 * `access_refs` lists it, so several priced offers can open one tool). */
export type ToolPrice = { id: string; label: string; amount_micros: number; currency: string; per: string; access_ref?: string };

function admitNotice(payload: Record<string, unknown>): { item: ToolOutcomeNotice } | { refused: Refusal } {
  const id = text(payload.id) ?? null;
  const when = isRecord(payload.when) ? payload.when : {};
  const then = isRecord(payload.then) ? payload.then : {};
  const minRuns = Number(when.min_runs);
  const below = Number(when.pass_rate_below);
  if (!id || !Number.isInteger(minRuns) || minRuns < 1 || !(below > 0 && below <= 1) || !text(then.tool_id) || !isRecord(then.input)) {
    return { refused: { id, kind: 'tool-outcome-notice', reason: 'a notice needs id, when.min_runs (whole number from 1), when.pass_rate_below (above 0, at most 1), then.tool_id and then.input' } };
  }
  return { item: { id, min_runs: minRuns, pass_rate_below: below, then: { tool_id: then.tool_id as string, input: then.input } } };
}

function admitPrice(payload: Record<string, unknown>): { item: ToolPrice } | { refused: Refusal } {
  const id = text(payload.id) ?? null;
  const label = text(payload.label);
  const currency = text(payload.currency);
  const per = text(payload.per);
  if (!id || !label || !currency || !per || !Number.isSafeInteger(payload.amount_micros) || (payload.amount_micros as number) < 0) {
    return { refused: { id, kind: 'tool-price', reason: 'a price needs id, label, amount_micros (whole millionths of the currency unit), currency and per' } };
  }
  return { item: { id, label, amount_micros: payload.amount_micros as number, currency, per, ...(text(payload.access_ref) ? { access_ref: payload.access_ref as string } : {}) } };
}

/** Where a kept tool's files are stored, by their BLAKE3 identity. The deploy binds the first store (lowest
 * `rank`) the account can use; `interface` names the storage shape the service reads and writes through. */
export type ToolByteStore = { id: string; label: string; interface: string; rank: number; vendor?: string; settings?: Record<string, unknown> };

function admitByteStore(payload: Record<string, unknown>): { item: ToolByteStore } | { refused: Refusal } {
  const id = text(payload.id) ?? null;
  const label = text(payload.label);
  const shape = text(payload.interface);
  if (!id || !label || !shape || !Number.isInteger(payload.rank)) {
    return { refused: { id, kind: 'tool-byte-store', reason: 'a byte store needs id, label, interface and a whole-number rank' } };
  }
  return {
    item: {
      id, label, interface: shape, rank: payload.rank as number,
      ...(text(payload.vendor) ? { vendor: payload.vendor as string } : {}),
      ...(isRecord(payload.settings) ? { settings: payload.settings } : {}),
    },
  };
}

/** A platform's own account at a tool gateway: which secret NAME the account's key is kept under and where it is
 * placed, the only hosts it may be sent to, a per-call tag naming the person, the markup, and whether the gateway's
 * terms allow calls on behalf of the platform's customers (`resale.allowed`, read from the terms with a date). */
export type ToolGateway = { id: string; label: string; allowed_hosts: string[]; credential: { secret_name: string; placement: Record<string, unknown> }; meta?: Record<string, unknown>; markup: { percent: number }; resale: { allowed: boolean } & Record<string, unknown>; settings?: Record<string, unknown> };

function admitGateway(payload: Record<string, unknown>): { item: ToolGateway } | { refused: Refusal } {
  const id = text(payload.id) ?? null;
  const refuse = (reason: string) => ({ refused: { id, kind: 'tool-gateway', reason } });
  const secret = secretValuePath(payload);
  if (secret) return refuse(`${secret} holds a secret value; name the secret instead`);
  const label = text(payload.label);
  const hosts = texts(payload.allowed_hosts);
  const credential = isRecord(payload.credential) ? payload.credential : null;
  const markup = isRecord(payload.markup) ? Number(payload.markup.percent) : NaN;
  const resale = isRecord(payload.resale) ? payload.resale : null;
  if (!id || !label || !hosts || !credential || !text(credential.secret_name) || !isRecord(credential.placement) || !(markup >= 0) || !resale || typeof resale.allowed !== 'boolean') {
    return refuse('a gateway needs id, label, allowed_hosts, credential { secret_name, placement }, markup { percent } and resale { allowed, source }');
  }
  return {
    item: {
      id, label, allowed_hosts: hosts, credential: { secret_name: credential.secret_name as string, placement: credential.placement as Record<string, unknown> },
      ...(isRecord(payload.meta) ? { meta: payload.meta } : {}), markup: { percent: markup }, resale: resale as ToolGateway['resale'],
      ...(isRecord(payload.settings) ? { settings: payload.settings } : {}),
    },
  };
}

/** A registry read at find time, never copied in: `search` is the request that finds tools for a job, `get` the one
 * that reads one tool by its id, `entry` renames each result's fields, `price` names where a result's quoted price is,
 * and `row` is the tool row each result fills. */
/** Where a field sits in a registry's answer: its name, or the steps to it (names and list positions) when it is nested. */
export type FieldPath = string | readonly (string | number)[];
/** `finds` names what the registry lists (tools when absent; a catalog of tool servers says so), so each reader asks
 *  only the registries that list what it is looking for. `connector` is how a listed tool server is connected. */
export type ToolSearchSource = { id: string; label: string; search: Record<string, unknown>; get?: Record<string, unknown>; entry: Record<string, FieldPath>; id_prefix: string; row: Record<string, unknown>; input_dialect?: Record<string, unknown>; price?: Record<string, unknown>; gateway?: string; surface?: 'alongside'; finds?: string; connector?: Record<string, unknown> };

const isFieldPath = (value: unknown): value is FieldPath => Boolean(text(value)) || (Array.isArray(value) && value.length > 0 && value.every((step) => Boolean(text(step)) || (Number.isInteger(step) && (step as number) >= 0)));

function admitSearchSource(payload: Record<string, unknown>): { item: ToolSearchSource } | { refused: Refusal } {
  const id = text(payload.id) ?? null;
  const refuse = (reason: string) => ({ refused: { id, kind: 'tool-search-source', reason } });
  const secret = secretValuePath(payload);
  if (secret) return refuse(`${secret} holds a secret value; name the secret instead`);
  const label = text(payload.label);
  const search = isRecord(payload.search) ? payload.search : null;
  const entry = isRecord(payload.entry) && Object.values(payload.entry).every(isFieldPath) ? payload.entry as Record<string, FieldPath> : null;
  if (!id || !label || !search || !text(search.url) || !entry || !isFieldPath(entry.id) || !text(payload.id_prefix) || !isRecord(payload.row)) {
    return refuse('a search source needs id, label, search { url, ... }, entry (field names or paths, with id), id_prefix and row');
  }
  if (payload.finds !== undefined && !text(payload.finds)) return refuse('finds must name what the registry lists');
  if (payload.connector !== undefined && !isRecord(payload.connector)) return refuse('connector must be an object');
  return {
    item: {
      id, label, search, entry, id_prefix: payload.id_prefix as string, row: payload.row,
      ...(isRecord(payload.get) ? { get: payload.get } : {}),
      ...(isRecord(payload.input_dialect) ? { input_dialect: payload.input_dialect } : {}),
      ...(isRecord(payload.price) ? { price: payload.price } : {}),
      ...(text(payload.gateway) ? { gateway: payload.gateway as string } : {}),
      ...(payload.surface === 'alongside' ? { surface: 'alongside' as const } : {}),
      ...(text(payload.finds) ? { finds: payload.finds as string } : {}),
      ...(isRecord(payload.connector) ? { connector: payload.connector } : {}),
    },
  };
}

/** A list of tools read where it can be read: a `tool-row-source` whose list only a signed-in person can read (a remote
 * tool server that asks each person to sign in) travels with the shared rows, so each person's own store reads it
 * after that person signs in. `list`, `entry`, `id_prefix` and `row` are what the derivation reads. */
export type ToolRowSource = { id: string; label: string; list: Record<string, unknown>; entry: Record<string, string>; id_prefix: string; row: Record<string, unknown>; lay_over?: unknown[] };

function admitRowSource(payload: Record<string, unknown>): { item: ToolRowSource } | { refused: Refusal } {
  const id = text(payload.id) ?? null;
  const refuse = (reason: string) => ({ refused: { id, kind: 'tool-row-source', reason } });
  const secret = secretValuePath(payload);
  if (secret) return refuse(`${secret} holds a secret value; name the secret instead`);
  const entry = isRecord(payload.entry) && Object.values(payload.entry).every((value) => text(value)) ? payload.entry as Record<string, string> : null;
  if (!id || !isRecord(payload.list) || !entry || !text(entry.id) || !text(payload.id_prefix) || !isRecord(payload.row)) {
    return refuse('a row source needs id, list, entry (field names, with id), id_prefix and row');
  }
  return {
    item: {
      id, label: text(payload.label) ?? id, list: payload.list, entry, id_prefix: payload.id_prefix as string, row: payload.row,
      ...(Array.isArray(payload.lay_over) ? { lay_over: payload.lay_over } : {}),
    },
  };
}

/** Something outside that calls in when a thing happens (a comment, a message, a payment), described as DATA so the
 * service that receives it names no platform. `signature` says how the sender signs the exact bytes it sends and the
 * NAME of the secret that checks it; `handshake` how the sender confirms the address first; each `events` entry
 * which part of a delivery is one event (`each`: nested list fields walked in order, `where`: conditions,
 * `fields`: paths into the walked items); `route_key` is the field saying whose event it is, and `route_key_proof`
 * the tool that tells an account which route key is its own, so nobody can listen for someone else's events.
 * A service that keeps no address to send to has `poll` in place of `signature`: the account's own connection reads
 * what is new since a cursor (`tool_id`, every `every_minutes`; `cursor.input_field` is the tool input the cursor goes
 * in, `cursor.start` where the first one comes from, a read `{ tool_id, output_selector }` or the clock `{}`, and
 * `cursor.next` where the next one is read, `{ output_selector }` or `{ newest_of_field }`), and `detail` reads each new
 * item in full ({ tool_id, input, fields }). `event_id` is one field or several joined. A path step may be
 * `{ find: { field: value } }`: the first list item holding those values, or `{ decode: name }`: the text read so far
 * decoded the way a sender wrote it (`html-entities` for text a service sends with &#39; and &amp; in it). */
export type EventPathStep = string | number | { find: Record<string, unknown> } | { decode: string };
export type EventPath = Array<EventPathStep>;
export type EventPoll = {
  tool_id: string; every_minutes: number; input?: Record<string, unknown>; max_events?: number;
  cursor: { input_field: string; start?: { tool_id?: string; output_selector?: string }; next: { output_selector?: string; newest_of_field?: string } };
  restart_when_error_contains?: string[];
  detail?: { tool_id: string; input: Record<string, unknown>; fields: Record<string, EventPath> };
};
export type EventRouteCollection = {
  tool_id: string; input?: Record<string, unknown>; items_selector: string; id_selector: string;
  cursor: { input_field: string; output_selector: string; more_selector: string };
  children?: EventRouteCollection[];
};
export type ToolEventSource = {
  id: string; label: string;
  signature?: { header: string; prefix?: string; hmac: string; encoding: string; secret_name: string };
  poll?: EventPoll;
  handshake?: Record<string, unknown>;
  delivery_where?: Array<{ path: EventPath; equals?: unknown; not?: boolean; present?: boolean }>;
  events: Array<{ name: string; each: Array<{ field: string | EventPath; as: string }>; where?: Array<{ path: EventPath; equals?: unknown; not?: boolean; present?: boolean }>; fields: Record<string, EventPath>; required: string[]; skip_when_same?: string[][]; newer_than_cursor?: string }>;
  route_key: string; event_id: string | string[];
  route_key_proof: { tool_id?: string; output_selector?: string; collection?: EventRouteCollection };
  route_subscription?: { tool_id: string; input: Record<string, unknown>; success_selector: string; recheck_minutes: number };
  listen_tool_id?: string;
  /** Which connection this source belongs to: an account connected with this vendor gets this source's events set up
   * by itself (src/starting-rules.mjs). */
  connects_with?: { vendor: string; connection_id?: string };
  /** How fast and how late the account may answer, per event, and which failures are tried again: DATA, from the
   * sender's published limits. */
  delivery_policy?: Record<string, unknown>;
  /** How this source's default rules behave (src/starting-rules.mjs): skip lists tests on an event's fields that leave
   * it out, batch gathers events into one run per every_minutes. The rule fields src/events.mjs checks. */
  default_rule?: { skip?: Array<Record<string, unknown>>; batch?: { every_minutes: number } };
};

function admitEventSource(payload: Record<string, unknown>): { item: ToolEventSource } | { refused: Refusal } {
  const id = text(payload.id) ?? null;
  const refuse = (reason: string) => ({ refused: { id, kind: 'tool-event-source', reason } });
  const secret = secretValuePath(payload);
  if (secret) return refuse(`${secret} holds a secret value; name the secret instead`);
  const label = text(payload.label);
  const signature = isRecord(payload.signature) ? payload.signature : null;
  const proof = isRecord(payload.route_key_proof) ? payload.route_key_proof : null;
  const path = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string' || Number.isInteger(part) || (isRecord(part) && (isRecord(part.find) || text(part.decode))));
  const conditions = (value: unknown) => value === undefined || (Array.isArray(value) && value.every((item) => isRecord(item) && path(item.path)));
  const events = Array.isArray(payload.events) ? payload.events : null;
  const goodEvent = (event: unknown) => isRecord(event) && text(event.name) && Array.isArray(event.each) && event.each.length > 0
    && event.each.every((step) => isRecord(step) && (text(step.field) || path(step.field)) && text(step.as)) && conditions(event.where)
    && isRecord(event.fields) && Object.values(event.fields).every(path) && texts(event.required)
    && (texts(event.required) as string[]).every((field) => Object.hasOwn(event.fields as object, field));
  const poll = isRecord(payload.poll) ? payload.poll : null;
  const cursor = poll && isRecord(poll.cursor) ? poll.cursor : null;
  const start = cursor && isRecord(cursor.start) ? cursor.start : null;
  const next = cursor && isRecord(cursor.next) ? cursor.next : null;
  const detail = poll && isRecord(poll.detail) ? poll.detail : null;
  const goodPoll = poll && text(poll.tool_id) && typeof poll.every_minutes === 'number' && poll.every_minutes >= 1
    && cursor && text(cursor.input_field) && (start === null || start.tool_id === undefined || (text(start.tool_id) && validatedDeclaredSelector(start.output_selector)))
    && next && (validatedDeclaredSelector(next.output_selector) || text(next.newest_of_field))
    && (poll.detail === undefined || (detail && text(detail.tool_id) && isRecord(detail.input) && isRecord(detail.fields) && Object.values(detail.fields).every(path)));
  const goodSignature = signature && text(signature.header) && text(signature.hmac) && text(signature.encoding) && text(signature.secret_name);
  const collection = (value: unknown, depth = 0): boolean => isRecord(value) && depth < 4 && !!text(value.tool_id)
    && !!validatedDeclaredSelector(value.items_selector) && !!validatedDeclaredSelector(value.id_selector)
    && (value.input === undefined || isRecord(value.input)) && isRecord(value.cursor) && !!text(value.cursor.input_field)
    && !!validatedDeclaredSelector(value.cursor.output_selector) && !!validatedDeclaredSelector(value.cursor.more_selector)
    && (value.children === undefined || (Array.isArray(value.children) && value.children.length > 0 && value.children.every(child => collection(child, depth + 1))));
  const subscription = isRecord(payload.route_subscription) ? payload.route_subscription : null;
  const multiple = proof && collection(proof.collection) && goodSignature && !poll
    && subscription && text(subscription.tool_id) && isRecord(subscription.input) && validatedDeclaredSelector(subscription.success_selector)
    && typeof subscription.recheck_minutes === 'number' && subscription.recheck_minutes >= 1
    && isRecord(payload.connects_with) && text(payload.connects_with.vendor) && text(payload.connects_with.connection_id);
  const goodProof = proof && (proof.collection === undefined ? text(proof.tool_id) && validatedDeclaredSelector(proof.output_selector) : multiple);
  if (!id || !label || !(goodSignature || goodPoll) || (poll && !goodPoll) || (signature && !goodSignature)
    || !events || !events.length || !events.every(goodEvent) || !conditions(payload.delivery_where)
    || !text(payload.route_key) || !(text(payload.event_id) || texts(payload.event_id)) || !goodProof) {
    return refuse('an event source needs id, label, signature { header, hmac, encoding, secret_name } or poll { tool_id, every_minutes, cursor { input_field, next } }, events [{ name, each [{ field, as }], fields, required }], route_key, event_id and route_key_proof { tool_id, output_selector }');
  }
  return {
    item: {
      id, label, events: events as ToolEventSource['events'],
      ...(signature ? { signature: signature as ToolEventSource['signature'] } : {}),
      ...(poll ? { poll: poll as EventPoll } : {}),
      route_key: payload.route_key as string, event_id: payload.event_id as ToolEventSource['event_id'], route_key_proof: proof as ToolEventSource['route_key_proof'],
      ...(multiple ? { route_subscription: subscription as ToolEventSource['route_subscription'] } : {}),
      ...(isRecord(payload.handshake) ? { handshake: payload.handshake } : {}),
      ...(Array.isArray(payload.delivery_where) ? { delivery_where: payload.delivery_where as ToolEventSource['delivery_where'] } : {}),
      ...(text(payload.listen_tool_id) ? { listen_tool_id: payload.listen_tool_id as string } : {}),
      ...(isRecord(payload.connects_with) && text(payload.connects_with.vendor) ? { connects_with: { vendor: payload.connects_with.vendor as string, ...(text(payload.connects_with.connection_id) ? { connection_id: payload.connects_with.connection_id as string } : {}) } } : {}),
      ...(isRecord(payload.delivery_policy) ? { delivery_policy: payload.delivery_policy } : {}),
      ...(isRecord(payload.default_rule) ? { default_rule: payload.default_rule as ToolEventSource['default_rule'] } : {}),
    },
  };
}

const ADMIT: Record<string, (payload: Record<string, unknown>) => { item: unknown } | { refused: Refusal }> = {
  'tool-event-source': admitEventSource,
  'tool-outcome-notice': admitNotice,
  'tool-price': admitPrice,
  'tool-byte-store': admitByteStore,
  'ai-tool-descriptor': admitToolDescriptor as (payload: Record<string, unknown>) => { item: unknown } | { refused: Refusal },
  'tool-placement': admitPlacement,
  'tool-licence-class': admitLicenceClass,
  'tool-gateway': admitGateway,
  'tool-search-source': admitSearchSource,
  'tool-row-source': admitRowSource,
};

export type ToolData = { tools: ToolCatalogItem[]; placements: ToolPlacement[]; licence_classes: ToolLicenceClass[]; notices: ToolOutcomeNotice[]; prices: ToolPrice[]; byte_stores: ToolByteStore[]; gateways: ToolGateway[]; search_sources: ToolSearchSource[]; row_sources: ToolRowSource[]; event_sources: ToolEventSource[]; refused: Refusal[] };

/** Every tool row, placement and licence class in `records`, plus every refusal. A runnable tool (one with
 * `invoke`) must name at least one admitted placement from `records` or `knownPlacements`. */
export function readToolData(records: readonly PublishedRecord[], knownPlacements: readonly ToolPlacement[] = []): ToolData {
  const data: ToolData = { tools: [], placements: [], licence_classes: [], notices: [], prices: [], byte_stores: [], gateways: [], search_sources: [], row_sources: [], event_sources: [], refused: [] };
  const into = { 'ai-tool-descriptor': data.tools, 'tool-placement': data.placements, 'tool-licence-class': data.licence_classes, 'tool-outcome-notice': data.notices, 'tool-price': data.prices, 'tool-byte-store': data.byte_stores, 'tool-gateway': data.gateways, 'tool-search-source': data.search_sources, 'tool-row-source': data.row_sources, 'tool-event-source': data.event_sources } as Record<string, unknown[]>;
  for (const payload of records.map((record) => record.payload)) {
    if (!isRecord(payload) || typeof payload.kind !== 'string' || !ADMIT[payload.kind]) continue;
    const admitted = ADMIT[payload.kind](payload);
    if ('refused' in admitted) data.refused.push(admitted.refused);
    else into[payload.kind].push(admitted.item);
  }
  const deployed = new Set([...knownPlacements, ...data.placements].map((placement) => placement.id));
  data.tools = data.tools.filter((tool) => {
    if (!tool.invoke || (tool.placements ?? []).some((id) => deployed.has(id))) return true;
    data.refused.push({ id: tool.id, kind: 'ai-tool-descriptor', reason: `placements must name at least one deployed placement; ${JSON.stringify(tool.placements ?? [])} names none` });
    return false;
  });
  data.tools.sort((left, right) => String(left.label ?? left.id).localeCompare(String(right.label ?? right.id)));
  data.byte_stores.sort((left, right) => left.rank - right.rank);
  return data;
}

export function readToolCatalog(records: readonly PublishedRecord[]): ToolCatalogItem[] {
  return readToolData(records).tools;
}
