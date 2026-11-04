// packages/service-connections/read-data/owner-record-work-contract.ts
//
// Package-local interpreter for the owner-owned generic record work contract.
// The executable vocabulary is generic: records, columns, facts, actions,
// secrets. Service/provider/status meanings stay in package data.

import packageBoundary from '../work-contract.json';

export type OwnerRecordColumnDescriptor = {
  key: string;
  column: number;
  required?: boolean;
  value?: 'text' | 'boolean_text' | 'json_string_array' | 'json';
};

export type OwnerRecordWorkContract = {
  kind: 'owner-record-work-contract';
  id: string;
  record: {
    id_field: string;
    view_address: string;
    columns: OwnerRecordColumnDescriptor[];
  };
  writer: {
    entity_path: string[];
    entity_type_path: string[];
    fact_path: string[];
    value_type_id: string;
    entity_type_id: string;
    fact_properties: Record<string, string>;
    state_facts: Record<string, Record<string, unknown>>;
  };
  secret: {
    name_prefix: string;
    submission_handle_ttl_seconds: number;
    verification_handle_ttl_seconds: number;
  };
};

export type OwnerRecordWorkActionDescriptor = {
  kind: 'owner-record-work-action-descriptor';
  id: string;
  operation: string;
  target: string;
  definition_id: string;
  include_steps: boolean;
  include_output: boolean;
  accepted_statuses: string[];
};

type PackageThing = {
  address?: unknown;
  payload?: unknown;
};

type PackageBoundary = {
  things?: PackageThing[];
};

export type OwnerRecordFactWrite = {
  address: string;
  path: string[];
  payload: {
    property_id: string;
    subject_id: string;
    table: 'attribute_fact';
    type_id: string;
    value_json: string;
  };
};

export type OwnerRecordEntityWrite = {
  address: string;
  path: string[];
  payload: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function payloadRecords(kind: string): Record<string, unknown>[] {
  const boundary = packageBoundary as PackageBoundary;
  return (boundary.things ?? [])
    .map((thing) => thing.payload)
    .filter((payload): payload is Record<string, unknown> =>
      isRecord(payload) && payload.kind === kind,
    );
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Owner record work contract has invalid ${field}.`);
  }
  return value as string[];
}

/**
 * Validate one `owner-record-work-contract` DATA payload into the typed
 * contract. `ownerRecordWorkContract()` applies it to this package's manifest;
 * a host that carries the payload itself (the hosted Workshop) applies it
 * directly and never bundles the manifest.
 */
export function readOwnerRecordWorkContract(value: Record<string, unknown>): OwnerRecordWorkContract {
  if (!isRecord(value.record) || !isRecord(value.writer) || !isRecord(value.secret)) {
    throw new Error('Owner record work contract is missing record, writer, or secret data.');
  }
  if (!Array.isArray(value.record.columns)) {
    throw new Error('Owner record work contract is missing column descriptors.');
  }
  const columns = value.record.columns.map((column) => {
    if (!isRecord(column) || typeof column.key !== 'string' || typeof column.column !== 'number') {
      throw new Error('Owner record work contract has an invalid column descriptor.');
    }
    return {
      key: column.key,
      column: column.column,
      ...(typeof column.required === 'boolean' ? { required: column.required } : {}),
      ...(typeof column.value === 'string' ? { value: column.value as OwnerRecordColumnDescriptor['value'] } : {}),
    };
  });
  if (!isRecord(value.writer.fact_properties)) {
    throw new Error('Owner record work contract is missing fact property descriptors.');
  }

  return {
    kind: 'owner-record-work-contract',
    id: typeof value.id === 'string' ? value.id : '',
    record: {
      id_field: typeof value.record.id_field === 'string' ? value.record.id_field : 'id',
      view_address: typeof value.record.view_address === 'string' ? value.record.view_address : '',
      columns,
    },
    writer: {
      entity_path: assertStringArray(value.writer.entity_path, 'entity_path'),
      entity_type_path: assertStringArray(value.writer.entity_type_path, 'entity_type_path'),
      fact_path: assertStringArray(value.writer.fact_path, 'fact_path'),
      value_type_id: typeof value.writer.value_type_id === 'string'
        ? value.writer.value_type_id
        : 'type:json',
      entity_type_id: typeof value.writer.entity_type_id === 'string'
        ? value.writer.entity_type_id
        : 'type:connection',
      fact_properties: Object.fromEntries(
        Object.entries(value.writer.fact_properties)
          .filter((entry): entry is [string, string] =>
            typeof entry[0] === 'string' && typeof entry[1] === 'string',
          ),
      ),
      state_facts: Object.fromEntries(
        Object.entries(isRecord(value.writer.state_facts) ? value.writer.state_facts : {})
          .filter((entry): entry is [string, Record<string, unknown>] =>
            typeof entry[0] === 'string' && isRecord(entry[1]),
          ),
      ),
    },
    secret: {
      name_prefix: typeof value.secret.name_prefix === 'string' ? value.secret.name_prefix : '',
      submission_handle_ttl_seconds: typeof value.secret.submission_handle_ttl_seconds === 'number'
        ? value.secret.submission_handle_ttl_seconds
        : 3600,
      verification_handle_ttl_seconds: typeof value.secret.verification_handle_ttl_seconds === 'number'
        ? value.secret.verification_handle_ttl_seconds
        : 300,
    },
  };
}

export function ownerRecordWorkContract(): OwnerRecordWorkContract {
  const [contract] = payloadRecords('owner-record-work-contract');
  if (!contract) {
    throw new Error('Service Connections owner record work contract is not published.');
  }
  return readOwnerRecordWorkContract(contract);
}

export function ownerRecordWorkActionDescriptor(
  operation: string,
): OwnerRecordWorkActionDescriptor {
  const descriptor = payloadRecords('owner-record-work-action-descriptor')
    .find((payload) => payload.operation === operation);
  if (!descriptor) {
    throw new Error(`Service Connections owner action descriptor is missing: ${operation}.`);
  }
  if (
    typeof descriptor.id !== 'string'
    || typeof descriptor.target !== 'string'
    || typeof descriptor.definition_id !== 'string'
    || !Array.isArray(descriptor.accepted_statuses)
  ) {
    throw new Error(`Service Connections owner action descriptor is invalid: ${operation}.`);
  }

  return {
    kind: 'owner-record-work-action-descriptor',
    id: descriptor.id,
    operation,
    target: descriptor.target,
    definition_id: descriptor.definition_id,
    include_steps: descriptor.include_steps === true,
    include_output: descriptor.include_output === true,
    accepted_statuses: descriptor.accepted_statuses
      .filter((status): status is string => typeof status === 'string'),
  };
}

export function ownerRecordColumnByKey(
  contract: OwnerRecordWorkContract,
): Map<string, OwnerRecordColumnDescriptor> {
  return new Map(contract.record.columns.map((column) => [column.key, column]));
}

export function ownerRecordFact(
  contract: OwnerRecordWorkContract,
  subjectId: string,
  fieldKey: string,
  value: unknown,
): OwnerRecordFactWrite {
  const propertyId = contract.writer.fact_properties[fieldKey];
  if (!propertyId) {
    throw new Error(`Owner record work contract has no fact property for ${fieldKey}.`);
  }
  return {
    address: `attribute_fact|${subjectId}|${propertyId}|${contract.writer.value_type_id}`,
    path: [...contract.writer.fact_path],
    payload: {
      property_id: propertyId,
      subject_id: subjectId,
      table: 'attribute_fact',
      type_id: contract.writer.value_type_id,
      value_json: JSON.stringify(value),
    },
  };
}

export function ownerRecordStateFacts(
  contract: OwnerRecordWorkContract,
  subjectId: string,
  stateKey: string,
): OwnerRecordFactWrite[] {
  const stateFacts = contract.writer.state_facts[stateKey];
  if (!stateFacts) {
    throw new Error(`Owner record work contract has no state facts for ${stateKey}.`);
  }
  return Object.entries(stateFacts).map(([fieldKey, value]) =>
    ownerRecordFact(contract, subjectId, fieldKey, value),
  );
}

export function declaredStateEffectFacts(
  effects: readonly { subjectId: string; propertyId: string; value: unknown }[] | undefined,
): OwnerRecordFactWrite[] {
  return (effects ?? []).map((effect) => ({
    address: `attribute_fact|${effect.subjectId}|${effect.propertyId}|type:json`,
    // Live connection outcomes are consumed immediately by provider routing.
    // A property-specific fold-input path is invisible to the live
    // published-record query until some later materializer happens to run.
    path: ['current-item', 'published-record'],
    payload: {
      property_id: effect.propertyId,
      subject_id: effect.subjectId,
      table: 'attribute_fact' as const,
      type_id: 'type:json',
      value_json: JSON.stringify(effect.value),
    },
  }));
}

export function ownerRecordEntityWrites(
  contract: OwnerRecordWorkContract,
  subjectId: string,
): OwnerRecordEntityWrite[] {
  return [
    {
      address: `entity|${subjectId}`,
      path: [...contract.writer.entity_path],
      payload: { id: subjectId, table: 'entity' },
    },
    {
      address: `entity_types|${subjectId}|${contract.writer.entity_type_id}`,
      path: [...contract.writer.entity_type_path],
      payload: {
        entity_id: subjectId,
        table: 'entity_types',
        type_id: contract.writer.entity_type_id,
      },
    },
  ];
}
