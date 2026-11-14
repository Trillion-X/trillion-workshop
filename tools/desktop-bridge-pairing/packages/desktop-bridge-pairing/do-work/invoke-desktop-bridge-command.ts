// packages/desktop-bridge-pairing/do-work/invoke-desktop-bridge-command.ts
//
// Local boundary for the current Tauri desktop bridge command seam.

export async function invokeDesktopBridgeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (typeof window === 'undefined') {
    throw new Error('Tauri API not available in server context');
  }

  const tauri = (window as any).__TAURI__;
  if (!tauri) {
    throw new Error('Tauri API not available - run inside the Tauri desktop app, not a browser');
  }

  const invoke = tauri.core?.invoke ?? tauri.invoke;
  if (!invoke) {
    throw new Error('Tauri invoke function not found');
  }

  return invoke(command, args);
}
