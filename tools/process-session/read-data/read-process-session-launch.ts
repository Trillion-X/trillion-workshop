export type EnvBinding =
  | {
      kind: 'literal';
      name: string;
      value: string;
      inert: true;
    }
  | {
      kind: 'credential-handle';
      name: string;
      handleRef: string;
    };

export type PathBinding =
  | {
      kind: 'owner-resolved';
      value: string;
      policyHandle: string;
    }
  | {
      kind: 'path-handle';
      handleRef: string;
      displayValue?: string;
    }
  | {
      kind: 'literal';
      value: string;
      inert: true;
    };

export interface ProcessSessionLaunchInput {
  argv: string[];
  cwd?: PathBinding;
  env?: EnvBinding[];
  timeoutMs?: number;
  terminationGraceMs?: number;
  pipeEofTimeoutMs?: number;
  containmentKind?: 'leaf' | 'descendant_effect_contained';
  inputs?: ProcessInputMount[];
  sessionSettings?: ProcessSessionSettings;
}

export type ProcessInputMount = {
  mount_path: string;
  source:
    | { kind: 'inline'; bytes: string }
    | { kind: 'blob_ref'; hash: string };
  content_type?: string | null;
  executable?: boolean;
};

export interface PortableProcessDescriptor {
  argv: string[];
  cwd: string | null;
  timeout_ms: number;
  termination_grace_ms: number;
  expected_termination: null;
  env: Record<string, string>;
  inputs: ProcessInputMount[];
  input_trees: [];
  outputs: [];
  containment:
    | { kind: 'leaf' }
    | {
        kind: 'descendant_effect_contained';
        pipe_eof_timeout_ms: number;
        publications: [];
      };
  capture_fds: [1, 2];
  collected_files: [];
}

export interface ProcessSessionSettings {
  text_grid: { columns: number; rows: number } | null;
}

export type ProcessWorkspaceArgumentValuePart =
  | { kind: 'literal'; value: string }
  | { kind: 'workspace_root' }
  | { kind: 'workspace_path'; segments: string[] };

export interface ProcessWorkspaceExecutionBindings {
  environment: Array<{
    key: string;
    parts: Array<
      | { kind: 'literal'; value: string }
      | { kind: 'workspace_root' }
      | { kind: 'workspace_path'; segments: string[] }
      | { kind: 'portable_environment_value'; key: string }
    >;
  }>;
  arguments?: Array<{ index: number; parts: ProcessWorkspaceArgumentValuePart[] }>;
}

/** Exact `execution-types::ProcessSessionDescriptor` wire shape. */
export interface ProcessSessionLaunchDescriptor {
  process: PortableProcessDescriptor;
  workspace_bindings?: ProcessWorkspaceExecutionBindings;
  session_settings: ProcessSessionSettings;
}

export interface ConfiguredTargetDescriptor {
  target: string;
  timeoutMs?: number;
}

export interface ConfiguredTimedTargetDescriptor extends ConfiguredTargetDescriptor {
  timeoutMs: number;
}

const PROCESS_CONTROL_ENV = new Set([
  'PATH',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'BASH_ENV',
  'ENV',
  'TERMINAL',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function publishedRecordRows(contract: unknown): Record<string, unknown>[] {
  if (!isRecord(contract) || !Array.isArray(contract.things)) return [];
  return contract.things
    .filter(isRecord)
    .filter((thing) => thing.type === 'record' && thing.remove !== true)
    .map((thing) => {
      if (isRecord(thing.payload) && isRecord(thing.payload.record)) return thing.payload.record;
      return {
        address: thing.address,
        path: thing.path,
        payload: thing.payload,
      };
    });
}

function payloadMatchesSelector(payload: Record<string, unknown>, selectorKey: string): boolean {
  return Object.entries(payload).some(([key, value]) => {
    return typeof value === 'string'
      && value === selectorKey
      && (key === 'target_key' || key === 'selector_key' || key.endsWith('_target'));
  });
}

function readConfiguredTimeoutMs(payload: Record<string, unknown>, selectorKey: string): number | undefined {
  const timeoutMs = payload.timeout_ms ?? payload.timeoutMs;
  if (timeoutMs === undefined) return undefined;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid configured target timeout_ms: ${selectorKey}`);
  }
  return timeoutMs;
}

export function readConfiguredTarget(records: unknown, selectorKey: string): ConfiguredTargetDescriptor {
  for (const record of publishedRecordRows(records)) {
    if (!isRecord(record.payload)) continue;
    const target = record.payload.target;
    if (typeof target === 'string' && target.length > 0 && payloadMatchesSelector(record.payload, selectorKey)) {
      const timeoutMs = readConfiguredTimeoutMs(record.payload, selectorKey);
      return {
        target,
        ...(timeoutMs ? { timeoutMs } : {}),
      };
    }
  }
  throw new Error(`Missing configured target: ${selectorKey}`);
}

export function readConfiguredProcessSessionTarget(records: unknown, selectorKey: string): string {
  return readConfiguredTarget(records, selectorKey).target;
}

export function readConfiguredTimedTarget(records: unknown, selectorKey: string): ConfiguredTimedTargetDescriptor {
  const descriptor = readConfiguredTarget(records, selectorKey);
  if (descriptor.timeoutMs === undefined) {
    throw new Error(`Missing configured target timeout_ms: ${selectorKey}`);
  }
  return {
    target: descriptor.target,
    timeoutMs: descriptor.timeoutMs,
  };
}

function validateEnvBinding(binding: EnvBinding): void {
  if (!binding.name) throw new Error('EnvBinding name is required');
  if (PROCESS_CONTROL_ENV.has(binding.name) && binding.kind === 'literal') {
    throw new Error(`Process-control env ${binding.name} requires an owner policy handle`);
  }
  if (binding.kind === 'literal' && binding.inert !== true) {
    throw new Error(`Literal env ${binding.name} must be owner-declared inert`);
  }
  if (binding.kind === 'credential-handle' && !binding.handleRef) {
    throw new Error(`Credential env ${binding.name} requires handleRef`);
  }
}

function containsTraversal(value: string): boolean {
  return value.replaceAll('\\', '/').split('/').includes('..');
}

function isPortableRelativePath(value: string, allowCurrentDirectory = false): boolean {
  if (value.length === 0 || value.includes('\0') || value.includes('\\') || value.startsWith('/')) {
    return false;
  }
  if (containsTraversal(value)) return false;
  if (value === '.') return allowCurrentDirectory;
  return value.split('/').some((component) => component !== '' && component !== '.');
}

function renderPathBinding(binding: PathBinding): string {
  if (binding.kind === 'owner-resolved') {
    if (!binding.policyHandle) throw new Error('Owner-resolved path requires policyHandle');
    if (!isPortableRelativePath(binding.value, true)) {
      throw new Error('Owner-resolved cwd must be portable and relative, never absolute or traversing');
    }
    return binding.value;
  }
  if (binding.kind === 'path-handle') {
    if (!binding.handleRef) throw new Error('Path handle requires handleRef');
    throw new Error('Path handles require owner admission and cannot enter a portable process descriptor');
  }
  if (binding.inert !== true) throw new Error('Literal path must be owner-declared inert');
  if (!isPortableRelativePath(binding.value, true)) {
    throw new Error('Literal cwd must be portable and relative, never absolute or traversing');
  }
  return binding.value;
}

function readPositiveInteger(value: number | undefined, fallback: number, field: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return candidate;
}

function validateArgv(argv: string[], inputs: ProcessInputMount[]): void {
  if (argv.length === 0) throw new Error('Process-session launch descriptor requires argv');
  if (!isPortableRelativePath(argv[0])) {
    throw new Error('Process-session argv[0] must be a portable runtime alias or executable input mount');
  }
  if (argv[0].includes('/')) {
    const executableInput = inputs.some((input) => input.executable === true && input.mount_path === argv[0]);
    if (!executableInput) {
      throw new Error('A relative process-session executable must name an executable input mount');
    }
  }
}

function validateInputs(inputs: ProcessInputMount[]): void {
  for (const input of inputs) {
    if (!isPortableRelativePath(input.mount_path)) {
      throw new Error('Process-session input mount_path must be portable and relative');
    }
    if (input.source.kind === 'inline' && typeof input.source.bytes !== 'string') {
      throw new Error('Inline process-session input bytes must be canonical base64 text');
    }
    if (input.source.kind === 'blob_ref' && !input.source.hash) {
      throw new Error('Process-session blob_ref input requires a hash');
    }
  }
}

function validateSessionSettings(settings: ProcessSessionSettings): void {
  if (settings.text_grid === null) return;
  if (!Number.isSafeInteger(settings.text_grid.columns) || settings.text_grid.columns <= 0) {
    throw new Error('session_settings.text_grid.columns must be a positive integer');
  }
  if (!Number.isSafeInteger(settings.text_grid.rows) || settings.text_grid.rows <= 0) {
    throw new Error('session_settings.text_grid.rows must be a positive integer');
  }
}

export function renderProcessSessionLaunchDescriptor(input: ProcessSessionLaunchInput): ProcessSessionLaunchDescriptor {
  if (!Array.isArray(input.argv) || input.argv.some((entry) => typeof entry !== 'string')) {
    throw new Error('Process-session argv must contain only strings');
  }
  const argv = [...input.argv];
  const inputs = input.inputs ?? [];
  validateInputs(inputs);
  validateArgv(argv, inputs);

  const env: Record<string, string> = {};
  for (const binding of input.env ?? []) {
    validateEnvBinding(binding);
    if (binding.kind === 'literal') env[binding.name] = binding.value;
    if (binding.kind === 'credential-handle') {
      throw new Error('Credential handles require an owner materialization and cannot enter process env');
    }
  }

  const sessionSettings = input.sessionSettings ?? { text_grid: null };
  validateSessionSettings(sessionSettings);
  return {
    process: {
      argv,
      cwd: input.cwd ? renderPathBinding(input.cwd) : null,
      timeout_ms: readPositiveInteger(input.timeoutMs, 300_000, 'timeout_ms'),
      termination_grace_ms: readPositiveInteger(input.terminationGraceMs, 1_000, 'termination_grace_ms'),
      expected_termination: null,
      env,
      inputs,
      input_trees: [],
      outputs: [],
      containment: input.containmentKind === 'leaf'
        ? { kind: 'leaf' }
        : {
            kind: 'descendant_effect_contained',
            pipe_eof_timeout_ms: readPositiveInteger(input.pipeEofTimeoutMs, 1_000, 'containment.pipe_eof_timeout_ms'),
            publications: [],
          },
      capture_fds: [1, 2],
      collected_files: [],
    },
    session_settings: sessionSettings,
  };
}
