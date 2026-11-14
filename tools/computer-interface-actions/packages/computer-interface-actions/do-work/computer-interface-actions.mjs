import { createHash } from 'node:crypto';

export const COMPUTER_INTERFACE_OPERATIONS = Object.freeze([
  'provider.status',
  'cli.exec',
  'shell.exec',
  'browser.fetch',
  'browser.screenshot',
  'app.open',
  'ui.status',
  'ui.click',
  'ui.type',
  'ui.press_key',
]);

const SECRET_KEY_PATTERN = /(?:pass(?:word)?|token|cookie|credential|secret|authorization|api[_-]?key|refresh|access[_-]?key)/i;
const SECRET_VALUE_PATTERN = /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{10,}\b|\bey[a-z0-9_-]{20,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/gi;

export class ComputerInterfaceActionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ComputerInterfaceActionError';
    this.code = code;
  }
}

export function findComputerInterfaceProvider(request, providersDoc) {
  assertObject(request, 'request');
  assertObject(providersDoc, 'providers document');
  if (!Array.isArray(providersDoc.providers)) {
    throw new ComputerInterfaceActionError('invalid_provider_table', 'Computer controls are unavailable because their setup is incomplete.');
  }
  if (typeof request.provider_id !== 'string' || request.provider_id.length === 0) {
    throw new ComputerInterfaceActionError('missing_provider', 'Choose a computer control option.');
  }
  const matches = providersDoc.providers.filter((candidate) => candidate?.id === request.provider_id);
  if (matches.length === 0) {
    throw new ComputerInterfaceActionError('unknown_provider', `The computer control option "${request.provider_id}" is not available.`);
  }
  if (matches.length !== 1) {
    throw new ComputerInterfaceActionError('ambiguous_provider', `More than one computer control option is named "${request.provider_id}".`);
  }
  const [provider] = matches;
  if (typeof provider.kind !== 'string' || provider.kind.length === 0) {
    throw new ComputerInterfaceActionError('invalid_provider', 'The selected computer control option has incomplete setup.');
  }
  if (!Array.isArray(provider.operations) || provider.operations.length === 0) {
    throw new ComputerInterfaceActionError('invalid_provider', 'The selected computer control option has no available actions.');
  }
  return provider;
}

export function buildComputerInterfaceAction(request, providersDoc) {
  assertObject(request, 'request');
  const provider = findComputerInterfaceProvider(request, providersDoc);
  const operation = request.operation;
  if (!COMPUTER_INTERFACE_OPERATIONS.includes(operation)) {
    throw new ComputerInterfaceActionError('unknown_operation', `The requested computer action "${String(operation)}" is not supported.`);
  }
  if (!provider.operations.includes(operation)) {
    throw new ComputerInterfaceActionError('provider_operation_unsupported', `The selected computer control option cannot perform "${operation}".`);
  }

  if (operation === 'provider.status') {
    return { operation, provider_id: provider.id, provider_kind: provider.kind };
  }

  if (operation === 'cli.exec') {
    if (typeof request.command !== 'string' || request.command.length === 0) {
      throw new ComputerInterfaceActionError('missing_command', 'Enter a command to run.');
    }
    if (request.command.length > 16384) {
      throw new ComputerInterfaceActionError('invalid_command', 'The command is longer than 16,384 characters.');
    }
    const action = {
      operation,
      provider_id: provider.id,
      provider_kind: provider.kind,
      command: request.command,
    };
    if (request.timeout_ms !== undefined) {
      if (typeof request.timeout_ms !== 'number' || request.timeout_ms <= 0 || request.timeout_ms > provider.run_timeout_ms) {
        throw new ComputerInterfaceActionError('invalid_timeout', `Choose a time limit from 1 to ${provider.run_timeout_ms} milliseconds.`);
      }
      action.timeout_ms = request.timeout_ms;
    }
    validateSensitiveApproval(action, provider, request);
    return action;
  }

  if (operation === 'app.open') {
    if (typeof request.app_name !== 'string' || request.app_name.length === 0) {
      throw new ComputerInterfaceActionError('missing_app_name', 'Choose an app to open.');
    }
    return {
      operation,
      provider_id: provider.id,
      provider_kind: provider.kind,
      app_name: request.app_name,
    };
  }

  if (operation === 'shell.exec') {
    if (typeof request.command !== 'string' || request.command.length === 0) {
      throw new ComputerInterfaceActionError('missing_command', 'Enter a command to run.');
    }
    if (request.command.length > 16384) {
      throw new ComputerInterfaceActionError('invalid_command', 'The command is longer than 16,384 characters.');
    }
    const action = {
      operation,
      provider_id: provider.id,
      provider_kind: provider.kind,
      command: request.command,
    };
    validateSensitiveApproval(action, provider, request);
    return action;
  }

  if (operation === 'browser.fetch') {
    if (typeof request.url !== 'string' || request.url.length === 0) {
      throw new ComputerInterfaceActionError('missing_url', 'Enter the page address to open.');
    }
    const url = new URL(request.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ComputerInterfaceActionError('invalid_url', 'The page address must begin with http:// or https://.');
    }
    return {
      operation,
      provider_id: provider.id,
      provider_kind: provider.kind,
      url: url.toString(),
      ...(request.dump ? { dump: String(request.dump) } : {}),
    };
  }

  if (operation === 'browser.screenshot') {
    if (typeof request.url !== 'string' || request.url.length === 0) {
      throw new ComputerInterfaceActionError('missing_url', 'Enter the page address to capture.');
    }
    const url = new URL(request.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ComputerInterfaceActionError('invalid_url', 'The page address must begin with http:// or https://.');
    }
    if (typeof request.output_path !== 'string' || request.output_path.length === 0) {
      throw new ComputerInterfaceActionError('missing_output_path', 'Choose a file name for the screenshot.');
    }
    return {
      operation,
      provider_id: provider.id,
      provider_kind: provider.kind,
      url: url.toString(),
      output_path: request.output_path,
    };
  }

  if (operation === 'ui.status') {
    return {
      operation,
      provider_id: provider.id,
      provider_kind: provider.kind,
    };
  }

  if (operation === 'ui.click') {
    if (typeof request.x !== 'number' || typeof request.y !== 'number') {
      throw new ComputerInterfaceActionError('missing_coordinates', 'Choose the horizontal and vertical position to click.');
    }
    const action = {
      operation,
      provider_id: provider.id,
      provider_kind: provider.kind,
      x: request.x,
      y: request.y,
    };
    validateSensitiveApproval(action, provider, request);
    return action;
  }

  if (operation === 'ui.type') {
    if (typeof request.text !== 'string' || request.text.length === 0) {
      throw new ComputerInterfaceActionError('missing_text', 'Enter the text to type.');
    }
    if (request.text.length > 16384) {
      throw new ComputerInterfaceActionError('invalid_text', 'The text is longer than 16,384 characters.');
    }
    const action = {
      operation,
      provider_id: provider.id,
      provider_kind: provider.kind,
      text: request.text,
    };
    validateSensitiveApproval(action, provider, request);
    return action;
  }

  if (operation === 'ui.press_key') {
    if (typeof request.key !== 'string' || request.key.length === 0) {
      throw new ComputerInterfaceActionError('missing_key', 'Choose a key to press.');
    }
    const action = {
      operation,
      provider_id: provider.id,
      provider_kind: provider.kind,
      key: request.key,
      ...(Array.isArray(request.modifiers) ? { modifiers: request.modifiers.filter((m) => typeof m === 'string') } : {}),
    };
    validateSensitiveApproval(action, provider, request);
    return action;
  }

  throw new ComputerInterfaceActionError('unknown_operation', `The requested computer action "${String(operation)}" is not supported.`);
}

function validateSensitiveApproval(action, provider, request) {
  const sensitiveOperations = provider.sensitive_operations || [];
  if (!sensitiveOperations.includes(action.operation)) return;
  const approval = request.approval;
  if (!approval || typeof approval !== 'object') {
    throw new ComputerInterfaceActionError('approval_required', 'This action needs your approval for the exact screen and action.');
  }
  if (
    typeof approval.approved_by_ref !== 'string'
    || !(provider.approval_authority_refs ?? []).includes(approval.approved_by_ref)
  ) {
    throw new ComputerInterfaceActionError('approval_required', 'The approval does not come from an allowed person or account.');
  }
  if (typeof approval.target_identity !== 'string' || approval.target_identity.length === 0) {
    throw new ComputerInterfaceActionError('approval_required', 'The approval must name the exact screen or service.');
  }
  if (approval.target_identity !== provider.id) {
    throw new ComputerInterfaceActionError('approval_target_mismatch', 'The approval is for a different screen or service.');
  }
  const expectedHash = buildActionHash(action);
  if (typeof approval.action_hash !== 'string' || approval.action_hash !== expectedHash) {
    throw new ComputerInterfaceActionError('approval_hash_mismatch', 'The approval is for a different action.');
  }
}

export function buildActionHash(action) {
  const canonical = JSON.stringify({
    operation: action.operation,
    provider_id: action.provider_id,
    provider_kind: action.provider_kind,
    ...(action.command !== undefined ? { command: action.command } : {}),
    ...(action.timeout_ms !== undefined ? { timeout_ms: action.timeout_ms } : {}),
    ...(action.app_name !== undefined ? { app_name: action.app_name } : {}),
    ...(action.url !== undefined ? { url: action.url } : {}),
    ...(action.dump !== undefined ? { dump: action.dump } : {}),
    ...(action.output_path !== undefined ? { output_path: action.output_path } : {}),
    ...(action.x !== undefined ? { x: action.x, y: action.y } : {}),
    ...(action.text !== undefined ? { text: action.text } : {}),
    ...(action.key !== undefined ? { key: action.key, ...(action.modifiers ? { modifiers: action.modifiers } : {}) } : {}),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function redactSecrets(value) {
  if (typeof value === 'string') {
    return value.replace(SECRET_VALUE_PATTERN, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSecrets(val);
    }
    return out;
  }
  return value;
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ComputerInterfaceActionError('invalid_request', 'Required action details are missing.');
  }
}
