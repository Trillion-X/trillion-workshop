import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DIRECT_VIEW_DATA_CATALOG_PATH = resolve(
  SOURCE_ROOT,
  'direct-view-data-catalog.json',
);

const SELECTED_MODEL_DOMAIN = Buffer.from('visual-database.selected-model/v1\0', 'utf8');
const DATA_CATALOG_SCHEMA = 'visual-database.direct-view-data-catalog/v1';
const VIEW_DESCRIPTOR_KEYS = [
  'id',
  'label',
  'kind',
  'order',
  'filters',
  'projectionRules',
  'visibility',
  'sourceDatasetAddress',
];
const EVALUATOR_DESCRIPTOR_KEYS = [
  'ref',
  'target',
  'revision',
  'policy_revision',
  'authoring_label',
  'display_label',
  'request_template',
  'source_path',
  'result_path',
];

export function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function uint64be(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function selectedModelSha256(viewBytes, datasetBytes) {
  return sha256(Buffer.concat([
    SELECTED_MODEL_DOMAIN,
    uint64be(viewBytes.length),
    viewBytes,
    uint64be(datasetBytes.length),
    datasetBytes,
  ]));
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expectedKeys, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} keys must be exactly ${expected.join(', ')}`);
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredPath(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty path`);
  }
  return value.map((segment, index) => requiredString(segment, `${label}[${index}]`));
}

function uniqueIndex(rows, keyOf, label) {
  const index = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (index.has(key)) throw new Error(`${label} contains duplicate ${key}`);
    index.set(key, row);
  }
  return index;
}

function assertExactSet(actualValues, expectedValues, label) {
  const actual = [...new Set(actualValues)].sort();
  const expected = [...new Set(expectedValues)].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter((value) => !actual.includes(value));
    const extra = actual.filter((value) => !expected.includes(value));
    throw new Error(
      `${label} must match exactly; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`,
    );
  }
}

function evaluatorInputIndexes(evaluatorInputs) {
  assertExactKeys(evaluatorInputs, [
    'schema',
    'evaluator_descriptors',
    'view_evaluator_selections',
    'dataset_request_overrides',
  ], 'evaluator inputs');
  requiredString(evaluatorInputs.schema, 'evaluator inputs schema');
  for (const key of [
    'evaluator_descriptors',
    'view_evaluator_selections',
    'dataset_request_overrides',
  ]) {
    if (!Array.isArray(evaluatorInputs[key])) throw new Error(`${key} must be an array`);
  }

  evaluatorInputs.evaluator_descriptors.forEach((descriptor, index) => {
    assertExactKeys(descriptor, EVALUATOR_DESCRIPTOR_KEYS, `evaluator_descriptors[${index}]`);
    for (const key of EVALUATOR_DESCRIPTOR_KEYS.slice(0, 6)) {
      requiredString(descriptor[key], `evaluator_descriptors[${index}].${key}`);
    }
    if (!plainObject(descriptor.request_template)) {
      throw new Error(`evaluator_descriptors[${index}].request_template must be an object`);
    }
    requiredPath(descriptor.source_path, `evaluator_descriptors[${index}].source_path`);
    requiredPath(descriptor.result_path, `evaluator_descriptors[${index}].result_path`);
  });

  evaluatorInputs.view_evaluator_selections.forEach((selection, index) => {
    assertExactKeys(
      selection,
      ['view_id', 'evaluator_descriptor_ref', 'admitted_evaluator_descriptor_refs'],
      `view_evaluator_selections[${index}]`,
    );
    requiredString(selection.view_id, `view_evaluator_selections[${index}].view_id`);
    requiredString(
      selection.evaluator_descriptor_ref,
      `view_evaluator_selections[${index}].evaluator_descriptor_ref`,
    );
    if (!Array.isArray(selection.admitted_evaluator_descriptor_refs)
      || selection.admitted_evaluator_descriptor_refs.length === 0) {
      throw new Error(
        `view_evaluator_selections[${index}].admitted_evaluator_descriptor_refs must be a non-empty array`,
      );
    }
    const admitted = selection.admitted_evaluator_descriptor_refs.map((ref, refIndex) => (
      requiredString(
        ref,
        `view_evaluator_selections[${index}].admitted_evaluator_descriptor_refs[${refIndex}]`,
      )
    ));
    if (new Set(admitted).size !== admitted.length) {
      throw new Error(
        `view_evaluator_selections[${index}].admitted_evaluator_descriptor_refs must be unique`,
      );
    }
    if (!admitted.includes(selection.evaluator_descriptor_ref)) {
      throw new Error(
        `view_evaluator_selections[${index}] must admit its selected evaluator descriptor`,
      );
    }
  });

  evaluatorInputs.dataset_request_overrides.forEach((override, index) => {
    assertExactKeys(
      override,
      ['source_dataset_address', 'request'],
      `dataset_request_overrides[${index}]`,
    );
    requiredString(
      override.source_dataset_address,
      `dataset_request_overrides[${index}].source_dataset_address`,
    );
    if (!plainObject(override.request)) {
      throw new Error(`dataset_request_overrides[${index}].request must be an object`);
    }
  });

  return {
    descriptors: uniqueIndex(
      evaluatorInputs.evaluator_descriptors,
      (descriptor) => descriptor.ref,
      'evaluator_descriptors',
    ),
    selections: uniqueIndex(
      evaluatorInputs.view_evaluator_selections,
      (selection) => selection.view_id,
      'view_evaluator_selections',
    ),
    requestOverrides: uniqueIndex(
      evaluatorInputs.dataset_request_overrides,
      (entry) => entry.source_dataset_address,
      'dataset_request_overrides',
    ),
  };
}

function proofCatalogIndexes(catalog) {
  if (!Array.isArray(catalog?.views)) throw new Error('Catalog views must be an array');
  const views = uniqueIndex(
    catalog.views,
    (row, index) => requiredString(row?.view_id, `catalog.views[${index}].view_id`),
    'catalog views',
  );
  catalog.views.forEach((row, index) => {
    requiredString(
      row.source_dataset_address,
      `catalog.views[${index}].source_dataset_address`,
    );
    requiredString(row.durable_record_id, `catalog.views[${index}].durable_record_id`);
    requiredPath(row.path_labels, `catalog.views[${index}].path_labels`);
  });
  return views;
}

function dataCatalogIndexes(dataCatalog, proofViews) {
  assertExactKeys(dataCatalog, ['schema', 'views', 'datasets'], 'direct view data catalog');
  if (dataCatalog.schema !== DATA_CATALOG_SCHEMA) {
    throw new Error(`Unsupported direct view data catalog schema ${String(dataCatalog.schema)}`);
  }
  if (!Array.isArray(dataCatalog.views)) {
    throw new Error('direct view data catalog views must be an array');
  }
  if (!Array.isArray(dataCatalog.datasets)) {
    throw new Error('direct view data catalog datasets must be an array');
  }

  const dataViews = uniqueIndex(
    dataCatalog.views,
    (row, index) => {
      assertExactKeys(row, ['view_id', 'descriptor'], `data views[${index}]`);
      return requiredString(row.view_id, `data views[${index}].view_id`);
    },
    'data views',
  );
  assertExactSet(dataViews.keys(), proofViews.keys(), 'data view ids');

  for (const [viewId, row] of dataViews) {
    assertExactKeys(row.descriptor, VIEW_DESCRIPTOR_KEYS, `data view ${viewId} descriptor`);
    if (row.descriptor.id !== viewId) {
      throw new Error(`data view ${viewId} descriptor id must equal its view_id`);
    }
    const proofRow = proofViews.get(viewId);
    if (row.descriptor.sourceDatasetAddress !== proofRow.source_dataset_address) {
      throw new Error(`data view ${viewId} source dataset does not match proof catalog`);
    }
    requiredString(row.descriptor.label, `data view ${viewId} descriptor.label`);
    requiredString(row.descriptor.kind, `data view ${viewId} descriptor.kind`);
    requiredString(row.descriptor.visibility, `data view ${viewId} descriptor.visibility`);
    if (!Number.isFinite(row.descriptor.order)) {
      throw new Error(`data view ${viewId} descriptor.order must be finite`);
    }
    for (const key of ['filters', 'projectionRules']) {
      if (!Array.isArray(row.descriptor[key])) {
        throw new Error(`data view ${viewId} descriptor.${key} must be an array`);
      }
    }
  }

  const datasets = uniqueIndex(
    dataCatalog.datasets,
    (row, index) => {
      assertExactKeys(row, ['address', 'payload_template'], `data datasets[${index}]`);
      if (!plainObject(row.payload_template)) {
        throw new Error(`data datasets[${index}].payload_template must be an object`);
      }
      return requiredString(row.address, `data datasets[${index}].address`);
    },
    'data datasets',
  );
  assertExactSet(
    datasets.keys(),
    [...proofViews.values()].map((row) => row.source_dataset_address),
    'data dataset addresses',
  );
  return { dataViews, datasets };
}

function evaluatorSelectionsByDataset(proofViews, descriptors, selections) {
  assertExactSet(selections.keys(), proofViews.keys(), 'evaluator selection view ids');
  const byAddress = new Map();
  const usedDescriptorRefs = new Set();
  for (const [viewId, proofRow] of proofViews) {
    const selection = selections.get(viewId);
    const sourceEvaluator = descriptors.get(selection.evaluator_descriptor_ref);
    if (!sourceEvaluator) {
      throw new Error(
        `View ${viewId} selects unknown evaluator descriptor ${selection.evaluator_descriptor_ref}`,
      );
    }
    const admittedEvaluators = selection.admitted_evaluator_descriptor_refs.map((ref) => {
      const evaluator = descriptors.get(ref);
      if (!evaluator) throw new Error(`View ${viewId} admits unknown evaluator descriptor ${ref}`);
      usedDescriptorRefs.add(ref);
      return evaluator;
    });
    const value = {
      sourceEvaluator,
      admittedEvaluators,
      identity: JSON.stringify([
        sourceEvaluator.ref,
        admittedEvaluators.map((evaluator) => evaluator.ref),
      ]),
    };
    const address = proofRow.source_dataset_address;
    const prior = byAddress.get(address);
    if (prior && prior.identity !== value.identity) {
      throw new Error(`Dataset ${address} has conflicting per-view evaluator selections`);
    }
    byAddress.set(address, value);
  }
  assertExactSet(descriptors.keys(), usedDescriptorRefs, 'referenced evaluator descriptors');
  return byAddress;
}

function setAtPath(target, path, value, label) {
  let cursor = target;
  path.forEach((segment, index) => {
    if (index === path.length - 1) {
      cursor[segment] = value;
      return;
    }
    if (cursor[segment] === undefined) cursor[segment] = {};
    if (!plainObject(cursor[segment])) {
      throw new Error(`${label} cannot traverse non-object segment ${segment}`);
    }
    cursor = cursor[segment];
  });
  return target;
}

function materializeTemplate(value, context, label = 'payload_template') {
  if (Array.isArray(value)) {
    return value.map((entry, index) => materializeTemplate(entry, context, `${label}[${index}]`));
  }
  if (!plainObject(value)) return value;

  const sentinelKeys = Object.keys(value).filter((key) => key.startsWith('$'));
  if (sentinelKeys.length > 0) {
    if (sentinelKeys.length !== 1 || Object.keys(value).length !== 1) {
      throw new Error(`${label} template operation must be the only key in its object`);
    }
    const operation = sentinelKeys[0];
    const operand = value[operation];
    if (operation === '$evaluator') {
      const key = requiredString(operand, `${label}.$evaluator`);
      if (!Object.prototype.hasOwnProperty.call(context.sourceEvaluator, key)) {
        throw new Error(`${label} names unknown evaluator property ${key}`);
      }
      return structuredClone(context.sourceEvaluator[key]);
    }
    if (operation === '$admitted_evaluator_refs') {
      if (operand !== true) throw new Error(`${label}.$admitted_evaluator_refs must be true`);
      return context.admittedEvaluators.map((evaluator) => ({
        ref: evaluator.ref,
        label: evaluator.authoring_label,
        revision: evaluator.revision,
      }));
    }
    if (operation === '$request_for_source') {
      if (typeof operand !== 'string') throw new Error(`${label} source must be a string`);
      return setAtPath(
        structuredClone(context.sourceEvaluator.request_template),
        context.sourceEvaluator.source_path,
        operand,
        label,
      );
    }
    if (operation === '$request_override') {
      const address = requiredString(operand, `${label}.$request_override`);
      if (address !== context.datasetAddress) {
        throw new Error(`${label} request override must name its containing dataset`);
      }
      const override = context.requestOverrides.get(address);
      if (!override) throw new Error(`${label} names missing request override ${address}`);
      context.usedRequestOverrides.add(address);
      return structuredClone(override.request);
    }
    if (operation === '$concat') {
      if (!Array.isArray(operand)) throw new Error(`${label}.$concat must be an array`);
      return operand.map((entry, index) => {
        const part = materializeTemplate(entry, context, `${label}.$concat[${index}]`);
        if (!['string', 'number', 'boolean'].includes(typeof part)) {
          throw new Error(`${label}.$concat[${index}] must resolve to a scalar`);
        }
        return String(part);
      }).join('');
    }
    if (operation === '$uri_component') {
      const part = materializeTemplate(operand, context, `${label}.$uri_component`);
      if (!['string', 'number', 'boolean'].includes(typeof part)) {
        throw new Error(`${label}.$uri_component must resolve to a scalar`);
      }
      return encodeURIComponent(String(part));
    }
    throw new Error(`${label} names unknown template operation ${operation}`);
  }

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    materializeTemplate(entry, context, `${label}.${key}`),
  ]));
}

export function buildDirectViewModel(
  catalog,
  evaluatorInputs,
  dataCatalog = JSON.parse(readFileSync(DEFAULT_DIRECT_VIEW_DATA_CATALOG_PATH, 'utf8')),
) {
  const proofViews = proofCatalogIndexes(catalog);
  const { descriptors, selections, requestOverrides } = evaluatorInputIndexes(evaluatorInputs);
  const { dataViews, datasets } = dataCatalogIndexes(dataCatalog, proofViews);
  const evaluatorByDataset = evaluatorSelectionsByDataset(
    proofViews,
    descriptors,
    selections,
  );
  const usedRequestOverrides = new Set();
  const datasetsByAddress = new Map([...datasets].sort(([left], [right]) => (
    left.localeCompare(right)
  )).map(([address, row]) => [
    address,
    materializeTemplate(row.payload_template, {
      ...evaluatorByDataset.get(address),
      datasetAddress: address,
      requestOverrides,
      usedRequestOverrides,
    }),
  ]));
  assertExactSet(
    requestOverrides.keys(),
    usedRequestOverrides,
    'materialized dataset request overrides',
  );

  const views = catalog.views.map((row) => structuredClone(dataViews.get(row.view_id).descriptor));
  const viewBytesById = new Map(views.map((view) => [view.id, canonicalBytes(view)]));
  const datasetBytesByAddress = new Map(
    [...datasetsByAddress].map(([address, payload]) => [address, canonicalBytes(payload)]),
  );
  const identities = views.map((view) => {
    const viewBytes = viewBytesById.get(view.id);
    const datasetBytes = datasetBytesByAddress.get(view.sourceDatasetAddress);
    return {
      viewId: view.id,
      viewRecordSha256: sha256(viewBytes),
      sourceDatasetAddress: view.sourceDatasetAddress,
      datasetPayloadSha256: sha256(datasetBytes),
      selectedModelSha256: selectedModelSha256(viewBytes, datasetBytes),
    };
  });
  const workspacePayload = {
    kind: 'visual-database.views',
    version: 2,
    views,
    identities,
    datasets: [...datasetsByAddress].map(([address, payload]) => ({ address, payload })),
  };
  return { datasetsByAddress, views, identities, workspacePayload };
}
