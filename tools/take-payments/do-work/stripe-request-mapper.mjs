// tools/take-payments/do-work/stripe-request-mapper.mjs
//
// Generic operation→wire-shape mapper. The map of which operation_id becomes
// which HTTP method/path/subject lives in `read-data/stripe-operation-map.json` —
// DATA, not code: this module enumerates nothing.
// Adding a Stripe operation = one row in that JSON; this file never changes.
import operationMapData from '../read-data/stripe-operation-map.json' with { type: 'json' };

export const CURRENT_STRIPE_API_VERSION = operationMapData.current_api_version;

/** Compile DATA rows -> operation_id-keyed wire specs (admission-time step). */
function compileOperationMap(data) {
  return Object.fromEntries(
    (data?.operations || []).map((row) => [
      row.operation_id,
      {
        method: row.method,
        // The WHOLE address the vendor answers on, not a fragment. It used to
        // be a path composed onto a shared base, and that base could only ever
        // be right for some rows: this vendor serves more than one versioned
        // namespace, so one of them was already an exception living inside a
        // rule that claimed there were none.
        endpoint: row.endpoint,
        subjectKey: row.subject_key ?? null,
        objectRefKey: row.object_ref_key ?? null,
        // Whether this operation ends with the person on the provider's own
        // page. It is declared because the alternative was reading the URL and
        // recognising it, which makes the address a name: change where the
        // vendor answers and the handoff silently stops being reported.
        handsThePersonOff: row.hands_the_person_off === true,
        // Which input fact names the account this request acts for, and the header that says so. Declared, so a
        // request for a payee's balance is one row and the mapper never learns which operations act for whom.
        actsForAccount: row.acts_for_account ?? null,
      },
    ]),
  );
}

/** Default map from the package's shipped DATA file. */
const OPERATION_MAP = compileOperationMap(operationMapData);

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function providerObjectRef(value) {
  const row = record(value);
  return row.ref || row.id || value;
}

function endpointFor(spec, inputFacts) {
  if (!spec.endpoint) throw new Error('This operation does not say where the provider answers.');
  if (!spec.objectRefKey) return spec.endpoint;
  const ref = providerObjectRef(inputFacts[spec.objectRefKey]);
  if (!ref || typeof ref !== 'string') throw new Error(`Missing ${spec.objectRefKey}`);
  return spec.endpoint.replace('{provider_object_ref}', encodeURIComponent(ref));
}

// A read carries no body. A read that searches (list prices by lookup key, promotion codes by code) names
// its subject key, and that subject becomes the query string instead.
function queryFor(spec, inputFacts) {
  if (spec.method !== 'GET' || !spec.subjectKey) return null;
  const subject = record(inputFacts[spec.subjectKey]);
  return Object.keys(subject).length ? subject : null;
}

function bodyFor(spec, inputFacts) {
  if (spec.method === 'GET' || spec.method === 'DELETE') return {};
  const value = spec.subjectKey ? inputFacts[spec.subjectKey] : inputFacts;
  const subject = record(value);
  // The caller's internal subject `id` (e.g. a checkout-attempt id) is NOT a
  // Stripe create-param — Stripe server-assigns object ids and rejects an
  // unknown top-level `id` on create endpoints. Map it to client_reference_id
  // (the documented caller-correlation field) and drop the raw `id` from the
  // wire body.
  const { id: subjectId, ...rest } = subject;
  return {
    ...rest,
    ...(subjectId ? { client_reference_id: subjectId } : {}),
  };
}

// The account a request acts for, as { header, account }, when its row declares one and the caller named it.
function actingAccountFor(spec, inputFacts) {
  if (!spec.actsForAccount) return null;
  const account = inputFacts[spec.actsForAccount.input_fact];
  if (account === undefined || account === null || account === '') return null;
  if (typeof account !== 'string') throw new Error(`${spec.actsForAccount.input_fact} must be an account id`);
  return { header: spec.actsForAccount.header, account };
}

/**
 * @param {object} request - capability invocation (operation_id, input_facts, ...)
 * @param {object} [operationMapOverride] - optional caller-supplied operation-map
 *   DATA (same shape as data/stripe-operation-map.json) — the injected-capability
 *   seam; defaults to the package's shipped DATA file.
 */
export function mapCapabilityRequest(request, operationMapOverride) {
  const operationId = request?.operation_id || request?.operationId;
  const inputFacts = record(request?.input_facts || request?.inputFacts);
  const map = operationMapOverride ? compileOperationMap(operationMapOverride) : OPERATION_MAP;
  const spec = map[operationId];
  if (!spec) throw new Error(`Unsupported capability operation: ${operationId || 'missing'}`);
  const base = {
    operation_id: operationId,
    api_version: request?.api_version_policy || CURRENT_STRIPE_API_VERSION,
    idempotency_key: request?.idempotency_key,
  };

  return {
    ...base,
    method: spec.method,
    endpoint: endpointFor(spec, inputFacts),
    hands_the_person_off: spec.handsThePersonOff,
    body: bodyFor(spec, inputFacts),
    query: queryFor(spec, inputFacts),
    acting_account: actingAccountFor(spec, inputFacts),
  };
}
