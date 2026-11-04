// packages/service-connections/read-data/read-service-connection-options.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Decodes service-connection option records from package-owned published records.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Service metadata comes from published records, not branching in view code
// 2. Feed-owned connection state overlays this data; the option list is not
//    durable durable truth
// 3. Credential field shapes are data; provider names and auth schemes never
//    create TypeScript branches
// 4. Unknown vendors fall back to a generic credential field
//
// =============================================================================

import type { ServiceConnection } from './read-service-connections';

export interface ServiceCredentialField {
  id: string;
  label: string;
  required: boolean;
  secret: boolean;
  multiline: boolean;
  placeholder: string;
  help: string;
  autocomplete: string;
  /** Deep link to the exact provider page where this value is obtained ('' = none). */
  guideUrl: string;
  /** Numbered, exact steps to obtain the value (banana-level; empty = no guide). */
  guideSteps: string[];
}

export interface ServiceCredentialHelperLink {
  id: string;
  label: string;
  url: string;
  description: string;
}

export interface ServiceCredentialSubmittedField {
  id: string;
  label: string;
  value: string;
  /**
   * True when the field holds a secret (password, token, code). A submission
   * that carries ANY secret field REQUIRES a passing validation before the
   * connection may be written Connected — a saved secret is not proof the
   * credential works. This flag is the self-describing discriminant the connect
   * gate reads (L090): no code enumerates which services are secret.
   */
  secret?: boolean;
}

export interface ServiceCredentialSubmission {
  serviceVendor: string;
  serviceName: string;
  authorizationMethodId?: string;
  fields: ServiceCredentialSubmittedField[];
}

/** Where a credential value lands in the verify request (http-client schema). */
/** Where the request owner (http-client) places a credential. `kind` names one of that owner's placements
 * (a header, a query parameter, a signed token built from the value, ...); every other field is that
 * placement's own setting and is carried through untouched, so a new placement is the owner's to add. */
export interface ServiceCredentialPlacement {
  kind: string;
  name: string;
  prefix: string;
  suffix: string;
  [setting: string]: unknown;
}

export interface ServiceVerifyInjection {
  fieldId: string;
  placement: ServiceCredentialPlacement;
}

export type ServiceBindingExpression = Record<string, unknown> & {
  '$kind': 'binding';
};

export interface ServiceEnvironment {
  id: string;
  label: string;
  default?: boolean;
  baseAddresses: Record<string, string>;
}

/**
 * Real credential check declared by the service record. null = the record
 * declares no check; connect then reports "Saved" honestly, never "Connected".
 */
export interface ServiceVerifyRequest {
  url: string | ServiceBindingExpression;
  method: string;
  headers: Record<string, string>;
  body: string;
  injections: ServiceVerifyInjection[];
  timeoutMs: number;
  /**
   * Where the check's own answer names the account, first found wins: `from` names what is read (the answer's
   * JSON body, its headers, or the fields the service marks not secret) and `path` the keys inside it.
   * Empty = the service names no account, so the account is known by its key alone.
   */
  accountLabelFrom: ServiceAccountLabelPlace[];
}

export interface ServiceAccountLabelPlace {
  from: string;
  path: string[];
}

export interface ServiceAcquireDescriptor {
  flow: string;
  authorize_url?: string;
  token_url?: string;
  scopes?: string[];
  /** Where a token response reports provider-confirmed scopes (defaults to its `scope` field). */
  granted_scopes?: { response_path?: string[]; separator?: string };
  auth_params?: Record<string, string>;
  redirect?: {
    transport: string;
    port_range?: number[];
    url?: string;
  };
  client_ref?: string;
  /** Local OAuth client file path (topology C). Consumed verbatim by the acquire process script. */
  client_path?: string;
  identity?: {
    userinfo_url?: string;
    label_path?: string[];
    /** Optional provider-neutral discovery calls made with the acquired token.
     * Each returned id is namespaced by ref_prefix and persisted as an opaque
     * account-owned resource ref. */
    resource_collections?: Array<{
      url: string;
      items_path: string[];
      id_path: string[];
      primary_ref_path?: string[];
      ref_prefix: string;
    }>;
  };
  store?: {
    vault_target?: string;
    /** Vault key the sealed credential is written under — the workflow's seal_token uses this. */
    vault_key?: string;
  };
}

export interface ServiceCollectDescriptor {
  credentialFields: ServiceCredentialField[];
}

/**
 * One provider-declared way to authorize a service. A service can expose more
 * than one valid route (for example, reuse the account already authorized on
 * this computer or enter an API key) without teaching the shared dialog any
 * provider names. Each method owns the fields and verification/acquisition
 * mechanics that make that route truthful.
 */
export interface ServiceAuthorizationMethod {
  id: string;
  label: string;
  description: string;
  recommended: boolean;
  credentialFields: ServiceCredentialField[];
  collect?: ServiceCollectDescriptor;
  acquire?: ServiceAcquireDescriptor;
  verifyRequest: ServiceVerifyRequest | null;
}

export interface ServiceConnectionStateEffectFact {
  subjectId: string;
  propertyId: string;
  value: unknown;
}

export interface ServiceConnectionStateEffects {
  ready: ServiceConnectionStateEffectFact[];
  stopped: ServiceConnectionStateEffectFact[];
}

/**
 * An inert, package-declared conversation source.  It becomes an active
 * observed-content fact only while its service connection is usable.  Template
 * bindings are resolved by the generic connection owner; providers never get
 * branches in that owner.
 */
export interface ServiceConversationSourceTemplate {
  sourceRef: string;
  descriptor: Record<string, unknown>;
}

export interface ServiceAuthConfig {
  vendor: string;
  name: string;
  instructions: string;
  defaultScopes: string[];
  credentialFields: ServiceCredentialField[];
  helperLinks: ServiceCredentialHelperLink[];
  /** The service's own web address ("stripe.com"); its logo is read from there ('' = a monogram tile from the name). */
  domain: string;
  /** Catalog grouping ("AI", "Payments", …; '' = ungrouped). */
  category: string;
  /** Product capabilities enabled by a developer app, kept as DATA for the app detail view. */
  capabilities?: ServiceCapability[];
  /** Additional facts this connection declares for each lifecycle state.
   * The writer is generic: identity, property, and value all come from DATA. */
  stateEffects?: ServiceConnectionStateEffects;
  /** Inert connector-owned source templates activated by this connection. */
  conversationSourceTemplates?: ServiceConversationSourceTemplate[];
  /** Open, service-declared environment choices. Omitted for envless services. */
  environments?: ServiceEnvironment[];
  /** Direct field collection facet, when credential material is user-supplied. */
  collect?: ServiceCollectDescriptor;
  /** Interactive acquisition facet, executed by a process descriptor. */
  acquire?: ServiceAcquireDescriptor;
  /** Open list of valid authorization routes. Omitted keeps the historical
   *  single-route rendering contract. */
  authorizationMethods?: ServiceAuthorizationMethod[];
  /** Live credential check (null = none declared). */
  verifyRequest: ServiceVerifyRequest | null;
}

export interface ServiceCapability {
  id: string;
  label: string;
  icon: string;
  description: string;
  userChoice?: boolean;
  toolIds?: string[];
  /**
   * Optional provider OAuth requirements by tool. Each inner list is an
   * all-of set; the outer list is any-of. These are observations for UI and
   * diagnostics only, not authorization checks.
   */
  requiredScopeAlternativesByTool?: Record<string, string[][]>;
}

const FALLBACK_CREDENTIAL_FIELD: ServiceCredentialField = {
  id: 'credential',
  label: 'API key or token',
  required: true,
  secret: true,
  multiline: false,
  placeholder: 'Paste the key or token from this service',
  help: 'Most services call this an API key, access token, or secret key. Find it in the service’s settings, usually under "API", "Developers", or "Integrations".',
  autocomplete: 'off',
  guideUrl: '',
  guideSteps: [],
};

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = record[key];
  return typeof value === 'boolean' ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asBindingExpression(value: unknown): ServiceBindingExpression | null {
  if (!isRecord(value) || value.$kind !== 'binding') return null;
  return value as ServiceBindingExpression;
}

function asServiceCredentialField(value: unknown): ServiceCredentialField | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = readString(record, 'id');
  if (!id) return null;
  const label = readString(record, 'label') || id;

  const guideSteps = Array.isArray(record.guideSteps)
    ? record.guideSteps.filter((step): step is string => typeof step === 'string' && step.length > 0)
    : [];

  return {
    id,
    label,
    required: readBoolean(record, 'required', true),
    secret: readBoolean(record, 'secret', true),
    multiline: readBoolean(record, 'multiline', false),
    placeholder: readString(record, 'placeholder'),
    help: readString(record, 'help'),
    autocomplete: readString(record, 'autocomplete') || 'off',
    guideUrl: readString(record, 'guideUrl'),
    guideSteps,
  };
}

function asRequiredScopeAlternativesByTool(value: unknown): Record<string, string[][]> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.length) return undefined;

  const result: Record<string, string[][]> = {};
  for (const [toolId, rawAlternatives] of entries) {
    if (!toolId.trim() || !Array.isArray(rawAlternatives) || rawAlternatives.length === 0) return undefined;
    const alternatives: string[][] = [];
    for (const rawSet of rawAlternatives) {
      if (!Array.isArray(rawSet) || rawSet.length === 0
        || rawSet.some(scope => typeof scope !== 'string' || !scope.trim())) return undefined;
      alternatives.push([...new Set(rawSet.map(scope => (scope as string).trim()))]);
    }
    Object.defineProperty(result, toolId, { value: alternatives, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

export function asServiceCapability(value: unknown): ServiceCapability | null {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id');
  const label = readString(value, 'label');
  if (!id || !label) return null;
  const requiredScopeAlternativesByTool = asRequiredScopeAlternativesByTool(value.required_scope_alternatives_by_tool);
  return { id, label, icon: readString(value, 'icon'), description: readString(value, 'description'),
    ...(value.user_choice === true ? { userChoice: true } : {}),
    ...(Array.isArray(value.tool_ids) ? { toolIds: value.tool_ids.filter((item): item is string => typeof item === 'string' && item.length > 0) } : {}),
    ...(requiredScopeAlternativesByTool ? { requiredScopeAlternativesByTool } : {}) };
}

function asServiceCredentialPlacement(value: unknown): ServiceCredentialPlacement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = readString(record, 'kind');
  const name = readString(record, 'name');
  if (!kind || !name) return null;
  return {
    ...record,
    kind,
    name,
    // prefix/suffix are byte-significant separator glue (e.g. "Bearer " with a
    // required trailing space), NOT display text — reading them through
    // readString() would trim the space, producing "Bearer"+key = "Bearersk-…"
    // and the service rejects it ("Missing bearer authentication in header").
    prefix: typeof record.prefix === 'string' ? record.prefix : '',
    suffix: typeof record.suffix === 'string' ? record.suffix : '',
  };
}

function asServiceVerifyRequest(value: unknown): ServiceVerifyRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawUrl = record.url;
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : asBindingExpression(rawUrl);
  if (!url) return null;
  const injectionsRaw = Array.isArray(record.credential_injections) ? record.credential_injections : [];
  const injections = injectionsRaw
    .map((entry): ServiceVerifyInjection | null => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const injection = entry as Record<string, unknown>;
      const fieldId = readString(injection, 'field_id');
      const placement = asServiceCredentialPlacement(injection.placement);
      if (!fieldId || !placement) return null;
      return { fieldId, placement };
    })
    .filter(isPresent);
  if (!injections.length) return null;

  const headers = (record.headers && typeof record.headers === 'object' && !Array.isArray(record.headers))
    ? Object.fromEntries(
        Object.entries(record.headers as Record<string, unknown>)
          .filter(([, headerValue]) => typeof headerValue === 'string') as Array<[string, string]>,
      )
    : {};

  return {
    url,
    method: readString(record, 'method') || 'GET',
    headers,
    body: readString(record, 'body'),
    injections,
    timeoutMs: typeof record.timeout_ms === 'number' ? record.timeout_ms : 15000,
    accountLabelFrom: (Array.isArray(record.account_label_from) ? record.account_label_from : [])
      .map((entry): ServiceAccountLabelPlace | null => {
        if (!isRecord(entry) || !readString(entry, 'from') || !Array.isArray(entry.path)) return null;
        const path = entry.path.filter((key): key is string => typeof key === 'string' && key.length > 0);
        return path.length === entry.path.length && path.length ? { from: readString(entry, 'from'), path } : null;
      })
      .filter(isPresent),
  };
}

function asServiceAcquireDescriptor(value: unknown): ServiceAcquireDescriptor | null {
  if (!isRecord(value)) return null;
  const flow = readString(value, 'flow');
  if (!flow) return null;
  const scopes = Array.isArray(value.scopes)
    ? value.scopes.filter((scope): scope is string => typeof scope === 'string')
    : undefined;
  const authParams = isRecord(value.auth_params)
    ? Object.fromEntries(
        Object.entries(value.auth_params)
          .filter((entry): entry is [string, string] =>
            typeof entry[0] === 'string'
            && entry[0].length > 0
            && typeof entry[1] === 'string',
          ),
      )
    : undefined;
  const redirect = isRecord(value.redirect) && readString(value.redirect, 'transport')
    ? {
        transport: readString(value.redirect, 'transport'),
        ...(Array.isArray(value.redirect.port_range)
          ? { port_range: value.redirect.port_range.filter((port): port is number => typeof port === 'number') }
          : {}),
        ...(readString(value.redirect, 'url') ? { url: readString(value.redirect, 'url') } : {}),
      }
    : undefined;
  const identity = isRecord(value.identity)
    ? {
        ...value.identity,
        ...(readString(value.identity, 'userinfo_url')
          ? { userinfo_url: readString(value.identity, 'userinfo_url') }
          : {}),
        ...(Array.isArray(value.identity.label_path)
          ? { label_path: value.identity.label_path.filter((part): part is string => typeof part === 'string') }
          : {}),
      }
    : undefined;
  // Preserve the COMPLETE authored store (vault_target + vault_key + any future
  // field) — the workflow's seal_token binds input.acquire.store.vault_key, so a
  // whitelist that drops vault_key breaks the seal with "requires a 'key' field".
  const store = isRecord(value.store)
    ? { ...(value.store as Record<string, unknown>) } as ServiceAcquireDescriptor['store']
    : undefined;

  // The acquire facet is handed VERBATIM to the workflow (mounted as acquire.json
  // and read by the process script) — it must not be narrowed. Spread every
  // authored field first (client_path, store.vault_key, anything added later),
  // then normalize the known display fields on top. Dropping authored fields here
  // is the L090/L063 violation that silently breaks the acquire/seal steps.
  return {
    ...(value as Record<string, unknown>),
    flow,
    process: value.process,
    ...(readString(value, 'authorize_url') ? { authorize_url: readString(value, 'authorize_url') } : {}),
    ...(readString(value, 'token_url') ? { token_url: readString(value, 'token_url') } : {}),
    ...(scopes ? { scopes } : {}),
    ...(authParams ? { auth_params: authParams } : {}),
    ...(redirect ? { redirect } : {}),
    ...(readString(value, 'client_ref') ? { client_ref: readString(value, 'client_ref') } : {}),
    ...(readString(value, 'client_path') ? { client_path: readString(value, 'client_path') } : {}),
    ...(identity ? { identity } : {}),
    ...(store ? { store } : {}),
  } as ServiceAcquireDescriptor;
}

function asServiceCollectDescriptor(value: unknown): ServiceCollectDescriptor | null {
  if (!isRecord(value) || !Array.isArray(value.credentialFields)) return null;
  const credentialFields = value.credentialFields
    .map(asServiceCredentialField)
    .filter(isPresent);
  return credentialFields.length ? { credentialFields } : null;
}

function asServiceCredentialHelperLink(
  value: unknown,
): ServiceCredentialHelperLink | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const url = readString(record, 'url');
  const label = readString(record, 'label');
  if (!url || !label) return null;

  return {
    id: readString(record, 'id') || url,
    label,
    url,
    description: readString(record, 'description'),
  };
}

function asServiceEnvironment(value: unknown): ServiceEnvironment | null {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id');
  if (!id || !isRecord(value.baseAddresses)) return null;
  const baseAddresses = Object.fromEntries(
    Object.entries(value.baseAddresses)
      .filter((entry): entry is [string, string] =>
        entry[0].length > 0
        && typeof entry[1] === 'string'
        && entry[1].length > 0,
      ),
  );
  if (Object.keys(baseAddresses).length === 0) return null;

  return {
    id,
    label: readString(value, 'label') || id,
    ...(typeof value.default === 'boolean' ? { default: value.default } : {}),
    baseAddresses,
  };
}

function asStateEffectFact(value: unknown): ServiceConnectionStateEffectFact | null {
  if (!isRecord(value)) return null;
  const subjectId = readString(value, 'subjectId');
  const propertyId = readString(value, 'propertyId');
  if (!subjectId || !propertyId || !Object.hasOwn(value, 'value')) return null;
  return { subjectId, propertyId, value: value.value };
}

function asStateEffects(value: unknown): ServiceConnectionStateEffects | undefined {
  if (!isRecord(value)) return undefined;
  const ready = Array.isArray(value.ready)
    ? value.ready.map(asStateEffectFact).filter(isPresent)
    : [];
  const stopped = Array.isArray(value.stopped)
    ? value.stopped.map(asStateEffectFact).filter(isPresent)
    : [];
  return ready.length || stopped.length ? { ready, stopped } : undefined;
}

function asConversationSourceTemplate(value: unknown): ServiceConversationSourceTemplate | null {
  if (!isRecord(value)) return null;
  const sourceRef = readString(value, 'source_ref');
  const descriptor = isRecord(value.descriptor) ? value.descriptor : null;
  if (!sourceRef || !descriptor) return null;
  return { sourceRef, descriptor };
}

function sourceTemplatesByVendor(raw: readonly unknown[]): Map<string, ServiceConversationSourceTemplate[]> {
  const result = new Map<string, ServiceConversationSourceTemplate[]>();
  for (const row of raw) {
    if (!isRecord(row) || !isRecord(row.payload)) continue;
    const payload = row.payload;
    if (payload.kind !== 'service-connection-conversation-source-template-set') continue;
    const vendor = readString(payload, 'vendor');
    const templates = Array.isArray(payload.templates)
      ? payload.templates.map(asConversationSourceTemplate).filter(isPresent)
      : [];
    if (!vendor || templates.length === 0 || result.has(vendor)) continue;
    result.set(vendor, templates);
  }
  return result;
}

function asServiceAuthConfig(value: unknown): ServiceAuthConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.vendor !== 'string' || record.vendor.length === 0) return null;
  if (typeof record.name !== 'string' || record.name.length === 0) return null;
  const collect = asServiceCollectDescriptor(record.collect);
  const hasRootCredentialFields = Array.isArray(record.credentialFields);
  const credentialFields = hasRootCredentialFields
    ? record.credentialFields.map(asServiceCredentialField).filter(isPresent)
    : collect?.credentialFields ?? [];
  const environments = Array.isArray(record.environments)
    ? record.environments.map(asServiceEnvironment).filter(isPresent)
    : [];
  const acquire = asServiceAcquireDescriptor(record.acquire);
  const stateEffects = asStateEffects(record.stateEffects);
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.map(asServiceCapability).filter(isPresent)
    : [];
  const authorizationMethods = Array.isArray(record.authorizationMethods)
    ? record.authorizationMethods
        .map((method): ServiceAuthorizationMethod | null => {
          if (!isRecord(method)) return null;
          const id = readString(method, 'id');
          const label = readString(method, 'label');
          if (!id || !label) return null;
          const methodCollect = asServiceCollectDescriptor(method.collect);
          const hasMethodRootFields = Array.isArray(method.credentialFields);
          const methodFields = hasMethodRootFields
            ? method.credentialFields.map(asServiceCredentialField).filter(isPresent)
            : methodCollect?.credentialFields ?? [];
          const methodAcquire = asServiceAcquireDescriptor(method.acquire);
          if (!hasMethodRootFields && !methodCollect && !methodAcquire) return null;
          return {
            id,
            label,
            description: readString(method, 'description'),
            recommended: readBoolean(method, 'recommended', false),
            credentialFields: methodFields,
            ...(methodCollect ? { collect: methodCollect } : {}),
            ...(methodAcquire ? { acquire: methodAcquire } : {}),
            verifyRequest: asServiceVerifyRequest(method.verifyRequest),
          };
        })
        .filter(isPresent)
    : [];

  return {
    vendor: record.vendor,
    name: record.name,
    instructions: typeof record.instructions === 'string' ? record.instructions : '',
    defaultScopes: Array.isArray(record.defaultScopes)
      ? record.defaultScopes.filter((scope): scope is string => typeof scope === 'string')
      : [],
    credentialFields: hasRootCredentialFields || collect || acquire
      ? credentialFields
      : [FALLBACK_CREDENTIAL_FIELD],
    helperLinks: Array.isArray(record.helperLinks)
      ? record.helperLinks.map(asServiceCredentialHelperLink).filter(isPresent)
      : [],
    domain: readString(record, 'domain'),
    category: readString(record, 'category'),
    ...(capabilities.length ? { capabilities } : {}),
    ...(stateEffects ? { stateEffects } : {}),
    ...(environments.length ? { environments } : {}),
    ...(collect ? { collect } : {}),
    ...(acquire ? { acquire } : {}),
    ...(authorizationMethods.length ? { authorizationMethods } : {}),
    verifyRequest: asServiceVerifyRequest(record.verifyRequest),
  };
}

/**
 * The connectable-provider catalog is derived LIVE from the
 * `::published-record::<vendor>` log records — the single source of truth.
 * Adding or editing a provider is a live log write that appears INSTANTLY in
 * the catalog; there is no regenerated cell_table to drift out of sync (SSOT,
 * reactive).
 *
 * Input is the reactive `published-records` projection: an array of
 * `{ address, payload }` rows spanning every published record in the app. A row
 * is a connectable provider iff its payload self-describes as one — it carries a
 * collection facet or an acquisition facet and parses as a ServiceAuthConfig
 * (L090: the data describes itself; this handler never enumerates which vendors
 * exist). Surface records and every other published record fail that shape and
 * are skipped.
 */
export function readServiceConnectionOptions(raw: unknown): ServiceAuthConfig[] {
  if (!Array.isArray(raw)) return [];
  const templatesByVendor = sourceTemplatesByVendor(raw);
  const configs: ServiceAuthConfig[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (!isRecord(row)) continue;
    const payload = row.payload;
    const hasCollectFields = isRecord(payload)
      && isRecord(payload.collect)
      && Array.isArray(payload.collect.credentialFields);
    const hasRootFields = isRecord(payload) && Array.isArray(payload.credentialFields);
    const hasAcquire = isRecord(payload) && isRecord(payload.acquire);
    const hasAuthorizationMethods = isRecord(payload) && Array.isArray(payload.authorizationMethods);
    if (!isRecord(payload) || (!hasRootFields && !hasCollectFields && !hasAcquire && !hasAuthorizationMethods)) continue;
    const config = asServiceAuthConfig(payload);
    if (!config || seen.has(config.vendor)) continue;
    seen.add(config.vendor);
    configs.push({
      ...config,
      ...(templatesByVendor.has(config.vendor)
        ? { conversationSourceTemplates: templatesByVendor.get(config.vendor) }
        : {}),
    });
  }
  return configs.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Derive a vendor id from a human-typed service name ("My CRM" → "my-crm").
 * The catalog is open-ended: any name the user types becomes a connectable
 * service through the generic fallback config.
 */
export function deriveCustomServiceVendor(serviceName: string): string {
  return serviceName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function resolveServiceAuthConfig(
  configs: ServiceAuthConfig[],
  serviceVendor: string,
  serviceName?: string,
): ServiceAuthConfig {
  const existing = configs.find((config) => config.vendor === serviceVendor);
  if (existing) return existing;

  return {
    vendor: serviceVendor,
    name: serviceName ?? serviceVendor,
    instructions: 'Connect with the key or token this service gave you.',
    defaultScopes: [],
    credentialFields: [FALLBACK_CREDENTIAL_FIELD],
    helperLinks: [],
    domain: '',
    category: '',
    verifyRequest: null,
  };
}

export function listMountableServiceAuthConfigs(
  configs: ServiceAuthConfig[],
): ServiceAuthConfig[] {
  // configs.length is always greater than zero here, so explicitly empty
  // credentialFields remains mountable as a no-credential local service.
  return configs.filter((config) => configs.length > 0 || !!config.acquire);
}

export type ServiceConnectionDisplay = ServiceConnection & {
  /** What connecting this service lets the user do, in their language. */
  purpose: string;
  /** The service's own web address; its logo is read from there ('' = monogram tile from the name). */
  domain: string;
  /** Catalog grouping ("AI", "Payments", …; '' = ungrouped). */
  category: string;
  /** Inert connector data used to write/clear active source descriptors. */
  conversationSourceTemplates?: ServiceConversationSourceTemplate[];
  /** Open, service-declared environment choices. Omitted for envless services. */
  environments?: ServiceEnvironment[];
};

/**
 * The ONLY connection fields the write path needs to mint a secret, run the
 * verify check, and address the owner facts. Ref-free by construction: a
 * caller can hand the write path this five-field target without ever
 * reconstructing decode-internal ref vocabulary (statusRef, proofRefs,
 * credentialHandle, …). Any view-model that carries identity + scopes +
 * environments structurally satisfies it (L098: callers speak the write
 * path's language, never its storage internals).
 */
export interface ServiceConnectionTarget {
  id: string;
  /**
   * AGNOSTIC service name (e.g. "Google", "Gmail", "GitHub") — never the account
   * identity. This is the primary display label and stays static across account
   * changes. The connection's display name in the UI is built from this (primary)
   * + accountLabel (secondary, when present).
   */
  serviceName: string;
  /** Account identity (email, handle, jid) extracted during acquire/collection. */
  accountLabel?: string;
  /** Opaque provider-resource identities selected inside this account (for
   * example a channel, page, publication, or workspace). Generic consumers
   * match these refs without learning the provider's resource vocabulary. */
  resourceRefs?: string[];
  serviceVendor: string;
  scopes: string[];
  /** Provider-confirmed OAuth grants, independent of requested/default scopes. */
  grantScopes?: string[];
  grantScopesKnown?: boolean;
  environments?: ServiceEnvironment[];
  stateEffects?: ServiceConnectionStateEffects;
  conversationSourceTemplates?: ServiceConversationSourceTemplate[];
}

/**
 * Derive a connection instance id. The FIRST account of a vendor keeps the
 * historical singleton id (existing facts stay valid); every additional
 * account appends a slug from its label. Identity = instance, never a
 * per-vendor singleton — one user holds many accounts of one service.
 */
export function deriveConnectionInstanceId(
  serviceVendor: string,
  accountLabel: string,
  existingIds: ReadonlySet<string>,
): string {
  const base = `service_connection:${serviceVendor}`;
  if (!existingIds.has(base)) return base;
  const slug = deriveCustomServiceVendor(accountLabel) || 'account';
  let candidate = `${base}:${slug}`;
  let ordinal = 2;
  while (existingIds.has(candidate)) {
    candidate = `${base}:${slug}-${ordinal}`;
    ordinal += 1;
  }
  return candidate;
}

export function buildServiceConnectionDisplayList(
  connections: ServiceConnection[],
  configs: ServiceAuthConfig[],
): ServiceConnectionDisplay[] {
  const configByVendor = new Map(configs.map((config) => [config.vendor, config] as const));
  const connectedVendors = new Set(connections.map((connection) => connection.serviceVendor));

  // Every connection INSTANCE is its own row — a vendor with three accounts
  // shows three rows. Catalog metadata decorates each instance.
  const instanceRows = connections.map((connection) => {
    const config = configByVendor.get(connection.serviceVendor);
    return {
      ...connection,
      scopes: connection.scopes.length ? connection.scopes : config?.defaultScopes ?? [],
      purpose: config?.instructions ?? '',
      domain: config?.domain ?? '',
      category: config?.category ?? 'Your services',
      ...(config?.stateEffects ? { stateEffects: config.stateEffects } : {}),
      ...(config?.conversationSourceTemplates?.length
        ? { conversationSourceTemplates: config.conversationSourceTemplates }
        : {}),
      ...(config?.environments?.length ? { environments: config.environments } : {}),
    };
  });

  // Catalog vendors with no connection yet render one connectable row.
  const catalogRows = listMountableServiceAuthConfigs(configs)
    .filter((config) => !connectedVendors.has(config.vendor))
    .map((config) => ({
      id: `service_connection:${config.vendor}`,
      serviceName: config.name,
      serviceVendor: config.vendor,
      accountLabel: '',
      status: 'disconnected',
      statusRef: '',
      canConnect: true,
      canSend: false,
      canRetry: false,
      isPending: false,
      scopes: config.defaultScopes,
      grantScopes: [],
      grantScopesKnown: false,
      credentialHandle: '',
      credentialHandleRefs: [],
      resourceRefs: [],
      connectedAt: null,
      proofRefs: [],
      blockerRefs: [],
      eventRefs: [],
      purpose: config.instructions,
      domain: config.domain,
      category: config.category,
      ...(config.stateEffects ? { stateEffects: config.stateEffects } : {}),
      ...(config.conversationSourceTemplates?.length
        ? { conversationSourceTemplates: config.conversationSourceTemplates }
        : {}),
      ...(config.environments?.length ? { environments: config.environments } : {}),
    }));

  return [...instanceRows, ...catalogRows];
}
