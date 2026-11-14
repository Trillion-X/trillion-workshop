#!/usr/bin/env node

/**
 * Materializes versioned direct-view DATA into Visual Database's production
 * verification workspace. This file owns no view, dataset, field, or evaluator
 * vocabulary; it validates and joins external catalogs, then writes exact bytes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDirectViewModel,
  canonicalBytes,
  DEFAULT_DIRECT_VIEW_DATA_CATALOG_PATH,
  sha256,
} from './direct-view-data-model.mjs';

const SOURCE_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = resolve(dirname(SOURCE_FILE), '..');
const PACKAGES_ROOT = resolve(PACKAGE_ROOT, '../..');
const MANIFEST_PATH = resolve(PACKAGE_ROOT, 'things-to-store-and-run.json');
const DEFAULT_CATALOG_PATH = resolve(
  PACKAGES_ROOT,
  '../ai-command-center/notes/projects/packages-and-package-sets/visual-database/plans/2026-07-26-human-formula-language/proof/proof-view-catalog.json',
);
const DEFAULT_EVALUATOR_INPUT_PATH = resolve(
  dirname(DEFAULT_CATALOG_PATH),
  'proof-evaluator-inputs.json',
);
const CATALOG_PATH = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_CATALOG_PATH;
const EVALUATOR_INPUT_PATH = process.argv[3]
  ? resolve(process.argv[3])
  : DEFAULT_EVALUATOR_INPUT_PATH;
const DATA_CATALOG_PATH = process.argv[4]
  ? resolve(process.argv[4])
  : DEFAULT_DIRECT_VIEW_DATA_CATALOG_PATH;

const WORKSPACE_ADDRESS = 'visual-database.proof-views';
const INPUT_ADDRESS = 'package::visual-database::input::direct-view-workspace';
const INPUT_NAME = 'directViewWorkspace';

export { buildDirectViewModel } from './direct-view-data-model.mjs';

function durableRecord(address, path, payload) {
  return {
    type: 'record',
    address,
    live_write_policy: 'publish-live',
    path,
    payload_base64: canonicalBytes(payload).toString('base64'),
    remove: false,
  };
}

function isGeneratedThing(thing) {
  const address = typeof thing?.address === 'string' ? thing.address : '';
  return address === WORKSPACE_ADDRESS
    || address === INPUT_ADDRESS
    || address.startsWith('visual-database.proof-view::')
    || address.startsWith('visual-database.proof-dataset.');
}

function updateFactflow(thing) {
  if (thing?.address !== 'package::visual-database::factflow::surface') return thing;
  const payload = structuredClone(thing.payload);
  payload.fact_sources = (payload.fact_sources ?? [])
    .filter((entry) => entry?.address !== WORKSPACE_ADDRESS);
  payload.fact_sources.push({
    address: WORKSPACE_ADDRESS,
    role: 'direct view workspace source',
  });
  payload.interpreter_facts.materializations = (payload.interpreter_facts.materializations ?? [])
    .filter((entry) => entry?.input_name !== INPUT_NAME);
  payload.interpreter_facts.materializations.push({
    input_name: INPUT_NAME,
    address_label: WORKSPACE_ADDRESS,
    bytes_to_value: 'json',
  });
  return { ...thing, payload };
}

function runGenerator() {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  const evaluatorInputs = JSON.parse(readFileSync(EVALUATOR_INPUT_PATH, 'utf8'));
  const dataCatalog = JSON.parse(readFileSync(DATA_CATALOG_PATH, 'utf8'));
  const {
    datasetsByAddress,
    views,
    identities,
    workspacePayload,
  } = buildDirectViewModel(catalog, evaluatorInputs, dataCatalog);
  const generatedThings = [
    {
      type: 'record',
      address: INPUT_ADDRESS,
      path: ['package-primitive', 'factflow', 'materialization'],
      payload: {
        kind: 'bitfield-input-descriptor',
        input_name: INPUT_NAME,
        value_address_label: WORKSPACE_ADDRESS,
        value: { source_bytes: { bytes_to_value: 'json' } },
      },
      remove: false,
    },
    durableRecord(WORKSPACE_ADDRESS, ['visual-database', 'direct-view-workspace'], workspacePayload),
    ...views.map((view) => {
      const row = catalog.views.find((candidate) => candidate.view_id === view.id);
      return durableRecord(row.durable_record_id, row.path_labels, view);
    }),
    ...[...datasetsByAddress].map(([address, payload]) => durableRecord(
      address,
      ['visual-database', 'view-datasets', address.slice(address.lastIndexOf('.') + 1)],
      payload,
    )),
  ];

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  manifest.things = manifest.things.filter((thing) => !isGeneratedThing(thing)).map(updateFactflow);
  const ordinaryViewsIndex = manifest.things.findIndex(
    (thing) => thing.address === 'visual-database.views',
  );
  if (ordinaryViewsIndex < 0) throw new Error('visual-database.views insertion anchor is missing');
  manifest.things.splice(ordinaryViewsIndex + 1, 0, ...generatedThings);

  const identityByViewId = new Map(identities.map((identity) => [identity.viewId, identity]));
  for (const row of catalog.views) {
    const identity = identityByViewId.get(row.view_id);
    row.view_payload_sha256 = identity.viewRecordSha256;
    row.dataset_payload_sha256 = identity.datasetPayloadSha256;
    row.selected_model_sha256 = identity.selectedModelSha256;
  }
  catalog.catalog_record.expected_payload_sha256 = sha256(canonicalBytes(workspacePayload));
  catalog.catalog_record.aggregate_hash_rule = 'expected_payload_sha256 is SHA-256 of the exact UTF-8 JSON.stringify bytes stored at visual-database.proof-views. It never substitutes for row-level view, dataset, or selected-model identities.';
  catalog.catalog_record.selected_model_hash_rule = 'SHA-256(UTF8("visual-database.selected-model/v1\\0") || uint64be(view_bytes_length) || canonical_view_bytes || uint64be(dataset_bytes_length) || canonical_dataset_bytes); canonical bytes are UTF-8 JSON.stringify payload bytes.';

  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(JSON.stringify({
    manifest: MANIFEST_PATH,
    catalog: CATALOG_PATH,
    evaluator_inputs: EVALUATOR_INPUT_PATH,
    data_catalog: DATA_CATALOG_PATH,
    views: views.length,
    datasets: datasetsByAddress.size,
    workspace_payload_sha256: catalog.catalog_record.expected_payload_sha256,
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === SOURCE_FILE) runGenerator();
