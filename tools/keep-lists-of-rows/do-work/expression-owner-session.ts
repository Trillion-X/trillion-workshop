// Target-blind lifecycle owner for expression-capable evaluators.
//
// Presentation supplies descriptor DATA, source/catalog identities, and an
// opaque Envelope dispatcher. This work-layer primitive exclusively owns
// capability caching, request tokens, revision guards, timeouts, one refresh
// after owner-registry/policy change, and latest-only reply acceptance.

import type {
  ExpressionOwnerOperation,
  ExpressionReplySemanticKey,
  VisualDatabaseExpressionAuthoringDescriptor,
} from '../read-data/visual-database';
import {
  acceptExpressionOwnerReply,
  composeExpressionOwnerRequest,
  decodeExpressionOwnerReply,
  withExpressionOwnerTimeout,
  type ExpressionOwnerGuardState,
} from './expression-owner-protocol';

export type ExpressionOwnerDispatch = (
  target: string,
  request: Record<string, unknown>,
) => Promise<unknown>;

export interface ExpressionOwnerCapabilities {
  functions: unknown;
  registryRevision: string;
  policyRevision: string;
}

export type ExpressionOwnerRevisionBasis = Pick<
  ExpressionOwnerCapabilities,
  'registryRevision' | 'policyRevision'
>;

export interface ExpressionOwnerSessionReply {
  operation: Exclude<ExpressionOwnerOperation, 'capabilities'>;
  values: Readonly<Partial<Record<ExpressionReplySemanticKey, unknown>>>;
  registryRevision: string;
  policyRevision: string;
}

export interface ExpressionOwnerSessionInput {
  target: string;
  descriptor: VisualDatabaseExpressionAuthoringDescriptor;
  sourceRevision: string;
  catalogRevision: string;
}

interface CapabilityCacheEntry {
  promise: Promise<ExpressionOwnerCapabilities>;
  value?: ExpressionOwnerCapabilities;
}

function capabilityCacheKey(input: ExpressionOwnerSessionInput): string {
  return JSON.stringify([
    input.target,
    input.descriptor.revision,
    input.catalogRevision,
  ]);
}

function capabilityRefreshKey(
  cacheKey: string,
  basis: ExpressionOwnerRevisionBasis,
): string {
  return JSON.stringify([
    cacheKey,
    basis.registryRevision,
    basis.policyRevision,
  ]);
}

function sameRevisionBasis(
  capabilities: ExpressionOwnerRevisionBasis,
  basis: ExpressionOwnerRevisionBasis,
): boolean {
  return capabilities.registryRevision === basis.registryRevision
    && capabilities.policyRevision === basis.policyRevision;
}

export class ExpressionOwnerReplyRejectedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Expression owner reply was rejected (${reason}).`);
    this.name = 'ExpressionOwnerReplyRejectedError';
    this.reason = reason;
  }
}

export class ExpressionOwnerStaleReplyError extends Error {
  constructor() {
    super('Expression owner reply is stale.');
    this.name = 'ExpressionOwnerStaleReplyError';
  }
}

/**
 * One factory is shared by every foreground/background session using the same
 * transport. Capability DATA is source-independent and cached by owner target,
 * descriptor revision, and caller catalog revision. The first caller's echoed
 * guards never leak from the cache; only owner registry/policy revisions and
 * function DATA survive.
 */
export class ExpressionOwnerSessionFactory {
  private readonly capabilityCache = new Map<string, CapabilityCacheEntry>();
  private readonly capabilityRefreshes = new Map<
    string,
    Promise<ExpressionOwnerCapabilities>
  >();
  private readonly activeCapabilityRefresh = new Map<
    string,
    Promise<ExpressionOwnerCapabilities>
  >();
  private requestSequence = 0;

  constructor(private readonly dispatch: ExpressionOwnerDispatch) {}

  create(input: ExpressionOwnerSessionInput): ExpressionOwnerSession {
    return new ExpressionOwnerSession(this, input);
  }

  invalidate(input: ExpressionOwnerSessionInput): void {
    const key = capabilityCacheKey(input);
    this.capabilityCache.delete(key);
    this.activeCapabilityRefresh.delete(key);
    for (const refreshKey of this.capabilityRefreshes.keys()) {
      if (refreshKey.startsWith(`[${JSON.stringify(key)},`)) {
        this.capabilityRefreshes.delete(refreshKey);
      }
    }
  }

  async capabilities(
    input: ExpressionOwnerSessionInput,
    refresh: false | true | ExpressionOwnerRevisionBasis = false,
  ): Promise<ExpressionOwnerCapabilities> {
    const key = capabilityCacheKey(input);
    if (refresh === false) return this.cachedOrLoadCapabilities(input, key);

    const staleBasis = refresh === true
      ? await this.cachedOrLoadCapabilities(input, key)
      : refresh;
    const refreshKey = capabilityRefreshKey(key, staleBasis);
    const sameBasisRefresh = this.capabilityRefreshes.get(refreshKey);
    if (sameBasisRefresh) return sameBasisRefresh;

    const current = this.capabilityCache.get(key);
    if (current) {
      const currentValue = current.value ?? await current.promise;
      if (!sameRevisionBasis(currentValue, staleBasis)) return currentValue;
    }

    const active = this.activeCapabilityRefresh.get(key);
    if (active) {
      const refreshed = await active;
      if (!sameRevisionBasis(refreshed, staleBasis)) return refreshed;
      return this.capabilityRefreshes.get(refreshKey) ?? refreshed;
    }

    let promise!: Promise<ExpressionOwnerCapabilities>;
    promise = this.loadCapabilities(input).then((value) => {
      const entry = this.capabilityCache.get(key);
      if (entry?.promise === promise) entry.value = value;
      return value;
    }).catch((error) => {
      if (this.capabilityCache.get(key)?.promise === promise) {
        this.capabilityCache.delete(key);
      }
      if (this.capabilityRefreshes.get(refreshKey) === promise) {
        this.capabilityRefreshes.delete(refreshKey);
      }
      throw error;
    }).finally(() => {
      if (this.activeCapabilityRefresh.get(key) === promise) {
        this.activeCapabilityRefresh.delete(key);
      }
    });
    this.capabilityRefreshes.set(refreshKey, promise);
    this.activeCapabilityRefresh.set(key, promise);
    this.capabilityCache.set(key, { promise });
    return promise;
  }

  async dispatchRequest(
    input: ExpressionOwnerSessionInput,
    operation: Exclude<ExpressionOwnerOperation, 'capabilities'>,
    values: Record<string, unknown>,
    requestToken: string,
    registryRevision: string,
    policyRevision: string,
  ): Promise<ExpressionOwnerSessionReply> {
    const guard: ExpressionOwnerGuardState = {
      target: input.target,
      descriptorRevision: input.descriptor.revision,
      requestToken,
      sourceRevision: input.sourceRevision,
      catalogRevision: input.catalogRevision,
      registryRevision,
      policyRevision,
    };
    const request = composeExpressionOwnerRequest(input.descriptor, operation, {
      request_token: requestToken,
      source_revision: input.sourceRevision,
      catalog_revision: input.catalogRevision,
      registry_revision: registryRevision,
      expected_policy_revision: policyRevision,
      ...values,
    });
    const raw = await withExpressionOwnerTimeout(
      this.dispatch(input.target, request),
      input.descriptor.interactionPolicy.timeoutMs,
    );
    const decoded = decodeExpressionOwnerReply(input.descriptor, operation, raw);
    const acceptance = acceptExpressionOwnerReply(guard, {
      target: input.target,
      descriptorRevision: input.descriptor.revision,
      decoded,
    });
    if (!acceptance.accepted) {
      throw new ExpressionOwnerReplyRejectedError(acceptance.reason ?? 'unknown');
    }
    return {
      operation,
      values: decoded.values,
      registryRevision,
      policyRevision,
    };
  }

  nextToken(operation: ExpressionOwnerOperation): string {
    this.requestSequence += 1;
    return `expression-${operation}-${this.requestSequence}`;
  }

  private cachedOrLoadCapabilities(
    input: ExpressionOwnerSessionInput,
    key: string,
  ): Promise<ExpressionOwnerCapabilities> {
    const cached = this.capabilityCache.get(key);
    if (cached) return cached.promise;

    let promise!: Promise<ExpressionOwnerCapabilities>;
    promise = this.loadCapabilities(input).then((value) => {
      const entry = this.capabilityCache.get(key);
      if (entry?.promise === promise) entry.value = value;
      return value;
    }).catch((error) => {
      if (this.capabilityCache.get(key)?.promise === promise) {
        this.capabilityCache.delete(key);
      }
      throw error;
    });
    this.capabilityCache.set(key, { promise });
    return promise;
  }

  private async loadCapabilities(
    input: ExpressionOwnerSessionInput,
  ): Promise<ExpressionOwnerCapabilities> {
    const requestToken = this.nextToken('capabilities');
    const guard: ExpressionOwnerGuardState = {
      target: input.target,
      descriptorRevision: input.descriptor.revision,
      requestToken,
      sourceRevision: input.sourceRevision,
      catalogRevision: input.catalogRevision,
      registryRevision: null,
      policyRevision: null,
    };
    const request = composeExpressionOwnerRequest(input.descriptor, 'capabilities', {
      request_token: requestToken,
      source_revision: input.sourceRevision,
      catalog_revision: input.catalogRevision,
      registry_revision: null,
      expected_policy_revision: null,
    });
    const raw = await withExpressionOwnerTimeout(
      this.dispatch(input.target, request),
      input.descriptor.interactionPolicy.timeoutMs,
    );
    const decoded = decodeExpressionOwnerReply(input.descriptor, 'capabilities', raw);
    const acceptance = acceptExpressionOwnerReply(guard, {
      target: input.target,
      descriptorRevision: input.descriptor.revision,
      decoded,
    });
    const registryRevision = acceptance.nextRegistryRevision;
    const policyRevision = acceptance.nextPolicyRevision;
    if (!acceptance.accepted || !registryRevision || !policyRevision) {
      throw new ExpressionOwnerReplyRejectedError(acceptance.reason ?? 'capabilities');
    }
    return {
      functions: decoded.values.functions,
      registryRevision,
      policyRevision,
    };
  }
}

export class ExpressionOwnerSession {
  private activeGeneration = 0;
  private closed = false;
  private capabilitiesState: ExpressionOwnerCapabilities | null = null;

  constructor(
    private readonly factory: ExpressionOwnerSessionFactory,
    private readonly input: ExpressionOwnerSessionInput,
  ) {}

  close(): void {
    this.closed = true;
    this.activeGeneration += 1;
  }

  cancelPending(): void {
    if (this.closed) return;
    this.activeGeneration += 1;
  }

  revisions(): Pick<ExpressionOwnerCapabilities, 'registryRevision' | 'policyRevision'> | null {
    if (!this.capabilitiesState) return null;
    return {
      registryRevision: this.capabilitiesState.registryRevision,
      policyRevision: this.capabilitiesState.policyRevision,
    };
  }

  async capabilities(forceRefresh = false): Promise<ExpressionOwnerCapabilities> {
    this.assertOpen();
    const generation = ++this.activeGeneration;
    const refresh = forceRefresh
      ? this.capabilitiesState ?? true
      : false;
    const capabilities = await this.factory.capabilities(this.input, refresh);
    this.assertCurrent(generation);
    this.capabilitiesState = capabilities;
    return capabilities;
  }

  analyze(values: Record<string, unknown>): Promise<ExpressionOwnerSessionReply> {
    return this.request('analyze', values, true);
  }

  evaluate(values: Record<string, unknown>): Promise<ExpressionOwnerSessionReply> {
    return this.request('evaluate', values, true);
  }

  projectSource(values: Record<string, unknown>): Promise<ExpressionOwnerSessionReply> {
    return this.request('project_source', values, true);
  }

  private async request(
    operation: Exclude<ExpressionOwnerOperation, 'capabilities'>,
    values: Record<string, unknown>,
    allowOwnerRefresh: boolean,
  ): Promise<ExpressionOwnerSessionReply> {
    this.assertOpen();
    const capabilities = this.capabilitiesState ?? await this.capabilities();
    const generation = ++this.activeGeneration;
    try {
      const reply = await this.factory.dispatchRequest(
        this.input,
        operation,
        values,
        this.factory.nextToken(operation),
        capabilities.registryRevision,
        capabilities.policyRevision,
      );
      this.assertCurrent(generation);
      return reply;
    } catch (error) {
      this.assertCurrent(generation);
      if (allowOwnerRefresh
        && error instanceof ExpressionOwnerReplyRejectedError
        && (error.reason === 'registry_revision' || error.reason === 'policy_revision')) {
        this.capabilitiesState = await this.factory.capabilities(this.input, {
          registryRevision: capabilities.registryRevision,
          policyRevision: capabilities.policyRevision,
        });
        this.assertCurrent(generation);
        return this.request(operation, values, false);
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new ExpressionOwnerStaleReplyError();
  }

  private assertCurrent(generation: number): void {
    if (this.closed || generation !== this.activeGeneration) {
      throw new ExpressionOwnerStaleReplyError();
    }
  }
}
