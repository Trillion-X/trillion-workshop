import { readAccountGrantedAccessProjection } from './read-account-granted-access-refs';

export const ADDRESSED_EXPIRING_VALUE_SCOPE_AUTH_TARGET =
  'product-access.authorize-addressed-expiring-value-scope';
export const ADDRESSED_EXPIRING_VALUE_SCOPE_SCHEMA =
  'addressed-expiring-value-scope/v1';

const MAX_REQUEST_BYTES = 32 * 1_024;
const MAX_SCOPE_BYTES = 4 * 1_024;
const MAX_IDENTITY_REF_BYTES = 4 * 1_024;
const MAX_VALUE_REF_BYTES = 4 * 1_024;
const MAX_OPERATION_BYTES = 1 * 1_024;
const MAX_ACCESS_REF_BYTES = 1 * 1_024;
const MAX_REQUIRED_ACCESS_REFS = 128;
const TOP_LEVEL_FIELDS = new Set([
  'principal_ref',
  'principal',
  'session_ref',
  'session',
  'operation',
  'scope',
]);
const SCOPE_FIELDS = new Set([
  'schema',
  'value_ref',
  'instance_ref',
  'required_access_refs',
]);

export type AddressedExpiringValueScopeAuthorityReply = {
  authorized: boolean;
  membership_revision?: string;
};

export type AddressedExpiringValueScope = {
  schema: typeof ADDRESSED_EXPIRING_VALUE_SCOPE_SCHEMA;
  value_ref: string;
  instance_ref: string;
  required_access_refs: string[];
};

type ScopeAuthorizationRequest = {
  principalRef: string;
  sessionRef: string;
  operation: string;
  scope: AddressedExpiringValueScope;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedText(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (!normalized || utf8Length(normalized) > maximumBytes) return '';
  return normalized;
}

function hasOnlyFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function decodeJsonBytes(value: unknown, maximumBytes: number): unknown {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) return null;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function decodeRequestSource(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (
    value instanceof Uint8Array
    || value instanceof ArrayBuffer
    || ArrayBuffer.isView(value)
  ) {
    parsed = decodeJsonBytes(value, MAX_REQUEST_BYTES);
  } else if (typeof value === 'string') {
    if (utf8Length(value) > MAX_REQUEST_BYTES) return null;
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  } else {
    try {
      if (utf8Length(JSON.stringify(value)) > MAX_REQUEST_BYTES) return null;
    } catch {
      return null;
    }
  }
  return isRecord(parsed) ? parsed : null;
}

function exactByteArray(value: unknown): Uint8Array | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_BYTES) {
    return null;
  }
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    bytes[index] = byte;
  }
  return bytes;
}

function canonicalBase64Bytes(value: string): Uint8Array | null {
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > Math.ceil(MAX_SCOPE_BYTES / 3) * 4
    || normalized.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)
  ) {
    return null;
  }
  try {
    const bytes = Uint8Array.from(Buffer.from(normalized, 'base64'));
    if (
      bytes.byteLength === 0
      || bytes.byteLength > MAX_SCOPE_BYTES
      || Buffer.from(bytes).toString('base64') !== normalized
    ) {
      return null;
    }
    return bytes;
  } catch {
    return null;
  }
}

function decodeScopeBytes(value: unknown): unknown {
  const directBytes =
    exactByteArray(value)
    ?? (
      value instanceof Uint8Array
      || value instanceof ArrayBuffer
      || ArrayBuffer.isView(value)
        ? new Uint8Array(
            value instanceof ArrayBuffer ? value : value.buffer,
            value instanceof ArrayBuffer ? 0 : value.byteOffset,
            value instanceof ArrayBuffer ? value.byteLength : value.byteLength,
          )
        : null
    );
  if (directBytes) return decodeJsonBytes(directBytes, MAX_SCOPE_BYTES);
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (text.startsWith('{')) {
    if (utf8Length(text) > MAX_SCOPE_BYTES) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  const base64Bytes = canonicalBase64Bytes(text);
  return base64Bytes ? decodeJsonBytes(base64Bytes, MAX_SCOPE_BYTES) : null;
}

function aliasedIdentityRef(
  input: Record<string, unknown>,
  canonicalField: 'principal_ref' | 'session_ref',
  shellField: 'principal' | 'session',
): string {
  const canonical = input[canonicalField] === undefined
    ? ''
    : boundedText(input[canonicalField], MAX_IDENTITY_REF_BYTES);
  const shell = input[shellField] === undefined
    ? ''
    : boundedText(input[shellField], MAX_IDENTITY_REF_BYTES);
  if (
    (input[canonicalField] !== undefined && !canonical)
    || (input[shellField] !== undefined && !shell)
    || (canonical && shell && canonical !== shell)
  ) {
    return '';
  }
  return canonical || shell;
}

function readRequiredAccessRefs(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_REQUIRED_ACCESS_REFS) return null;
  const refs = new Set<string>();
  for (const rawRef of value) {
    const ref = boundedText(rawRef, MAX_ACCESS_REF_BYTES);
    if (!ref) return null;
    refs.add(ref);
  }
  return [...refs];
}

export function decodeAddressedExpiringValueScope(
  value: unknown,
): AddressedExpiringValueScope | null {
  const source = decodeScopeBytes(value);
  if (!isRecord(source) || !hasOnlyFields(source, SCOPE_FIELDS)) return null;
  if (source.schema !== ADDRESSED_EXPIRING_VALUE_SCOPE_SCHEMA) return null;
  const valueRef = boundedText(source.value_ref, MAX_VALUE_REF_BYTES);
  const instanceRef = boundedText(source.instance_ref, MAX_VALUE_REF_BYTES);
  const requiredAccessRefs = readRequiredAccessRefs(source.required_access_refs);
  if (!valueRef || !instanceRef || requiredAccessRefs === null) return null;
  return {
    schema: ADDRESSED_EXPIRING_VALUE_SCOPE_SCHEMA,
    value_ref: valueRef,
    instance_ref: instanceRef,
    required_access_refs: requiredAccessRefs,
  };
}

function decodeAuthorizationRequest(value: unknown): ScopeAuthorizationRequest | null {
  const source = decodeRequestSource(value);
  if (!source || !hasOnlyFields(source, TOP_LEVEL_FIELDS)) return null;
  const principalRef = aliasedIdentityRef(source, 'principal_ref', 'principal');
  const sessionRef = aliasedIdentityRef(source, 'session_ref', 'session');
  const operation = boundedText(source.operation, MAX_OPERATION_BYTES);
  const scope = decodeAddressedExpiringValueScope(source.scope);
  if (
    !principalRef
    || !sessionRef
    || !operation
    || !scope
  ) {
    return null;
  }
  return {
    principalRef,
    sessionRef,
    operation,
    scope,
  };
}

export async function authorizeAddressedExpiringValueScope(
  input: unknown,
): Promise<AddressedExpiringValueScopeAuthorityReply> {
  try {
    const request = decodeAuthorizationRequest(input);
    if (!request) return { authorized: false };
    if (request.scope.required_access_refs.length === 0) {
      return {
        authorized: true,
        membership_revision: 'membership-revision:ungated',
      };
    }

    const projection = await readAccountGrantedAccessProjection(request.principalRef);
    const granted = new Set(projection.granted_access_refs);
    return {
      authorized: request.scope.required_access_refs.some((ref) => granted.has(ref)),
      membership_revision: projection.membership_revision,
    };
  } catch {
    return { authorized: false };
  }
}

export const authorizeAddressedExpiringValueScopeTarget =
  authorizeAddressedExpiringValueScope;
