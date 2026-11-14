#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  buildComputerInterfaceAction,
  findComputerInterfaceProvider,
  ComputerInterfaceActionError,
} from './computer-interface-actions.mjs';

const PORTABLE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PORTABLE_OUTPUT = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function prepareComputerInterfaceSession(request, providersDoc) {
  if (Object.hasOwn(request, 'surface_proof')) {
    throw executionError('untrusted_surface_proof', 'The separate browsing screen must be checked by its owner.');
  }
  const action = buildComputerInterfaceAction(request, providersDoc);
  const provider = findComputerInterfaceProvider(request, providersDoc);
  assertExecutionSurface(provider, null);

  const invocation = provider.execution?.[action.operation];
  if (!invocation || typeof invocation !== 'object' || Array.isArray(invocation)) {
    throw executionError('execution_not_declared', `The browsing option "${provider.id}" cannot perform "${action.operation}".`);
  }
  const runtimeAlias = provider.executable;
  if (typeof runtimeAlias !== 'string' || !PORTABLE_ALIAS.test(runtimeAlias)) {
    throw executionError('invalid_runtime_alias', 'The selected browsing option is not safely configured.');
  }
  const argv = [runtimeAlias, ...renderArguments(invocation.argv, action)];
  for (const optional of invocation.optional_argv ?? []) {
    if (!optional || typeof optional !== 'object' || Array.isArray(optional)) {
      throw executionError('invalid_execution_data', 'The selected browsing option has incomplete setup.');
    }
    if (action[optional.when_request] !== undefined) argv.push(...renderArguments(optional.argv, action));
  }

  const timeoutMs = action.timeout_ms ?? provider.run_timeout_ms;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw executionError('invalid_timeout', 'The browsing time limit is invalid.');
  }
  if (typeof request.idempotency_key !== 'string' || request.idempotency_key.trim().length === 0) {
    throw executionError('missing_idempotency_key', 'A unique request key is required.');
  }

  const outputs = [];
  if (typeof invocation.output_request_field === 'string') {
    const outputPath = action[invocation.output_request_field];
    if (typeof outputPath !== 'string' || !PORTABLE_OUTPUT.test(outputPath) || outputPath.includes('..')) {
      throw executionError('invalid_output_path', 'Choose a file name inside this task.');
    }
    outputs.push({mount_path: outputPath, content_type: invocation.output_content_type ?? 'application/octet-stream'});
  }

  return {
    operation: 'start_session',
    descriptor: {
      process: {
        argv,
        cwd: '.',
        timeout_ms: timeoutMs,
        termination_grace_ms: 1000,
        expected_termination: null,
        env: {},
        inputs: [],
        input_trees: [],
        outputs,
        ...(invocation.network_access === 'allowed' ? {network_access: 'allowed'} : {}),
        containment: declaredContainment(invocation, provider, action.operation),
        capture_fds: [1, 2],
        collected_files: [],
      },
      workspace_bindings: {environment: [], arguments: []},
      session_settings: {},
    },
    idempotency_key: `computer-interface:${encodeURIComponent(request.idempotency_key)}`,
  };
}

/**
 * A browsing option says for itself whether its program creates children.
 *
 * This used to be one hardcoded value for every option, and it was the value
 * that permits a descendant tree. macOS exposes no unprivileged kernel
 * primitive that owns `setsid` or a double fork, so the process owner refuses
 * that request outright and EVERY browsing option was unusable on a Mac, even
 * a self-contained headless browser that never spawns anything. The handler
 * was describing the one option that needed it.
 *
 * `leaf` is the STRONGER request: child creation is denied outright. So the
 * table is not loosening anything by declaring it, and there is no default
 * here on purpose. An option that does not say what its program does is a
 * setup mistake, and guessing is what produced this.
 */
function declaredContainment(invocation, provider, operation) {
  const containment = invocation.containment;
  if (!containment || typeof containment !== 'object' || Array.isArray(containment)) {
    throw executionError(
      'containment_not_declared',
      `The browsing option "${provider.id}" has incomplete setup for "${operation}".`,
    );
  }
  return containment;
}

function renderArguments(spec, action) {
  if (!Array.isArray(spec)) throw executionError('invalid_execution_data', 'The selected browsing option has incomplete setup.');
  return spec.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      throw executionError('invalid_execution_data', 'The selected browsing option has incomplete setup.');
    }
    if (typeof part.request !== 'string') {
      throw executionError('invalid_execution_data', 'The selected browsing option has incomplete setup.');
    }
    const value = action[part.request];
    if (typeof value !== 'string' || value.length === 0) {
      throw executionError('missing_execution_argument', `This action needs "${part.request}".`);
    }
    return value;
  });
}

function assertExecutionSurface(provider, proof) {
  if (provider.surface_class === 'visible_personal_display') {
    throw executionError('visible_personal_surface_forbidden', 'Personal browser windows cannot be used for this action.');
  }
  if (provider.surface_class !== 'task_isolated_agent_screen') return;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    throw executionError('isolated_surface_unproven', 'A separate browsing screen for this task is not ready yet.');
  }
  const required = {
    kind: 'computer-interface.authenticated-surface-proof',
    version: 1,
    provider_id: provider.id,
    runtime_alias: provider.executable,
    isolation_scope: 'task',
    independent_pointer: true,
    independent_keyboard: true,
    visible_on_personal_display: false,
  };
  for (const [key, expected] of Object.entries(required)) {
    if (proof[key] !== expected) throw executionError('isolated_surface_unproven', 'The separate browsing screen check is incomplete.');
  }
  for (const key of ['bootstrap_identity', 'process_session_id', 'provider_session_id', 'surface_identity', 'input_focus_identity', 'observation_ref', 'observation_hash']) {
    if (typeof proof[key] !== 'string' || proof[key].trim().length === 0) {
      throw executionError('isolated_surface_unproven', 'The separate browsing screen check is incomplete.');
    }
  }
}

function executionError(code, message) {
  return new ComputerInterfaceActionError(code, message);
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []));
  if (!args.input || !args.providers || !args.output) {
    throw executionError('missing_argument', 'Required browsing setup files are missing.');
  }
  const [request, providers] = await Promise.all([
    readFile(args.input, 'utf8').then(JSON.parse),
    readFile(args.providers, 'utf8').then(JSON.parse),
  ]);
  await writeFile(args.output, JSON.stringify(prepareComputerInterfaceSession(request, providers)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({ok: false, code: error.code ?? 'unexpected_error', error: error.message}) + '\n');
    process.exit(1);
  });
}
