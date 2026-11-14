import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { redactSecrets } from './computer-interface-actions.mjs';

const PROVIDER_ADAPTERS = {
  official_cli: runOfficialCliAction,
  apple_script: runAppleScriptAction,
  headless_browser: runHeadlessBrowserAction,
};

export async function dispatchComputerInterfaceAction(action, provider) {
  const adapter = PROVIDER_ADAPTERS[provider.kind];
  if (!adapter) {
    return {
      ok: false,
      status: 'restricted',
      provider_id: provider.id,
      error: `no adapter for provider kind "${provider.kind}"`,
    };
  }
  return adapter(action, provider);
}

async function runOfficialCliAction(action, provider) {
  const executablePath = await findExecutable(provider.executable);
  if (!executablePath) {
    return {
      ok: false,
      status: 'restricted',
      provider_id: provider.id,
      restricted_reason: 'cli_not_installed',
      install_hint: provider.install_path_hint || 'Install the provider CLI through its documented path',
    };
  }

  if (action.operation === 'provider.status') {
    return {
      ok: true,
      status: 'ready',
      provider_id: provider.id,
      executable_path: executablePath,
      operations: provider.operations,
    };
  }

  if (action.operation === 'cli.exec') {
    const result = await invokeCli(executablePath, action.command, action.timeout_ms || provider.run_timeout_ms);
    return {
      ok: result.exitCode === 0,
      status: result.exitCode === 0 ? 'completed' : 'failed',
      provider_id: provider.id,
      exit_code: result.exitCode,
      stdout: redactSecrets(result.stdout),
      stderr: redactSecrets(result.stderr),
    };
  }

  return { ok: false, status: 'restricted', provider_id: provider.id, error: 'unhandled operation' };
}

async function runAppleScriptAction(action, provider) {
  if (action.operation === 'app.open') {
    const script = `tell application "${action.app_name}" to activate`;
    const result = await invokeOsascript(script);
    return {
      ok: result.exitCode === 0,
      status: result.exitCode === 0 ? 'completed' : 'failed',
      provider_id: provider.id,
      operation: action.operation,
      app_name: action.app_name,
      ...(result.exitCode !== 0 ? { error: redactSecrets(result.stderr) } : {}),
    };
  }

  if (action.operation === 'shell.exec') {
    const escapedCommand = action.command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `do shell script "${escapedCommand}"`;
    const result = await invokeOsascript(script);
    return {
      ok: result.exitCode === 0,
      status: result.exitCode === 0 ? 'completed' : 'failed',
      provider_id: provider.id,
      operation: action.operation,
      stdout: redactSecrets(result.stdout),
      ...(result.exitCode !== 0 ? { stderr: redactSecrets(result.stderr) } : {}),
    };
  }

  if (action.operation === 'ui.status') {
    const script = `
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  set windowList to ""
  repeat with w in windows of application process frontApp
    set windowList to windowList & name of w & "\\n"
  end repeat
  return frontApp & "|" & windowList
end tell`;
    const result = await invokeOsascript(script);
    return {
      ok: result.exitCode === 0,
      status: result.exitCode === 0 ? 'completed' : 'failed',
      provider_id: provider.id,
      operation: action.operation,
      ...(result.exitCode === 0 ? { stdout: redactSecrets(result.stdout) } : { error: redactSecrets(result.stderr) }),
    };
  }

  if (action.operation === 'ui.click') {
    const script = `tell application "System Events" to click at {${action.x}, ${action.y}}`;
    const result = await invokeOsascript(script);
    return {
      ok: result.exitCode === 0,
      status: result.exitCode === 0 ? 'completed' : 'failed',
      provider_id: provider.id,
      operation: action.operation,
      x: action.x,
      y: action.y,
      ...(result.exitCode !== 0 ? { error: redactSecrets(result.stderr) } : {}),
    };
  }

  if (action.operation === 'ui.type') {
    const escapedText = action.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `tell application "System Events" to keystroke "${escapedText}"`;
    const result = await invokeOsascript(script);
    return {
      ok: result.exitCode === 0,
      status: result.exitCode === 0 ? 'completed' : 'failed',
      provider_id: provider.id,
      operation: action.operation,
      ...(result.exitCode !== 0 ? { error: redactSecrets(result.stderr) } : {}),
    };
  }

  if (action.operation === 'ui.press_key') {
    const modifiers = (action.modifiers || []).join(', ');
    const modifierPrefix = modifiers ? `${modifiers} down ` : '';
    const script = `tell application "System Events" to key code ${keyCodeFor(action.key)}${modifiers ? ` using {${modifiers} down}` : ''}`;
    const result = await invokeOsascript(script);
    return {
      ok: result.exitCode === 0,
      status: result.exitCode === 0 ? 'completed' : 'failed',
      provider_id: provider.id,
      operation: action.operation,
      key: action.key,
      ...(result.exitCode !== 0 ? { error: redactSecrets(result.stderr) } : {}),
    };
  }

  return { ok: false, status: 'restricted', provider_id: provider.id, error: 'unhandled operation' };
}

async function runHeadlessBrowserAction(action, provider) {
  const executablePath = await findExecutable(provider.executable);
  const binaryAvailable = executablePath !== null;

  if (action.operation === 'provider.status') {
    return {
      ok: binaryAvailable,
      status: binaryAvailable ? 'ready' : 'restricted',
      provider_id: provider.id,
      ...(binaryAvailable
        ? { executable_path: executablePath, operations: provider.operations }
        : { restricted_reason: 'binary_not_found' }),
    };
  }

  if (!binaryAvailable) {
    return {
      ok: false,
      status: 'restricted',
      provider_id: provider.id,
      restricted_reason: 'binary_not_found',
    };
  }

  if (action.operation === 'browser.fetch') {
    const args = ['fetch', action.url];
    if (action.dump) args.push('--dump', action.dump);
    const result = await spawnBinary(executablePath, args, provider.run_timeout_ms);
    return {
      ok: result.exitCode === 0,
      status: result.exitCode === 0 ? 'completed' : 'failed',
      provider_id: provider.id,
      operation: action.operation,
      url: action.url,
      ...(result.stdout ? { content: redactSecrets(result.stdout) } : {}),
      ...(result.exitCode !== 0 ? { error: redactSecrets(result.stderr) } : {}),
    };
  }

  if (action.operation === 'browser.screenshot') {
    const result = await spawnBinary(
      executablePath,
      ['fetch', action.url, '--screenshot', action.output_path],
      provider.run_timeout_ms,
    );
    return {
      ok: result.exitCode === 0,
      status: result.exitCode === 0 ? 'completed' : 'failed',
      provider_id: provider.id,
      operation: action.operation,
      url: action.url,
      output_path: action.output_path,
      ...(result.exitCode !== 0 ? { error: redactSecrets(result.stderr) } : {}),
    };
  }

  return { ok: false, status: 'restricted', provider_id: provider.id, error: 'unhandled operation' };
}

function spawnBinary(executablePath, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(executablePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { if (stdout.length < 262144) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 65536) stderr += chunk; });
    child.on('close', (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
    child.on('error', (error) => resolve({ exitCode: -1, stdout, stderr: error.message }));
  });
}

function keyCodeFor(key) {
  const KEY_CODES = {
    return: 36, enter: 36, space: 49, tab: 48, escape: 53,
    delete: 51, backspace: 51, arrowleft: 123, arrowright: 124,
    arrowdown: 125, arrowup: 126, home: 115, end: 119,
    pageup: 116, pagedown: 121,
  };
  return KEY_CODES[key.toLowerCase()] ?? key;
}

async function invokeOsascript(script) {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/osascript', ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { if (stdout.length < 65536) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 65536) stderr += chunk; });
    child.on('close', (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
    child.on('error', (error) => resolve({ exitCode: -1, stdout, stderr: error.message }));
  });
}

async function findExecutable(name) {
  const searchPaths = (process.env.PATH || '')
    .split(':')
    .filter(Boolean)
    .map((dir) => `${dir}/${name}`);
  for (const p of searchPaths) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

function invokeCli(executablePath, command, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(executablePath, ['exec', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { if (stdout.length < 65536) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 65536) stderr += chunk; });
    child.on('close', (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
    child.on('error', (error) => resolve({ exitCode: -1, stdout, stderr: error.message }));
  });
}
