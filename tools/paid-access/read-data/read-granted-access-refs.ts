// tools/paid-access/read-data/read-granted-access-refs.ts
//
// The one place that answers "which access refs does ONE person hold from the grants written for them?". Ported from
// bitfield-packages packages/product-access (read-data/read-granted-access-refs.ts), the body unchanged.
//
// A grant is an effect row `{ kind: 'license_access', object: <access ref>, subject, material: { grant_ref,
// valid_from_ms?, expires_at_ms? } }`; a revoke, refund or supersede names the grant it ends in
// `material.revokes_grant_ref`. The person writes these as `access-grant` records (a gift, a comp, a time-limited
// pass); who-holds-access.mjs reads them with the person's payment-derived access and answers one list. The package
// read them from a signed-event authority; that authority is not carried.
//
// Pure and clock-free: callers supply the authoritative `now_ms`. An expiring grant with a missing, invalid or
// inverted window is never held (fail closed); a grant with no window at all is a lasting grant.

type EffectLike = { kind?: unknown; object?: unknown; material?: unknown };
type ListEffectsReply = { effects?: EffectLike[] };

export type GrantedAccessProjection = {
  granted_access_refs: string[];
  membership_revision_input: string;
};

const LICENSE_ACCESS_KIND = 'license_access';
const TERMINAL_KINDS = new Set(['revoke', 'refund', 'supersede']);

function str(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function refFromEffect(effect: EffectLike): string {
  const material = asRecord(effect.material);
  return str(effect.object) || str(material.capability_ref) || str(material.access_ref);
}

function terminalFromEffect(effect: EffectLike): { target_ref: string } | null {
  const material = asRecord(effect.material);
  const terminal = asRecord(material.terminal);
  const terminalKind = str(terminal.kind) || str(material.terminal_kind) || (TERMINAL_KINDS.has(str(effect.kind)) ? str(effect.kind) : '');
  if (!TERMINAL_KINDS.has(terminalKind)) return null;
  return {
    target_ref: str(material.revokes_grant_ref) || str(terminal.revokes_grant_ref) || str(terminal.supersedes_grant_ref),
  };
}

function stableUnknownKey(value: unknown, present: boolean): string {
  if (!present) return 'missing';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:NaN';
    if (value === Infinity) return 'number:Infinity';
    if (value === -Infinity) return 'number:-Infinity';
    return `number:${value}`;
  }
  if (typeof value === 'string') return `string:${value}`;
  if (typeof value === 'boolean') return `boolean:${value}`;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return `invalid:${Object.prototype.toString.call(value)}`;
}

function instanceRef(effect: EffectLike, material: Record<string, unknown>, explicitTargetRef = ''): string {
  const grantRef = explicitTargetRef || str(material.grant_ref);
  if (grantRef) return `grant:${grantRef}`;
  const accessRef = refFromEffect(effect);
  if (!accessRef) return '';
  return `legacy:${JSON.stringify([accessRef, stableUnknownKey(material.valid_from_ms, hasOwn(material, 'valid_from_ms'))])}`;
}

function stableCandidate(value: object): string {
  return JSON.stringify(value);
}

/**
 * Instance-grain entitlement projection plus canonical membership revision input.
 * Pure and clock-free: callers supply the authoritative `now_ms`.
 */
export function grantedAccessProjectionFromEffects(
  source: ListEffectsReply | EffectLike[] | null | undefined,
  now_ms?: unknown,
): GrantedAccessProjection {
  const effects = Array.isArray(source) ? source : (source?.effects ?? []);
  const terminatedInstanceRefs = new Set<string>();
  const candidatesByInstanceRef = new Map<string, Map<string, {
    instance_ref: string;
    access_ref: string;
    expiring: boolean;
    valid_from_ms: number | null;
    expires_at_ms: number | null;
    invalid_time: boolean;
  }>>();

  for (const effect of effects) {
    const kind = str(effect.kind);
    if (kind !== LICENSE_ACCESS_KIND && !TERMINAL_KINDS.has(kind)) continue;
    const material = asRecord(effect.material);
    const terminal = terminalFromEffect(effect);
    const negative = material.access_granted === false || terminal !== null;

    if (negative) {
      const targetRef = terminal?.target_ref || str(material.revokes_grant_ref);
      const targetInstanceRef = instanceRef(effect, material, targetRef);
      if (targetInstanceRef) terminatedInstanceRefs.add(targetInstanceRef);
      continue;
    }

    if (str(effect.kind) !== LICENSE_ACCESS_KIND) continue;
    const accessRef = refFromEffect(effect);
    const candidateInstanceRef = instanceRef(effect, material);
    if (!accessRef || !candidateInstanceRef) continue;

    const expiring = hasOwn(material, 'expires_at_ms') || hasOwn(material, 'valid_from_ms');
    const validFromMs = finiteNumber(material.valid_from_ms);
    const expiresAtMs = finiteNumber(material.expires_at_ms);
    const invalidTime = expiring && (
      validFromMs === null
      || expiresAtMs === null
      || expiresAtMs <= validFromMs
    );
    const candidate = {
      instance_ref: candidateInstanceRef,
      access_ref: accessRef,
      expiring,
      valid_from_ms: validFromMs,
      expires_at_ms: expiresAtMs,
      invalid_time: invalidTime,
    };
    const candidates = candidatesByInstanceRef.get(candidateInstanceRef) ?? new Map();
    candidates.set(stableCandidate(candidate), candidate);
    candidatesByInstanceRef.set(candidateInstanceRef, candidates);
  }

  const authoritativeNowMs = finiteNumber(now_ms);
  const instances = [...candidatesByInstanceRef.entries()]
    .map(([candidateInstanceRef, candidates]) => {
      if (candidates.size === 1) return candidates.values().next().value!;
      return {
        instance_ref: candidateInstanceRef,
        access_ref: '',
        expiring: true,
        valid_from_ms: null,
        expires_at_ms: null,
        invalid_time: true,
      };
    })
    .map((candidate) => {
      const terminated = terminatedInstanceRefs.has(candidate.instance_ref);
      const timeValid = !candidate.expiring || (
        !candidate.invalid_time
        && authoritativeNowMs !== null
        && candidate.valid_from_ms !== null
        && candidate.expires_at_ms !== null
        && candidate.valid_from_ms <= authoritativeNowMs
        && authoritativeNowMs < candidate.expires_at_ms
      );
      return { ...candidate, terminated, held: !terminated && timeValid };
    })
    .sort((left, right) => stableCandidate(left) < stableCandidate(right) ? -1 : stableCandidate(left) > stableCandidate(right) ? 1 : 0);

  const grantedAccessRefs = [...new Set(instances.filter((instance) => instance.held).map((instance) => instance.access_ref))].sort();
  return {
    granted_access_refs: grantedAccessRefs,
    membership_revision_input: JSON.stringify({
      instances,
      terminated_instance_refs: [...terminatedInstanceRefs].sort(),
    }),
  };
}

/**
 * The capability access refs an account holds, derived from its list-effects response.
 * Legacy non-expiring effects remain held when `now_ms` is absent.
 */
export function grantedAccessRefsFromEffects(
  source: ListEffectsReply | EffectLike[] | null | undefined,
  now_ms?: unknown,
): string[] {
  return grantedAccessProjectionFromEffects(source, now_ms).granted_access_refs;
}
