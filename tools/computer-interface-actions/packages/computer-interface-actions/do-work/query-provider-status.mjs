#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function queryProviderStatus(request, providersDoc, context = {}) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw statusError('invalid_request', 'Choose a browsing option to check.');
  }
  if (request.operation !== 'provider.status') {
    throw statusError('unsupported_operation', 'This check only reports whether a browsing option is available.');
  }
  if (!Array.isArray(providersDoc?.providers)) {
    throw statusError('invalid_provider_table', 'Browsing options are unavailable because their setup is incomplete.');
  }
  const matches = providersDoc.providers.filter((provider) => provider?.id === request.provider_id);
  if (matches.length === 0) throw statusError('unknown_provider', `The browsing option "${String(request.provider_id)}" is not available.`);
  if (matches.length !== 1) throw statusError('ambiguous_provider', `More than one browsing option is named "${request.provider_id}".`);
  const provider = matches[0];
  if (!Array.isArray(provider.operations) || !provider.operations.includes('provider.status')) {
    throw statusError('provider_operation_unsupported', `The browsing option "${provider.id}" cannot report its status.`);
  }
  if (typeof provider.executable === 'string' && provider.executable.includes('/')) {
    throw statusError('invalid_executable', 'This browsing option is not safely configured.');
  }
  if (context.resolveAdmission === true) {
    return {
      provider_id: provider.id,
      runtime_alias: provider.executable ?? null,
      surface_class: provider.surface_class ?? null,
      isolated_surface_proven: false,
    };
  }
  if (typeof provider.executable !== 'string' || provider.executable.length === 0) {
    return {
      ok: true,
      status: 'declared',
      provider_id: provider.id,
      provider_kind: provider.kind,
      intent_classes: provider.intent_classes ?? [],
      surface_class: provider.surface_class ?? null,
      operations: provider.operations,
      executable_available: null,
      isolated_surface_proven: false,
    };
  }
  const executablePath = await (context.findExecutable ?? findExecutable)(
    provider.executable,
    context.pathValue,
    context.accessImpl,
  );
  return {
    ok: executablePath !== null,
    status: executablePath === null ? 'restricted' : 'ready',
    provider_id: provider.id,
    provider_kind: provider.kind,
    intent_classes: provider.intent_classes ?? [],
    surface_class: provider.surface_class ?? null,
    operations: provider.operations,
    executable_available: executablePath !== null,
    ...(executablePath === null ? { restricted_reason: 'cli_not_installed' } : { executable_path: executablePath }),
    isolated_surface_proven: false,
    required_next_proof: provider.surface_class === 'task_isolated_agent_screen'
      ? ['surface_identity', 'isolation_scope=task', 'independent_pointer=true', 'independent_keyboard=true', 'input_focus_identity']
      : [],
  };
}

export async function findExecutable(name, pathValue = process.env.PATH ?? '', accessImpl = access) {
  if (name.includes('/')) throw statusError('invalid_executable', 'This browsing option is not safely configured.');
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      await accessImpl(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function statusError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []));
  if (!args.input || !args.providers || !args.output) {
    throw statusError('missing_argument', 'Required browsing setup files are missing.');
  }
  const [request, providers] = await Promise.all([
    readFile(args.input, 'utf8').then(JSON.parse),
    readFile(args.providers, 'utf8').then(JSON.parse),
  ]);
  await writeFile(args.output, JSON.stringify(await queryProviderStatus(request, providers, {
    resolveAdmission: args['resolve-admission'] === 'true',
  })));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({ ok: false, code: error.code ?? 'unexpected_error', error: error.message }) + '\n');
    process.exit(1);
  });
}
