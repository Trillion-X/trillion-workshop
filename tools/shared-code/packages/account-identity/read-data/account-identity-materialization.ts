import { makeHashCodeHexFromBytes } from '@bitfield/runtime-kit/protocol';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

type JsonObject = { [key: string]: JsonValue | undefined };

export type SourceRoleDescriptor = {
  role: string;
  input_key?: string;
  required?: boolean;
  shape?: string;
};

export type MaterializationRuleDescriptor = {
  role: string;
  method: string;
  source_role?: string;
  params?: JsonObject;
};

export type OutputRoleDescriptor = {
  role: string;
  label?: string;
  copyable?: boolean;
  hidden?: boolean;
  value: {
    from: 'source' | 'rule';
    role: string;
  };
};

export type RoleMaterializationSpec = {
  kind: 'role-addressed-materialization';
  source_roles: SourceRoleDescriptor[];
  rules: MaterializationRuleDescriptor[];
  output_roles: OutputRoleDescriptor[];
  projection?: {
    address_label?: string;
    value_to_bytes?: string;
  };
};

export type MaterializedRoleRow = {
  role: string;
  label: string;
  value: string;
  copyable: boolean;
  hidden: boolean;
};

export type RoleAddressedMaterializationRecord = {
  address: string;
  path: string[];
  payload: JsonObject;
};

export type RoleAddressedMaterializationResult = {
  kind: 'role-addressed-materialization-result';
  revision_key: string;
  roles: MaterializedRoleRow[];
  records: RoleAddressedMaterializationRecord[];
  projection: {
    address_label: string;
    value_to_bytes: string;
    rows: MaterializedRoleRow[];
  };
};

const textEncoder = new TextEncoder();
// ⛔ A COMPLETE HAND-WRITTEN SHA-256 USED TO LIVE HERE: these two constant tables, a
// `rotateRight`, and a sixty-line compression loop, all so `textHash` could return `1f:` plus the
// result. `1f` is the IETF multicodec code for BLAKE3, so every account identity this file minted
// DECLARED BLAKE3 AND CONTAINED SHA-256, and no reader could tell, because trusting the prefix is
// the entire reason a multihash carries one.
//
// THE VOLUME IS WHAT HID IT. Nobody audits sixty lines of bit-twiddling to work out which
// algorithm it implements; they read the function name. The name was `sha256Hex` and it was
// perfectly honest. The lie was one line away, at the call site, where an honest digest met a
// prefix nobody re-checked. A defect can hide behind correct code by being adjacent to it.
//
// All of it is deleted for one call to the implementation this repository already standardised on.

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be non-empty text.`);
  }
  return value.trim();
}

function readOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// ONE CALL PRODUCES BOTH THE DIGEST AND ITS LABEL, and that is the whole repair.
// The first version of this fix imported `@noble/hashes/blake3.js` and wrote `` `1f:${hex}` ``
// around it. That is honest today and it is the SAME SHAPE as the forgery it replaced: the
// caller picks the algorithm, the caller separately writes the code, and nothing ties the two
// together. Rotate the import and the label keeps saying `1f` with no error anywhere.
// `makeHashCodeHexFromBytes` is the JS binding to `bitfield_crypto::Multihash::hash(bytes)
// .to_code_hex()`, so the code is written BY the thing that produced the digest and a rotation
// changes both at once. A consumer must never be able to hold the two apart.
function textHash(value: string) {
  return makeHashCodeHexFromBytes(textEncoder.encode(value));
}


function decodeSpec(value: unknown): RoleMaterializationSpec {
  if (!isRecord(value) || value.kind !== 'role-addressed-materialization') {
    throw new Error('Materialization spec must be role-addressed-materialization.');
  }
  if (!Array.isArray(value.source_roles) || !Array.isArray(value.rules) || !Array.isArray(value.output_roles)) {
    throw new Error('Materialization spec must declare source_roles, rules, and output_roles.');
  }
  return value as RoleMaterializationSpec;
}

function sourceInputValue(input: unknown, descriptor: SourceRoleDescriptor) {
  const key = descriptor.input_key ?? descriptor.role;
  if (isRecord(input) && key in input) return input[key];
  if (descriptor.input_key === undefined) return input;
  return undefined;
}

function normalizeText(value: unknown, params: JsonObject | undefined) {
  if (typeof value !== 'string') {
    throw new Error(readOptionalString(params?.invalid_message) ?? 'Required text was not supplied.');
  }
  const trimmed = value.trim();
  const maxLength = typeof params?.max_length === 'number' ? params.max_length : undefined;
  const pattern = readOptionalString(params?.pattern);
  const normalized = params?.case === 'preserve' ? trimmed : trimmed.toLowerCase();
  if (!normalized || (maxLength !== undefined && normalized.length > maxLength)) {
    throw new Error(readOptionalString(params?.invalid_message) ?? 'Required text was not supplied.');
  }
  if (pattern && !(new RegExp(pattern).test(normalized))) {
    throw new Error(readOptionalString(params?.invalid_message) ?? 'Required text was not supplied.');
  }
  return normalized;
}

function deriveIdentifier(sourceValue: string, params: JsonObject | undefined) {
  const hashInputPrefix = readOptionalString(params?.hash_input_prefix) ?? '';
  const outputPrefix = readOptionalString(params?.output_prefix) ?? '';
  const dropPrefixChars = typeof params?.drop_hash_prefix_chars === 'number' ? params.drop_hash_prefix_chars : 0;
  return `${outputPrefix}${textHash(`${hashInputPrefix}${sourceValue}`).slice(dropPrefixChars)}`;
}

function executeRule(
  rule: MaterializationRuleDescriptor,
  sourceValues: Map<string, string>,
  ruleValues: Map<string, string>,
) {
  const sourceRole = readOptionalString(rule.source_role);
  const sourceValue = sourceRole
    ? sourceValues.get(sourceRole) ?? ruleValues.get(sourceRole)
    : undefined;
  if (rule.method === 'trim-lowercase-text') {
    return normalizeText(sourceValue, rule.params);
  }
  if (rule.method === 'content-hash-text') {
    if (typeof sourceValue !== 'string') {
      throw new Error(`Rule ${rule.role} requires a source role.`);
    }
    return deriveIdentifier(sourceValue, rule.params);
  }
  throw new Error(`Unsupported materialization method: ${rule.method}`);
}

function rowAddress(projectionAddress: string, role: string, revisionKey: string) {
  return `${projectionAddress}::row::${textHash(`${role}\n${revisionKey}`)}`;
}

export function materializeRoleAddressedRecords(
  rawSpec: unknown,
  input: unknown,
  resolvedRoles: ReadonlyMap<string, string> = new Map(),
): RoleAddressedMaterializationResult {
  const spec = decodeSpec(rawSpec);
  const sourceValues = new Map<string, string>();
  const ruleValues = new Map<string, string>();

  for (const source of spec.source_roles) {
    const value = sourceInputValue(input, source);
    if (source.required !== false || value !== undefined) {
      sourceValues.set(source.role, normalizeText(value, { case: 'preserve' }));
    }
  }
  for (const rule of spec.rules) {
    ruleValues.set(rule.role, resolvedRoles.get(rule.role) ?? executeRule(rule, sourceValues, ruleValues));
  }

  const rows = spec.output_roles.map((output) => {
    const values = output.value.from === 'source' ? sourceValues : ruleValues;
    const value = values.get(output.value.role);
    if (typeof value !== 'string') {
      throw new Error(`Output role ${output.role} could not be materialized.`);
    }
    return {
      role: output.role,
      label: output.label ?? output.role,
      value,
      copyable: output.copyable === true,
      hidden: output.hidden === true,
    };
  });

  const revisionKey = textHash(JSON.stringify({
    source: Array.from(sourceValues.entries()),
    rules: Array.from(ruleValues.entries()),
    outputs: rows.map((row) => [row.role, row.value]),
  }));
  const projectionAddress = spec.projection?.address_label ?? 'package::account-identity::projection::roles';
  const records = rows.map((row) => ({
    address: rowAddress(projectionAddress, row.role, revisionKey),
    path: ['packages', 'account-identity', 'materialized-roles', row.role],
    payload: {
      kind: 'role-addressed-materialization-row',
      revision_key: revisionKey,
      role: row.role,
      label: row.label,
      value: row.value,
      copyable: row.copyable,
      hidden: row.hidden,
    },
  }));

  return {
    kind: 'role-addressed-materialization-result',
    revision_key: revisionKey,
    roles: rows,
    records,
    projection: {
      address_label: projectionAddress,
      value_to_bytes: spec.projection?.value_to_bytes ?? 'cell_table',
      rows,
    },
  };
}

export function decodeRoleAddressedMaterializationResult(
  value: unknown,
): RoleAddressedMaterializationResult {
  const parsed = ArrayBuffer.isView(value)
    ? JSON.parse(new TextDecoder().decode(value as Uint8Array) || '{}')
    : typeof value === 'string'
      ? JSON.parse(value || '{}')
      : value;
  if (!isRecord(parsed) || parsed.kind !== 'role-addressed-materialization-result' || !Array.isArray(parsed.roles)) {
    throw new Error('Account identity target did not return role-addressed materialization.');
  }
  return parsed as RoleAddressedMaterializationResult;
}

export function readMaterializedRoleValue(value: unknown, role: string) {
  const result = decodeRoleAddressedMaterializationResult(value);
  const row = result.roles.find((candidate) => candidate.role === role);
  if (!row || typeof row.value !== 'string' || !row.value.trim()) {
    throw new Error(`Account identity target did not return required role ${role}.`);
  }
  return row.value;
}
