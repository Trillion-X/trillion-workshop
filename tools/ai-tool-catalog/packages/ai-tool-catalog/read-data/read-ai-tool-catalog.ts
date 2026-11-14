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
import { validatedDeclaredSelector, type DeclaredSelector } from '../../../../ui/read-data/declared-selector.ts';

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
  /** BLAKE3 identity of the tool's frozen bytes. */
  bytes_fingerprint?: string;
  /** How a JSON call becomes the tool's own invocation; `kind` selects the runner's capability. */
  invoke?: ToolInvocation;
  /** What a run needs: durations, memory, egress, and secret NAMES only. */
  needs?: Record<string, unknown>;
  licence_class?: string;
  /** Placement ids, in the order the tool prefers them. */
  placements?: string[];
  maker?: string;
  price_ref?: string;
  /** How to tell the job was done, beyond the output's shape: each check has a `kind` the runner knows
   * (`output-contains`, `output-contains-input`, `sample-run`). */
  verify?: Array<{ kind: string } & Record<string, unknown>>;
  /** True when a successful run's output is itself a tool (`{ descriptor }`) to keep for the caller. */
  result_saved_as_tool?: boolean;
  /** Where the bytes came from: a repository and commit, an export, an upload. */
  provenance?: Record<string, unknown>;
  /** Who may pay for a call, in order (`payers`), and what it costs: a `gateway` row id whose account pays, the
   * source's quoted `price_micros` per `per`, a `markup`, or the maker's own billing page. Names only, never values. */
  billing?: Record<string, unknown>;
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

/** Admit one `ai-tool-descriptor` payload, or say exactly why it is refused. */
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
  for (const field of ['needs', 'provenance'] as const) {
    if (payload[field] !== undefined && !isRecord(payload[field])) return refuse(id, `${field} must be an object`);
  }
  if (payload.verify !== undefined && !(Array.isArray(payload.verify) && payload.verify.length > 0 && payload.verify.every((check) => isRecord(check) && text(check.kind)))) {
    return refuse(id, 'verify must be a non-empty list of checks, each with a kind');
  }
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
      ...optionalText('bytes_fingerprint'),
      ...(isRecord(payload.invoke) ? { invoke: payload.invoke as ToolInvocation } : {}),
      ...(needs ? { needs } : {}),
      ...optionalText('licence_class'),
      ...(texts(payload.placements) ? { placements: payload.placements as string[] } : {}),
      ...optionalText('maker'),
      ...optionalText('price_ref'),
      ...(payload.result_saved_as_tool === true ? { result_saved_as_tool: true } : {}),
      ...(Array.isArray(payload.verify) ? { verify: payload.verify as ToolCatalogItem['verify'] } : {}),
      ...(isRecord(payload.provenance) ? { provenance: payload.provenance } : {}),
      ...(isRecord(payload.billing) ? { billing: payload.billing } : {}),
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
export type ToolSearchSource = { id: string; label: string; search: Record<string, unknown>; get?: Record<string, unknown>; entry: Record<string, string>; id_prefix: string; row: Record<string, unknown>; input_dialect?: Record<string, unknown>; price?: Record<string, unknown>; gateway?: string };

function admitSearchSource(payload: Record<string, unknown>): { item: ToolSearchSource } | { refused: Refusal } {
  const id = text(payload.id) ?? null;
  const refuse = (reason: string) => ({ refused: { id, kind: 'tool-search-source', reason } });
  const secret = secretValuePath(payload);
  if (secret) return refuse(`${secret} holds a secret value; name the secret instead`);
  const label = text(payload.label);
  const search = isRecord(payload.search) ? payload.search : null;
  const entry = isRecord(payload.entry) && Object.values(payload.entry).every((value) => text(value)) ? payload.entry as Record<string, string> : null;
  if (!id || !label || !search || !text(search.url) || !entry || !text(entry.id) || !text(payload.id_prefix) || !isRecord(payload.row)) {
    return refuse('a search source needs id, label, search { url, ... }, entry (field names, with id), id_prefix and row');
  }
  return {
    item: {
      id, label, search, entry, id_prefix: payload.id_prefix as string, row: payload.row,
      ...(isRecord(payload.get) ? { get: payload.get } : {}),
      ...(isRecord(payload.input_dialect) ? { input_dialect: payload.input_dialect } : {}),
      ...(isRecord(payload.price) ? { price: payload.price } : {}),
      ...(text(payload.gateway) ? { gateway: payload.gateway as string } : {}),
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
 * the tool that tells an account which route key is its own, so nobody can listen for someone else's events. */
export type EventPath = Array<string | number>;
export type ToolEventSource = {
  id: string; label: string;
  signature: { header: string; prefix?: string; hmac: string; encoding: string; secret_name: string };
  handshake?: Record<string, unknown>;
  delivery_where?: Array<{ path: EventPath; equals?: unknown; not?: boolean; present?: boolean }>;
  events: Array<{ name: string; each: Array<{ field: string; as: string }>; where?: Array<{ path: EventPath; equals?: unknown; not?: boolean; present?: boolean }>; fields: Record<string, EventPath>; required: string[]; skip_when_same?: string[][] }>;
  route_key: string; event_id: string;
  route_key_proof: { tool_id: string; output_selector: string };
  listen_tool_id?: string;
  /** How fast and how late the account may answer, per event, and which failures are tried again: DATA, from the
   * sender's published limits. */
  delivery_policy?: Record<string, unknown>;
};

function admitEventSource(payload: Record<string, unknown>): { item: ToolEventSource } | { refused: Refusal } {
  const id = text(payload.id) ?? null;
  const refuse = (reason: string) => ({ refused: { id, kind: 'tool-event-source', reason } });
  const secret = secretValuePath(payload);
  if (secret) return refuse(`${secret} holds a secret value; name the secret instead`);
  const label = text(payload.label);
  const signature = isRecord(payload.signature) ? payload.signature : null;
  const proof = isRecord(payload.route_key_proof) ? payload.route_key_proof : null;
  const path = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string' || Number.isInteger(part));
  const conditions = (value: unknown) => value === undefined || (Array.isArray(value) && value.every((item) => isRecord(item) && path(item.path)));
  const events = Array.isArray(payload.events) ? payload.events : null;
  const goodEvent = (event: unknown) => isRecord(event) && text(event.name) && Array.isArray(event.each) && event.each.length > 0
    && event.each.every((step) => isRecord(step) && text(step.field) && text(step.as)) && conditions(event.where)
    && isRecord(event.fields) && Object.values(event.fields).every(path) && texts(event.required)
    && (texts(event.required) as string[]).every((field) => Object.hasOwn(event.fields as object, field));
  if (!id || !label || !signature || !text(signature.header) || !text(signature.hmac) || !text(signature.encoding) || !text(signature.secret_name)
    || !events || !events.length || !events.every(goodEvent) || !conditions(payload.delivery_where)
    || !text(payload.route_key) || !text(payload.event_id) || !proof || !text(proof.tool_id) || !text(proof.output_selector)) {
    return refuse('an event source needs id, label, signature { header, hmac, encoding, secret_name }, events [{ name, each [{ field, as }], fields, required }], route_key, event_id and route_key_proof { tool_id, output_selector }');
  }
  return {
    item: {
      id, label, signature: signature as ToolEventSource['signature'], events: events as ToolEventSource['events'],
      route_key: payload.route_key as string, event_id: payload.event_id as string, route_key_proof: proof as ToolEventSource['route_key_proof'],
      ...(isRecord(payload.handshake) ? { handshake: payload.handshake } : {}),
      ...(Array.isArray(payload.delivery_where) ? { delivery_where: payload.delivery_where as ToolEventSource['delivery_where'] } : {}),
      ...(text(payload.listen_tool_id) ? { listen_tool_id: payload.listen_tool_id as string } : {}),
      ...(isRecord(payload.delivery_policy) ? { delivery_policy: payload.delivery_policy } : {}),
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
