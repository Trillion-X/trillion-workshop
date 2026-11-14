#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DEFAULT_RECORDS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../data/action-capability-records.json',
);

const PROOF_SCHEMA = 'bitfield.package_store.action_capability_preflight.v1';

function usage() {
  return [
    'Usage:',
    '  node prove-production-action-capabilities.mjs [options]',
    '',
    'Options:',
    '  --records <path>             Action capability records JSON. Defaults to this package data file.',
    '  --action <action_ref>        Action ref to check. Repeatable. Defaults to every declared action.',
    '  --target-ref <target_ref>    Target ref to check. Repeatable. Adds matching action requirements.',
    '  --env-file <path>            Read KEY=value deployment handles from a dotenv file. Missing file fails.',
    '  --optional-env-file <path>   Read KEY=value deployment handles when the file exists.',
    '  --env-name <name>            Mark a deployment environment variable name present. Repeatable.',
    '  --env-name-file <path>       Read deployment environment variable names from JSON or text output.',
    '  --handle-ref <ref>           Mark an opaque credential handle present. Repeatable.',
    '  --handle-file <path>         Read present handle refs from JSON or text.',
    '  --proof-output <path>        Write redacted proof/status JSON.',
    '  --strict-runtime-handles     Fail when opaque credential-key handles are not proven present.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    actionRefs: [],
    envFiles: [],
    envNameFiles: [],
    envNames: [],
    handleFiles: [],
    handleRefs: [],
    recordsPath: DEFAULT_RECORDS_PATH,
    strictRuntimeHandles: false,
    targetRefs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return next;
    };

    switch (arg) {
      case '--records':
        args.recordsPath = path.resolve(value());
        break;
      case '--action':
        args.actionRefs.push(value());
        break;
      case '--target-ref':
        args.targetRefs.push(value());
        break;
      case '--env-file':
        args.envFiles.push({ optional: false, path: path.resolve(value()) });
        break;
      case '--optional-env-file':
        args.envFiles.push({ optional: true, path: path.resolve(value()) });
        break;
      case '--env-name':
        args.envNames.push(value());
        break;
      case '--env-name-file':
        args.envNameFiles.push(path.resolve(value()));
        break;
      case '--handle-ref':
        args.handleRefs.push(value());
        break;
      case '--handle-file':
        args.handleFiles.push(path.resolve(value()));
        break;
      case '--proof-output':
        args.proofOutput = path.resolve(value());
        break;
      case '--strict-runtime-handles':
        args.strictRuntimeHandles = true;
        break;
      case '--all-actions':
        break;
      case '--help':
      case '-h':
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function strings(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(nonEmptyString).filter(Boolean))]
    : [];
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readActionCapabilityRecords(filePath) {
  const raw = readJsonFile(filePath);
  if (!isRecord(raw)) throw new Error(`Action capability records must be a JSON object: ${filePath}`);
  const actionRequirements = Array.isArray(raw.action_requirements) ? raw.action_requirements : [];
  const credentialRequirements = Array.isArray(raw.credential_requirements) ? raw.credential_requirements : [];
  return {
    schema: nonEmptyString(raw.schema) ?? 'unknown',
    actionRequirements: actionRequirements.filter(isRecord).map(readActionRequirement).filter(Boolean),
    credentialRequirements: credentialRequirements.filter(isRecord).map(readCredentialRequirement).filter(Boolean),
  };
}

function readActionRequirement(record) {
  const actionRef = nonEmptyString(record.action_ref);
  if (!actionRef) return undefined;
  return {
    action_ref: actionRef,
    label: nonEmptyString(record.label) ?? actionRef,
    required_credential_refs: strings(record.required_credential_refs),
    target_refs: strings(record.target_refs),
  };
}

function readCredentialRequirement(record) {
  const requirementRef = nonEmptyString(record.requirement_ref);
  const credentialHandleRef = nonEmptyString(record.credential_handle_ref);
  if (!requirementRef || !credentialHandleRef) return undefined;
  return {
    credential_handle_ref: credentialHandleRef,
    detail: nonEmptyString(record.detail) ?? '',
    environment_variable: nonEmptyString(record.environment_variable),
    label: nonEmptyString(record.label) ?? requirementRef,
    owner_package: nonEmptyString(record.owner_package) ?? '',
    provider_package: nonEmptyString(record.provider_package) ?? '',
    requirement_ref: requirementRef,
    status_label: nonEmptyString(record.status_label) ?? '',
    target_refs: strings(record.target_refs),
  };
}

function parseEnvNamesFromDotenv(text) {
  const names = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    names.add(match[1]);
  }
  return names;
}

function parseNamesFromLooseInput(text) {
  const jsonNames = parseNamesFromJsonText(text);
  if (jsonNames.size) return jsonNames;
  return new Set(text.match(/[A-Z_][A-Z0-9_]+/g) ?? []);
}

function parseHandlesFromLooseInput(text) {
  const jsonHandles = parseNamesFromJsonText(text);
  if (jsonHandles.size) return jsonHandles;
  return new Set(text.match(/[a-z][a-z0-9-]*:[^\s'",\]]+/g) ?? []);
}

function parseNamesFromJsonText(text) {
  try {
    return collectStrings(JSON.parse(text));
  } catch {
    return new Set();
  }
}

function collectStrings(value) {
  const names = new Set();
  const visit = (item) => {
    if (typeof item === 'string' && item.trim()) {
      names.add(item.trim());
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (isRecord(item)) {
      for (const child of Object.values(item)) visit(child);
    }
  };
  visit(value);
  return names;
}

function readDeploymentEnvNames(args) {
  const names = new Set(args.envNames.map(nonEmptyString).filter(Boolean));
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.trim()) names.add(name);
  }
  for (const envFile of args.envFiles) {
    if (!existsSync(envFile.path)) {
      if (envFile.optional) continue;
      throw new Error(`Environment inventory file is missing: ${envFile.path}`);
    }
    for (const name of parseEnvNamesFromDotenv(readFileSync(envFile.path, 'utf8'))) names.add(name);
  }
  for (const filePath of args.envNameFiles) {
    for (const name of parseNamesFromLooseInput(readFileSync(filePath, 'utf8'))) names.add(name);
  }
  return names;
}

function readHandleRefs(args) {
  const handles = new Set(args.handleRefs.map(nonEmptyString).filter(Boolean));
  for (const filePath of args.handleFiles) {
    for (const handle of parseHandlesFromLooseInput(readFileSync(filePath, 'utf8'))) handles.add(handle);
  }
  return handles;
}

function selectActions(records, args) {
  const requestedActionRefs = new Set(args.actionRefs.map(nonEmptyString).filter(Boolean));
  const requestedTargetRefs = new Set(args.targetRefs.map(nonEmptyString).filter(Boolean));
  if (!requestedActionRefs.size && !requestedTargetRefs.size) return records.actionRequirements;
  const selectedActions = records.actionRequirements.filter((action) => (
    requestedActionRefs.has(action.action_ref) ||
    action.target_refs.some((targetRef) => requestedTargetRefs.has(targetRef))
  ));
  const selectedRefs = new Set(selectedActions.map((action) => action.action_ref));
  const missingActionRefs = [...requestedActionRefs].filter((actionRef) => !selectedRefs.has(actionRef));
  if (missingActionRefs.length) {
    throw new Error(`Action capability records do not declare requested action refs: ${missingActionRefs.join(', ')}`);
  }
  if (requestedTargetRefs.size && selectedActions.length === 0) {
    throw new Error(`Action capability records do not declare requested target refs: ${[...requestedTargetRefs].join(', ')}`);
  }
  return selectedActions;
}

function handleKind(handleRef) {
  const separator = handleRef.indexOf(':');
  return separator > 0 ? handleRef.slice(0, separator) : 'opaque';
}

function evaluatePreflight(records, args) {
  const deploymentEnvNames = readDeploymentEnvNames(args);
  const presentHandles = readHandleRefs(args);
  for (const name of deploymentEnvNames) presentHandles.add(`deployment-env:${name}`);

  const credentialByRef = new Map(records.credentialRequirements.map((requirement) => [
    requirement.requirement_ref,
    requirement,
  ]));
  const selectedActions = selectActions(records, args);
  const rows = [];

  for (const action of selectedActions) {
    for (const requirementRef of action.required_credential_refs) {
      const requirement = credentialByRef.get(requirementRef);
      if (!requirement) {
        rows.push({
          action_ref: action.action_ref,
          action_label: action.label,
          credential_handle_ref: null,
          deploy_blocking: true,
          environment_variable: null,
          handle_kind: 'missing-requirement-record',
          owner_package: '',
          provider_package: '',
          requirement_ref: requirementRef,
          status: 'missing-requirement-record',
          status_label: 'missing requirement record',
        });
        continue;
      }

      const kind = handleKind(requirement.credential_handle_ref);
      const present = presentHandles.has(requirement.credential_handle_ref);
      const deployOwned = kind === 'deployment-env';
      const missing = !present && (deployOwned || args.strictRuntimeHandles);
      rows.push({
        action_ref: action.action_ref,
        action_label: action.label,
        credential_handle_ref: requirement.credential_handle_ref,
        deploy_blocking: missing,
        detail: requirement.detail,
        environment_variable: requirement.environment_variable ?? null,
        handle_kind: kind,
        owner_package: requirement.owner_package,
        provider_package: requirement.provider_package,
        requirement_ref: requirement.requirement_ref,
        status: present ? 'ready' : missing ? 'missing' : 'runtime-proof-required',
        status_label: present ? 'ready' : missing ? 'missing handle' : 'requires runtime handle proof',
      });
    }
  }

  const missingRows = rows.filter((row) => row.deploy_blocking);
  return {
    schema: PROOF_SCHEMA,
    input_records_schema: records.schema,
    checked_action_refs: selectedActions.map((action) => action.action_ref),
    checked_target_refs: [...new Set(selectedActions.flatMap((action) => action.target_refs))],
    status: missingRows.length ? 'blocked' : 'ready',
    rows,
    missing_handles: missingRows.map((row) => ({
      action_ref: row.action_ref,
      credential_handle_ref: row.credential_handle_ref,
      environment_variable: row.environment_variable,
      requirement_ref: row.requirement_ref,
    })),
    runtime_proof_required_handles: rows
      .filter((row) => row.status === 'runtime-proof-required')
      .map((row) => ({
        action_ref: row.action_ref,
        credential_handle_ref: row.credential_handle_ref,
        requirement_ref: row.requirement_ref,
      })),
  };
}

function writeProof(filePath, proof) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(proof, null, 2)}\n`);
}

function printSummary(proof) {
  const missing = proof.missing_handles.map((row) => row.credential_handle_ref).filter(Boolean);
  const runtimeProof = proof.runtime_proof_required_handles
    .map((row) => row.credential_handle_ref)
    .filter(Boolean);
  console.log(`[package-store-action-preflight] ${proof.status}`);
  console.log(`[package-store-action-preflight] checked actions: ${proof.checked_action_refs.join(', ') || '(none)'}`);
  if (missing.length) {
    console.log(`[package-store-action-preflight] missing blocking handles: ${[...new Set(missing)].join(', ')}`);
  }
  if (runtimeProof.length) {
    console.log(`[package-store-action-preflight] runtime proof required: ${[...new Set(runtimeProof)].join(', ')}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const records = readActionCapabilityRecords(args.recordsPath);
  const proof = evaluatePreflight(records, args);
  if (args.proofOutput) writeProof(args.proofOutput, proof);
  printSummary(proof);
  if (proof.status !== 'ready') process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`[package-store-action-preflight] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
