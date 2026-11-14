const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;

export class CarrierHttpEffectError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'CarrierHttpEffectError';
    this.status = status;
  }
}

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function decodeTargetPayload(envelope) {
  if (typeof envelope?.payload_base64 === 'string') {
    return JSON.parse(Buffer.from(envelope.payload_base64, 'base64').toString('utf8'));
  }
  if (typeof envelope?.payload_text === 'string') return JSON.parse(envelope.payload_text);
  if (Object.hasOwn(envelope || {}, 'payload')) return envelope.payload;
  return envelope;
}

export function encodeTargetPayload(payload) {
  return {
    payload_base64: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
  };
}

// The HTTP `/target/*` response body is already the transport for target bytes.
// It must not use `encodeTargetPayload`, which is an engine-envelope shape and
// would make a browser package see `{ payload_base64 }` instead of its result.
export function encodeBrowserTargetResponse(payload) {
  return JSON.stringify(payload);
}

export async function resolveCheckoutTransport(materialization, options = {}) {
  const gate = record(materialization?.gate) ? materialization.gate : null;
  const completedWithoutProvider = gate
    && materialization?.status === 'succeeded'
    && materialization?.paymentMode === 'free'
    && nonempty(materialization?.customerId)
    && nonempty(materialization?.providerSessionId);

  // A genuinely free checkout completes inside the engine: its signed access
  // events are already admitted and there is no payment provider to call. The
  // public carrier must return that authoritative result directly instead of
  // requiring a Stripe transport effect that must not exist.
  if (completedWithoutProvider) {
    return {
      operationId: materialization.providerSessionId,
      output: materialization,
      transport: 'direct',
    };
  }

  if (!gate || !record(materialization?.material) || !record(materialization?.effect)) {
    throw new CarrierHttpEffectError('Checkout engine did not return a completed checkout or an admitted carrier effect.');
  }

  const executeEffect = options.executeEffect || executeCarrierHttpEffect;
  const provider = await executeEffect(materialization.effect, {
    ...options,
    invokeTarget: options.invokeTarget,
  });
  const output = {
    ...materialization.material,
    gate,
    // Provider targets own their result vocabulary. The Stripe provider's stable
    // result contract is provider_session_id + url; retain the legacy camel-case
    // aliases only as a compatibility read at this public HTTP boundary.
    providerSessionId: provider?.provider_session_id ?? provider?.providerSessionId,
    redirectUrl: provider?.url ?? provider?.redirectUrl,
  };
  if (!output.providerSessionId || !output.redirectUrl) {
    throw new CarrierHttpEffectError('Payment provider did not return a hosted checkout URL.');
  }
  return {
    operationId: materialization.effect.operationId,
    output,
    transport: 'provider',
  };
}

export function credentialEnvironmentName(credentialRef, environment = process.env) {
  let bindings;
  try {
    bindings = JSON.parse(environment.BITFIELD_CARRIER_CREDENTIAL_BINDINGS_JSON || '{}');
  } catch {
    throw new CarrierHttpEffectError('Carrier credential bindings are invalid.');
  }
  const environmentName = nonempty(record(bindings) ? bindings[credentialRef] : '');
  if (!environmentName || !/^[A-Z][A-Z0-9_]*$/.test(environmentName)) {
    throw new CarrierHttpEffectError('No sealed carrier credential is bound for this provider.');
  }
  return environmentName;
}

function allowedHosts(environment = process.env) {
  return new Set(String(environment.BITFIELD_CARRIER_HTTP_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean));
}

export function validateCarrierHttpEffect(effect, environment = process.env) {
  if (!record(effect) || effect.kind !== 'carrier-http-effect') {
    throw new CarrierHttpEffectError('Checkout engine did not return a carrier HTTP effect.');
  }
  if (!record(effect.request) || !record(effect.request.auth)) {
    throw new CarrierHttpEffectError('Carrier HTTP effect is missing its sealed credential reference.');
  }
  const operationId = nonempty(effect.operationId);
  const finalizeTarget = nonempty(effect.finalizeTarget);
  const credentialRef = nonempty(effect.request.auth.credentialRef);
  const scheme = nonempty(effect.request.auth.scheme).toLowerCase();
  const method = nonempty(effect.request.method).toUpperCase();
  if (!operationId || !finalizeTarget || !credentialRef || scheme !== 'bearer' || method !== 'POST') {
    throw new CarrierHttpEffectError('Carrier HTTP effect is incomplete.');
  }
  let url;
  try {
    url = new URL(effect.request.url);
  } catch {
    throw new CarrierHttpEffectError('Carrier HTTP effect has an invalid destination.');
  }
  const hosts = allowedHosts(environment);
  if (url.protocol !== 'https:' || hosts.size === 0 || !hosts.has(url.hostname.toLowerCase())) {
    throw new CarrierHttpEffectError('Carrier HTTP destination is not admitted by deployment DATA.');
  }
  const headers = record(effect.request.headers) ? { ...effect.request.headers } : {};
  if (Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
    throw new CarrierHttpEffectError('Carrier HTTP effect must not contain browser-visible credentials.');
  }
  const environmentName = credentialEnvironmentName(credentialRef, environment);
  const credential = nonempty(environment[environmentName]);
  if (!credential) throw new CarrierHttpEffectError('The sealed provider credential is unavailable.');
  return {
    credential,
    credentialRef,
    finalizeInput: record(effect.finalizeInput) ? effect.finalizeInput : {},
    finalizeTarget,
    headers,
    method,
    operationId,
    timeoutMs: Math.min(positiveInteger(effect.request.timeoutMs, DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS),
    url,
  };
}

async function boundedResponseText(response, maxBytes) {
  const chunks = [];
  let total = 0;
  if (!response.body) return '';
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new CarrierHttpEffectError('Provider response exceeded the carrier limit.');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function executeCarrierHttpEffect(effect, options = {}) {
  const environment = options.environment || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const invokeTarget = options.invokeTarget;
  if (typeof invokeTarget !== 'function') {
    throw new CarrierHttpEffectError('Carrier finalization target is unavailable.');
  }
  const admitted = validateCarrierHttpEffect(effect, environment);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), admitted.timeoutMs);
  let response;
  let body;
  try {
    response = await fetchImpl(admitted.url, {
      method: admitted.method,
      headers: {
        ...admitted.headers,
        Authorization: `Bearer ${admitted.credential}`,
      },
      body: typeof effect.request.body === 'string' ? effect.request.body : undefined,
      signal: controller.signal,
    });
    body = await boundedResponseText(
      response,
      positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES),
    );
  } catch (error) {
    if (error?.name === 'AbortError') throw new CarrierHttpEffectError('Provider request timed out.', 504);
    if (error instanceof CarrierHttpEffectError) throw error;
    throw new CarrierHttpEffectError('Provider transport failed before finalization.');
  } finally {
    clearTimeout(timer);
  }
  return invokeTarget(admitted.finalizeTarget, {
    ...admitted.finalizeInput,
    carrier_transport: 'finalize',
    transport_response: {
      bodyText: body,
      statusCode: response.status,
    },
  });
}
