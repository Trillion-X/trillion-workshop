// file: parts/ui/show/ai-app-bridge/ai-app-bridge.mjs
//
// HOW A VIEW AN AI APP DRAWS TALKS TO THE APP.
//
// An AI app (ChatGPT, Claude) loads a tool's view in its own sandboxed frame and talks to it over one of two roads:
// the MCP Apps bridge (JSON-RPC over postMessage: the view asks `ui/initialize`, says `ui/notifications/initialized`,
// hears `ui/notifications/tool-input-partial` and `ui/notifications/tool-input` while and once the AI has written the call's
// arguments, hears `ui/notifications/tool-result`, asks `tools/call`, tells `ui/notifications/size-changed`, asks `ui/open-link`)
// or ChatGPT's own `window.openai` (toolOutput and toolResponseMetadata announced by `openai:set_globals`, callTool,
// notifyIntrinsicHeight, openExternal). This is the one place both roads are spoken; a view hands it what to do with a
// result and asks it for calls, sizes and links.
//
// Invariants
// - A tool result is handed on once per distinct result, whichever road brings it first; the same result by the other
//   road is ignored. An empty `window.openai.toolOutput` is the app still waiting, never a result.
// - The call's arguments are handed on as the app gives them: growing while the AI still writes them (`partial`), then
//   whole (MCP Apps `tool-input`, or `window.openai.toolInput`), each distinct one once.
// - `callTool` asks the app over the MCP Apps road; when that road has not answered `ui/initialize` and the app offers
//   `window.openai.callTool`, it asks there. A call the app refuses, or answers as an error, rejects with the app's or
//   the tool's own words. The view never holds a credential: the app makes the call as the person who connected it.
// - The height told is where `content` (the element the view fills) ends, never the frame the app first gave it.
// - What the app says about where the view sits (`hostContext`: its display mode and the most height it gives) is kept
//   as the app last said it, from `ui/initialize`, `ui/notifications/host-context-changed` or `window.openai`, so a view
//   sizes itself to what the app allows. A display mode is asked for, never assumed: the app answers which it gave.
// - `win` is the view's window, passed in so the bridge runs the same in a browser and in a test.
// - MCP messages come from the embedding parent window, including when its origin is opaque.

/** Starts talking to the app. `onToolResult(result)` receives `{ structuredContent, meta, content, isError }` for each
 * distinct tool result; `onToolInput(args, { partial })` the call's arguments, growing and then whole. Answers `{ callTool, reportSize, placement, onPlacement, askDisplayMode, openLink, stop }`. */
export function connectToAiApp(win, { appName = 'view', protocolVersion = '2026-01-26', onToolResult = () => {}, onToolInput = () => {}, content = null, displayModes = ['inline'] } = {}) {
  const initializeId = `${appName}-initialize`;
  let answered = false;
  let asked = 0;
  let lastResult = null;
  let lastInput = null;
  let context = {};
  const listeners = new Set();
  const heard = next => { context = { ...context, ...next }; for (const listener of listeners) listener(context); };
  const waiting = new Map();
  const post = message => win.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const hand = result => {
    const key = JSON.stringify([result.structuredContent ?? null, result.meta ?? null, result.isError]);
    if (key === lastResult) return;
    lastResult = key;
    onToolResult(result);
  };
  const handInput = (args, partial) => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return;
    // Growing arguments come once each, many while the AI writes, so only the whole ones (which may come by both roads)
    // are compared.
    if (!partial) {
      const key = JSON.stringify(args);
      if (key === lastInput) return;
      lastInput = key;
    }
    onToolInput(args, { partial });
  };
  const fromOpenAi = () => {
    const input = win.openai?.toolInput;
    if (input && typeof input === 'object' && Object.keys(input).length) handInput(input, false);
    const output = win.openai?.toolOutput;
    if (output && typeof output === 'object' && Object.keys(output).length) hand({ structuredContent: output, meta: win.openai?.toolResponseMetadata ?? null, content: [], isError: false });
  };
  const onMessage = event => {
    if (event.source !== win.parent) return;
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.id === initializeId && 'result' in message) {
      answered = true;
      if (message.result?.hostContext) heard(message.result.hostContext);
      post({ method: 'ui/notifications/initialized', params: {} });
      return;
    }
    if (message.id !== undefined && waiting.has(message.id) && ('result' in message || 'error' in message)) {
      const { resolve, reject } = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) reject(new Error(String(message.error.message ?? 'The app refused this.')));
      else resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/host-context-changed') { heard(message.params ?? {}); return; }
    if (message.method === 'ui/notifications/tool-input-partial' || message.method === 'ui/notifications/tool-input') {
      handInput(message.params?.arguments, message.method === 'ui/notifications/tool-input-partial');
      return;
    }
    if (message.method === 'ui/notifications/tool-result') {
      const params = message.params ?? {};
      hand({ structuredContent: params.structuredContent ?? null, meta: params._meta ?? null, content: Array.isArray(params.content) ? params.content : [], isError: params.isError === true });
    }
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    asked += 1;
    const id = `${appName}-${asked}`;
    waiting.set(id, { resolve, reject });
    post({ id, method, params });
  });
  const fromOpenAiPlacement = () => { for (const listener of listeners) listener(context); };
  win.addEventListener('openai:set_globals', fromOpenAi);
  win.addEventListener('openai:set_globals', fromOpenAiPlacement);
  win.addEventListener('message', onMessage);
  post({ id: initializeId, method: 'ui/initialize', params: { protocolVersion, appInfo: { name: appName, version: '1' }, appCapabilities: { availableDisplayModes: displayModes } } });
  fromOpenAi();
  const root = win.document.documentElement;
  const heightNeeded = () => Math.ceil(content ? content.getBoundingClientRect().bottom + (win.scrollY ?? 0) : root.scrollHeight);
  // The words a failed call result carries, else a plain line.
  const failureOf = result => [result?.content?.find?.(block => typeof block?.text === 'string')?.text, result?.structuredContent?.error]
    .find(text => typeof text === 'string' && text.trim())?.trim() ?? 'Trillion could not answer this. Try again.';
  return {
    /** Calls one of the server's tools as the person who connected the app; answers the tool's structured result. */
    callTool: async (name, args = {}) => {
      const viaOpenAi = !answered && typeof win.openai?.callTool === 'function';
      const result = viaOpenAi ? await win.openai.callTool(name, args) : await request('tools/call', { name, arguments: args });
      if (result?.isError) throw new Error(failureOf(result));
      return result?.structuredContent ?? result;
    },
    /** Tells the app the height the view needs, by both roads. */
    reportSize: () => {
      const height = heightNeeded();
      post({ method: 'ui/notifications/size-changed', params: { width: root.scrollWidth, height } });
      win.openai?.notifyIntrinsicHeight?.(height);
    },
    /** Where the app shows the view (`inline`, `fullscreen`, ...) and the most height it gives, as it last said. */
    placement: () => {
      const mode = context.displayMode ?? win.openai?.displayMode ?? 'inline';
      const most = context.containerDimensions?.maxHeight ?? win.openai?.maxHeight;
      return { mode, maxHeight: typeof most === 'number' && most > 0 ? most : null, modes: context.availableDisplayModes ?? (win.openai?.requestDisplayMode ? ['inline', 'fullscreen'] : ['inline']) };
    },
    /** Hears every change the app makes to where it shows the view; answers what stops hearing. */
    onPlacement: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    /** Asks the app to show the view another way (`inline`, `fullscreen`); answers the mode the app gave. */
    askDisplayMode: async mode => {
      if (!answered && typeof win.openai?.requestDisplayMode === 'function') {
        const given = await win.openai.requestDisplayMode({ mode });
        heard({ displayMode: given?.mode ?? mode });
        return given?.mode ?? mode;
      }
      const given = await request('ui/request-display-mode', { mode });
      heard({ displayMode: given?.mode ?? mode });
      return given?.mode ?? mode;
    },
    /** Asks the app to open an address outside the chat. */
    openLink: url => {
      if (!answered && typeof win.openai?.openExternal === 'function') { win.openai.openExternal({ href: url }); return; }
      request('ui/open-link', { url }).catch(() => {});
    },
    stop: () => {
      win.removeEventListener('openai:set_globals', fromOpenAi);
      win.removeEventListener('openai:set_globals', fromOpenAiPlacement);
      listeners.clear();
      win.removeEventListener('message', onMessage);
      for (const { reject } of waiting.values()) reject(new Error('The view closed.'));
      waiting.clear();
    },
  };
}
