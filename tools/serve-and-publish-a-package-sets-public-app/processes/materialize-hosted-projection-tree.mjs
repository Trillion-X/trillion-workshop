#!/usr/bin/env node

import { makeHashCodeHexFromBytes } from '@bitfield/slot-protocol';
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const INPUT_SCHEMA = 'hosted-experience-materialization-input/v1';
const MANIFEST_SCHEMA = 'experience-authority-manifest/v1';
const AUTHORITY_KEYS = Object.freeze([
  ['data_refs', 'data_address_refs'],
  ['subscription_refs', 'subscription_refs'],
  ['target_refs', 'target_refs'],
  ['navigation_refs', 'navigation_refs'],
]);

export class HostedExperienceMaterializationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'HostedExperienceMaterializationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new HostedExperienceMaterializationError(code, message);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value, label) {
  if (!isRecord(value)) fail('HPA_MATERIALIZE_0001_RECORD_REQUIRED', `${label} must be an object.`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail('HPA_MATERIALIZE_0002_ARRAY_REQUIRED', `${label} must be an array.`);
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('HPA_MATERIALIZE_0003_TEXT_REQUIRED', `${label} must be a non-empty string.`);
  }
  return value;
}

function optionalText(value, label) {
  return value === undefined ? undefined : text(value, label);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('HPA_MATERIALIZE_0004_POSITIVE_INTEGER_REQUIRED', `${label} must be a positive safe integer.`);
  }
  return value;
}

function safeSegment(value, label) {
  const segment = text(value, label);
  if (
    segment === '.'
    || segment === '..'
    || segment.includes('/')
    || segment.includes('\\')
    || segment.includes('\0')
  ) {
    fail('HPA_MATERIALIZE_0005_PATH_SEGMENT_INVALID', `${label} contains an unsafe path segment.`);
  }
  return segment;
}

function pathSegments(value, label) {
  const segments = array(value, label).map((part, index) => safeSegment(part, `${label}[${index}]`));
  if (segments.length === 0) fail('HPA_MATERIALIZE_0006_PATH_EMPTY', `${label} must not be empty.`);
  return segments;
}

function mountedFile(value, label) {
  const declared = text(value, label);
  const file = path.isAbsolute(declared) ? declared : path.resolve(process.cwd(), declared);
  if (!path.isAbsolute(declared)) {
    const root = path.resolve(process.cwd());
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
      fail('HPA_MATERIALIZE_0007_MOUNTED_FILE_INVALID', `${label} escapes the process mount root.`);
    }
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    fail('HPA_MATERIALIZE_0007_MOUNTED_FILE_INVALID', `${label} must name an existing mounted file.`);
  }
  return file;
}

function multihashForBytes(bytes) {
  return makeHashCodeHexFromBytes(bytes);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function objectHash(value) {
  return multihashForBytes(Buffer.from(canonicalJson(value)));
}

function canonicalMultihash(value, label) {
  const hash = text(value, label).toLowerCase();
  if (!/^1f:[0-9a-f]{64}$/.test(hash)) {
    fail('HPA_MATERIALIZE_0034_MULTIHASH_INVALID', `${label} must be a canonical Runtime Kit multihash.`);
  }
  return hash;
}

function identity(value, label) {
  const item = record(value, label);
  return {
    address: text(item.address, `${label}.address`),
    revision: text(item.revision, `${label}.revision`),
    object_hash: canonicalMultihash(item.object_hash, `${label}.object_hash`),
  };
}

function identityKey(item) {
  return canonicalJson([item.address, item.revision]);
}

function compareIdentity(left, right) {
  return left.address.localeCompare(right.address)
    || left.revision.localeCompare(right.revision)
    || left.object_hash.localeCompare(right.object_hash);
}

function exactIdentities(value, label) {
  const seen = new Set();
  return array(value ?? [], label)
    .map((entry, index) => identity(entry, `${label}[${index}]`))
    .filter((entry) => {
      const key = canonicalJson(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareIdentity);
}

function projectionFile(value, label) {
  const item = record(value, label);
  return {
    path: pathSegments(item.path, `${label}.path`),
    mounted_path: mountedFile(item.mounted_path, `${label}.mounted_path`),
    integrity_hash: canonicalMultihash(item.integrity_hash, `${label}.integrity_hash`),
    executable: item.executable === true,
  };
}

function browserImportSpecifier(value, label) {
  const specifier = text(value, label);
  if (
    specifier.startsWith('.')
    || specifier.startsWith('/')
    || specifier.includes('\\')
    || specifier.includes('\0')
  ) {
    fail('HPA_MATERIALIZE_0034_BROWSER_IMPORT_SPECIFIER_INVALID', `${label} must be a bare browser import specifier.`);
  }
  return specifier;
}

function browserImportBinding(value, label) {
  const item = record(value, label);
  return {
    specifier: browserImportSpecifier(item.specifier, `${label}.specifier`),
    path: pathSegments(item.path, `${label}.path`),
  };
}

function authority(value, label) {
  const item = value === undefined ? {} : record(value, label);
  return Object.fromEntries(
    AUTHORITY_KEYS.map(([inputKey]) => [
      inputKey,
      exactIdentities(item[inputKey], `${label}.${inputKey}`),
    ]),
  );
}

function dependency(value, label) {
  const ref = identity(value, label);
  const raw = record(value, label);
  return {
    ...ref,
    cycle_semantics_ref: optionalText(raw.cycle_semantics_ref, `${label}.cycle_semantics_ref`),
  };
}

function materializationRecord(value, index) {
  const label = `records[${index}]`;
  const item = record(value, label);
  return {
    ...identity(item, label),
    kind_ref: text(item.kind_ref, `${label}.kind_ref`),
    dependency_refs: array(item.dependency_refs, `${label}.dependency_refs`)
      .map((entry, dependencyIndex) => dependency(entry, `${label}.dependency_refs[${dependencyIndex}]`))
      .sort(compareIdentity),
    projection_files: array(item.projection_files ?? [], `${label}.projection_files`)
      .map((entry, fileIndex) => projectionFile(entry, `${label}.projection_files[${fileIndex}]`))
      .sort((left, right) => canonicalJson(left.path).localeCompare(canonicalJson(right.path))),
    browser_import_bindings: array(item.browser_import_bindings ?? [], `${label}.browser_import_bindings`)
      .map((entry, bindingIndex) => browserImportBinding(entry, `${label}.browser_import_bindings[${bindingIndex}]`))
      .sort((left, right) => left.specifier.localeCompare(right.specifier) || canonicalJson(left.path).localeCompare(canonicalJson(right.path))),
    authority: authority(item.authority, `${label}.authority`),
    cycle_semantics_ref: optionalText(item.cycle_semantics_ref, `${label}.cycle_semantics_ref`),
  };
}

function normalizedInput(value) {
  const input = record(value, 'input');
  if (input.schema !== INPUT_SCHEMA) {
    fail('HPA_MATERIALIZE_0008_SCHEMA_INVALID', `input.schema must be ${INPUT_SCHEMA}.`);
  }
  const limits = record(input.limits, 'input.limits');
  const intent = record(input.intent, 'input.intent');
  const roots = array(intent.root_refs, 'input.intent.root_refs')
    .map((entry, index) => identity(entry, `input.intent.root_refs[${index}]`))
    .sort(compareIdentity);
  if (roots.length === 0) {
    fail('HPA_MATERIALIZE_0009_ROOT_REQUIRED', 'input.intent.root_refs must contain at least one root.');
  }
  const rootKeys = new Set(roots.map(identityKey));
  if (rootKeys.size !== roots.length) {
    fail('HPA_MATERIALIZE_0010_ROOT_DUPLICATE', 'input.intent.root_refs contains a duplicate identity.');
  }
  return {
    schema: INPUT_SCHEMA,
    intent: {
      ...identity(intent, 'input.intent'),
      root_refs: roots,
      access_ref: text(intent.access_ref, 'input.intent.access_ref'),
      entry_projection_target_ref: intent.entry_projection_target_ref === undefined
        ? undefined
        : identity(intent.entry_projection_target_ref, 'input.intent.entry_projection_target_ref'),
      entry_byte_path: intent.entry_byte_path === undefined
        ? undefined
        : pathSegments(intent.entry_byte_path, 'input.intent.entry_byte_path'),
    },
    materializer: identity(input.materializer, 'input.materializer'),
    limits: {
      max_records: positiveInteger(limits.max_records, 'input.limits.max_records'),
      max_files: positiveInteger(limits.max_files, 'input.limits.max_files'),
      max_total_bytes: positiveInteger(limits.max_total_bytes, 'input.limits.max_total_bytes'),
    },
    records: array(input.records, 'input.records').map(materializationRecord),
  };
}

function recordIndex(records, maxRecords) {
  if (records.length > maxRecords) {
    fail('HPA_MATERIALIZE_0011_RECORD_LIMIT', `Input contains ${records.length} records; limit is ${maxRecords}.`);
  }
  const index = new Map();
  for (const item of records) {
    const key = identityKey(item);
    if (index.has(key)) {
      fail('HPA_MATERIALIZE_0012_RECORD_DUPLICATE', `Duplicate record identity ${item.address}@${item.revision}.`);
    }
    index.set(key, item);
  }
  return index;
}

function declaredCycle(stack, targetIndex, source, target, edge) {
  const cycle = [...stack.slice(targetIndex), source, target];
  const declared = cycle.map((item) => item.cycle_semantics_ref);
  return Boolean(
    edge.cycle_semantics_ref
    && declared.every((ref) => ref === edge.cycle_semantics_ref),
  );
}

function traverse(input) {
  const index = recordIndex(input.records, input.limits.max_records);
  const state = new Map();
  const stack = [];
  const visited = [];

  function visit(expected, edge) {
    const key = identityKey(expected);
    const item = index.get(key);
    if (!item) {
      fail('HPA_MATERIALIZE_0013_REFERENCE_MISSING', `Missing declared record ${expected.address}@${expected.revision}.`);
    }
    if (item.object_hash !== expected.object_hash) {
      fail('HPA_MATERIALIZE_0014_REFERENCE_STALE', `Hash mismatch for ${expected.address}@${expected.revision}.`);
    }
    if (state.get(key) === 'done') return;
    if (state.get(key) === 'visiting') {
      const targetIndex = stack.findIndex((candidate) => identityKey(candidate) === key);
      const source = stack.at(-1);
      if (targetIndex < 0 || !source || !edge || !declaredCycle(stack, targetIndex, source, item, edge)) {
        fail('HPA_MATERIALIZE_0015_CYCLE_UNDECLARED', `Undeclared dependency cycle reaches ${item.address}@${item.revision}.`);
      }
      return;
    }
    state.set(key, 'visiting');
    stack.push(item);
    for (const dependencyRef of item.dependency_refs) visit(dependencyRef, dependencyRef);
    stack.pop();
    state.set(key, 'done');
    visited.push(item);
  }

  for (const root of input.intent.root_refs) visit(root);
  return visited.sort(compareIdentity);
}

function boundedFiles(records, limits) {
  const byPath = new Map();
  let totalBytes = 0;
  for (const item of records) {
    for (const file of item.projection_files) {
      const bytes = readFileSync(file.mounted_path);
      const actualHash = multihashForBytes(bytes);
      if (actualHash !== file.integrity_hash) {
        fail('HPA_MATERIALIZE_0016_FILE_HASH_MISMATCH', `Mounted bytes do not match ${file.integrity_hash}.`);
      }
      const key = canonicalJson(file.path);
      const prior = byPath.get(key);
      if (prior && prior.integrity_hash !== file.integrity_hash) {
        fail('HPA_MATERIALIZE_0017_FILE_PATH_CONFLICT', `Two different files claim ${file.path.join('/')}.`);
      }
      if (prior) continue;
      byPath.set(key, { ...file, bytes });
      totalBytes += bytes.byteLength;
      if (byPath.size > limits.max_files) {
        fail('HPA_MATERIALIZE_0018_FILE_LIMIT', `Selected closure exceeds ${limits.max_files} files.`);
      }
      if (totalBytes > limits.max_total_bytes) {
        fail('HPA_MATERIALIZE_0019_BYTE_LIMIT', `Selected closure exceeds ${limits.max_total_bytes} bytes.`);
      }
    }
  }
  return {
    files: [...byPath.values()].sort((left, right) => canonicalJson(left.path).localeCompare(canonicalJson(right.path))),
    totalBytes,
  };
}

// Browser ESM resolution is sealed selected-experience data. Each selected
// graph record declares the bare specifiers it contributes and their exact
// selected projection paths; no source bytes or build-layout metadata infer it.
function browserImportMap(records, files) {
  const byPath = new Map(files.map((file) => [file.path.join('/'), file]));
  const imports = {};
  for (const record of records) {
    for (const binding of record.browser_import_bindings) {
      const target = binding.path.join('/');
      if (!byPath.has(target)) {
        fail('HPA_MATERIALIZE_0036_BROWSER_IMPORT_TARGET_MISSING', `Selected browser import ${binding.specifier} targets an unselected projection path.`);
      }
      if (Object.hasOwn(imports, binding.specifier)) {
        if (imports[binding.specifier] === target) {
          fail('HPA_MATERIALIZE_0035_BROWSER_IMPORT_DUPLICATE', `Selected browser import ${binding.specifier} is declared more than once.`);
        }
        fail('HPA_MATERIALIZE_0029_BROWSER_IMPORT_AMBIGUOUS', `Selected browser import ${binding.specifier} resolves ambiguously.`);
      }
      imports[binding.specifier] = target;
    }
  }
  return Object.fromEntries(Object.entries(imports).sort(([left], [right]) => left.localeCompare(right)));
}

function logicalAuthorityManifest(input, visited, files) {
  const collected = Object.fromEntries(AUTHORITY_KEYS.map(([, outputKey]) => [outputKey, new Map()]));
  for (const item of visited) {
    for (const [inputKey, outputKey] of AUTHORITY_KEYS) {
      for (const ref of item.authority[inputKey]) collected[outputKey].set(canonicalJson(ref), ref);
    }
  }
  const entryProjectionTargetRef = input.intent.entry_projection_target_ref;
  if (entryProjectionTargetRef !== undefined) {
    const matchingTargets = [...collected.target_refs.values()]
      .filter((ref) => canonicalJson(ref) === canonicalJson(entryProjectionTargetRef));
    if (matchingTargets.length !== 1) {
      fail('HPA_MATERIALIZE_0037_ENTRY_PROJECTION_TARGET_INVALID', 'entry_projection_target_ref must select exactly one target_refs member.');
    }
  }
  const withoutHash = {
    schema: MANIFEST_SCHEMA,
    intent_address: input.intent.address,
    intent_revision: input.intent.revision,
    intent_object_hash: input.intent.object_hash,
    root_refs: input.intent.root_refs,
    data_address_refs: [...collected.data_address_refs.values()].sort(compareIdentity),
    subscription_refs: [...collected.subscription_refs.values()].sort(compareIdentity),
    target_refs: [...collected.target_refs.values()].sort(compareIdentity),
    ...(entryProjectionTargetRef ? { entry_projection_target_ref: entryProjectionTargetRef } : {}),
    navigation_refs: [...collected.navigation_refs.values()].sort(compareIdentity),
    access_ref: input.intent.access_ref,
    entry_byte_path: input.intent.entry_byte_path,
    browser_import_map: browserImportMap(visited, files),
    projection_provenance: {
      materializer_descriptor_ref: input.materializer.address,
      materializer_revision: input.materializer.revision,
      materializer_object_hash: input.materializer.object_hash,
      visited_record_refs: visited.map(({ address, revision, object_hash }) => ({ address, revision, object_hash })),
    },
    diagnostics: {
      selected_record_count: visited.length,
      counts_by_authority: Object.fromEntries(
        Object.entries(collected).map(([key, refs]) => [key, refs.size]),
      ),
    },
  };
  if (
    withoutHash.entry_byte_path
    && !files.some((file) => canonicalJson(file.path) === canonicalJson(withoutHash.entry_byte_path))
  ) {
    fail(
      'HPA_MATERIALIZE_0025_ENTRY_BYTES_NOT_SELECTED',
      'input.intent.entry_byte_path must identify a selected projection file.',
    );
  }
  return {
    ...withoutHash,
    authority_manifest_object_hash: objectHash(withoutHash),
  };
}

function sourceFileSet(files) {
  return {
    files: files.map((file) => ({
      path: file.path,
      bytes: Array.from(file.bytes),
      executable: file.executable,
    })),
  };
}

export function materializeHostedProjectionTree(
  rawInput,
  sourceFileSetOutput,
  authorityManifestOutput,
) {
  const input = normalizedInput(rawInput);
  const visited = traverse(input);
  const { files, totalBytes } = boundedFiles(visited, input.limits);
  const manifest = logicalAuthorityManifest(input, visited, files);
  if (sourceFileSetOutput !== undefined) {
    const output = path.resolve(text(sourceFileSetOutput, 'sourceFileSetOutput'));
    writeFileSync(output, `${JSON.stringify(sourceFileSet(files))}\n`);
  }
  if (authorityManifestOutput !== undefined) {
    const output = path.resolve(text(authorityManifestOutput, 'authorityManifestOutput'));
    writeFileSync(output, `${JSON.stringify(canonicalValue(manifest))}\n`);
  }
  return {
    schema: 'hosted-experience-materialization-result/v1',
    authority_manifest: manifest,
    selected_record_count: visited.length,
    selected_file_count: files.length,
    selected_byte_count: totalBytes,
    source_file_set_file: sourceFileSetOutput === undefined ? undefined : path.resolve(sourceFileSetOutput),
    authority_manifest_output_file: authorityManifestOutput === undefined
      ? undefined
      : path.resolve(authorityManifestOutput),
  };
}

function cliArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      fail('HPA_MATERIALIZE_0023_ARGUMENT_INVALID', `Invalid argument near ${flag ?? '<end>'}.`);
    }
    const key = flag.slice(2);
    if (values[key] !== undefined) {
      fail('HPA_MATERIALIZE_0024_ARGUMENT_DUPLICATE', `Argument --${key} was supplied twice.`);
    }
    values[key] = value;
  }
  return values;
}

function main() {
  const args = cliArgs(process.argv.slice(2));
  const inputFile = mountedFile(args['input-file'], '--input-file');
  const result = materializeHostedProjectionTree(
    JSON.parse(readFileSync(inputFile, 'utf8')),
    args['source-file-set-output'],
    args['authority-manifest-output'],
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
