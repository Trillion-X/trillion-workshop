// src/workspace/screen-view.tsx
//
// PURPOSE
//   The script of the view an AI app (ChatGPT, Claude) draws when a tool names Trillion's screen view
//   (src/screen-view.mjs: show_screen, and every tool whose answer is a screen). It mounts the very screen the person
//   sees in Trillion, from the workspace's own list (screen-mounts.ts), in their own look, inside the chat.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One screen implementation: nothing here draws a screen; it mounts the workspace's and hosts it.
//   2. The view holds no credential. Every read and change a screen makes of the person's Trillion (the addresses
//      screen-view.json `reads.paths` names) goes to the app as a screen_read tool call, which the app makes as the
//      person who connected it; the program's own files (its modules, faces, compiled parts) are read from Trillion's
//      origin directly. A read the app cannot make fails the way a lost connection fails, so the screen shows it.
//   3. The live channel the signed-in page listens on is not open to a chat's frame; a screen reads again when the
//      person acts in it.
//   4. Every screen returned by a tool opens at its exact target; explicit whole-workspace requests use the person's
//      full arrangement. Same-origin links keep their path and query there; other links are opened outside the chat.
//   5. The workspace fills `view.whole_px`, or the host's fullscreen box, with its footer inside the allowed height.
//      Fullscreen changes size only. The sidebar, selected target, other panes and drafts keep their mounts.
//   7. Focused screens and the whole workspace both mount the signed-in page's implementations. `whole` opens the
//      person's sidebar and arrangement without requiring a particular screen.
//   6. A video, sound or picture element reads a file's bytes by itself, never through fetch, so in the app's frame (no
//      session) an element pointing at the person's file bytes is pointed instead at a read lease for that one file,
//      minted through screen_read; the screen's own code never knows it is in a chat.
//   8. Every successfully opened screen carries one quiet control to its same full-Trillion address; shown, pressed
//      and full-open moments go through the shared privacy-preserving interaction log.
//   9. Every tool target keeps its exact input in the workspace. Both hosts consume one paginated catalog, including
//      conversations. A failed catalog read stays visible as incomplete and offers a retry. A saved tab is never
//      discarded because its catalog page is still loading.
//  10. A screen an AI makes as it writes it (make_screen's `parts`) is drawn from the call's arguments while they arrive,
//      before any answer or workspace read (parts-screen.tsx), and stays mounted when the answer names the saved screen.

import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ExternalLink, Maximize2, Minimize2, RefreshCw } from 'lucide-react';
import { Button, Container, Icon } from '../../parts/ui';
import { connectToAiApp } from '../../parts/ui/show/ai-app-bridge/ai-app-bridge.mjs';
import mountScreenLook from '../../parts/screen-look/show/mount-screen-look-surface';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import { mountScreenState, releaseScreenState } from '../../parts/ui/show/screen-state';
import { installTitleTooltips } from '../../parts/ui/show/tooltip/title-tooltips';
import { reserveVisibleViewportBottom } from '../../parts/ui/show/visible-viewport/bind-visible-viewport';
import '../../parts/keep-lists-of-rows/show/offer-views-to-every-list.tsx';
// The board's Draw design first, so the designed views offer its row (the design must be known when they are).
import './offer-draw-design';
import '../../parts/ui/show/record-views/designs/offer-designed-views';
// ...and the Chart view, so a saved view drawn as a chart draws the same in the page and in a chat.
import './offer-chart';
import './keep-record-view-preferences';
import settings from '../screen-view.json';
import { PlanNeeded, readJson } from './api';
import { addressForScreen, screensFromAddress, screensForWorkspace, workspaceInputFor } from './screen-view-navigation.mjs';
import { failedState } from './failure';
import { retryQuietly } from '../../parts/ui/show/request/quiet-retry';
import { textAfter } from '../view-patch.mjs';
import { sayAskedAgain } from '../../parts/ui/show/still-working/still-working';
import firstAnswers from './first-answers.json';
import { keepShowRules, type AppliedShowRules } from './show-rules-live';
import { offeredScreens, startScreenRecords, type ScreenRow } from './offered-screens';
import { createScreenCatalog, pursuitRowsOf, SCREEN_CATALOG_CONVERSATIONS_EVERY_MS } from './screen-catalog.mjs';
import { addressLabelForInput, readStartupRecords, showRecords } from './records';
import { onStoreChange, readEveryScreenAgain, AI_MESSAGES } from './store-changes';
import { screens } from './screen-mounts';
import { installScreenRunner, mountScreen } from './screen-runner';
import { preserveScreenInputs } from './lazy-screen';
import { focusedSurfaceHost } from '../../parts/ui/show/focused-surface-host/focused-surface-host.mjs';
import { mountWorkspace, openScreens, type Workspace } from './mount-workspace';
import surfaces from './surfaces.json';
import { answerTargets } from './targets';
import { installResourcePresentationHost, requestResourcePresentationHost } from './resource-presentation-host.mjs';
import type { PartsScreenHandle } from './parts-screen';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
type Words = typeof settings.words & { origin: string };
type Asked = { id: string; input?: Record<string, unknown>; address?: string; whole?: boolean; presentation?: 'focused' };
type ReadAnswer = { status: number; content_type?: string; text?: string; base64?: string; identity?: string; patch?: unknown };
// The answer each read last gave this screen, by path: asked again, the Worker sends only what changed (src/view-patch.mjs).
const heldReads = new Map<string, { identity: string; text: string }>();

const HOST_ID = 'trillion-screen';
const frame = document.getElementById(HOST_ID) as HTMLElement;
// An AI app keeps the view's document between deploys, so words added since it was served come from this script's own
// copy of screen-view.json, under what the document carries.
const words = { ...settings.words, ...JSON.parse(document.getElementById(`${HOST_ID}-words`)?.textContent || '{}') } as Words;
const ORIGIN = words.origin;
frame.className = 'trillion-screen-view';
// The stage gives the shared workspace its own box; its panes scroll inside it. The host controls below the stage
// share its finite height allowance (invariant 5).
const stage = document.createElement('div');
stage.className = 'trillion-screen-stage';
const host = document.createElement('div');
host.className = 'trillion-screen-content';
const sizeRow = document.createElement('div');
stage.append(host);
frame.replaceChildren(stage, sizeRow);

let asked: Asked | null = null;
let opened: Asked | null = null;
let ready = false;
let offered: ScreenRow[] = [];
// The whole workspace stays mounted after it opens; focused navigation keeps its screens mounted too.
let whole: Workspace | null = null;
let hasSavedArrangement = false;
let catalog: ReturnType<typeof createScreenCatalog> | null = null;
let pendingWhole: Asked | null = null;
let forceConversationRefresh = false;
let starting: Promise<void> | null = null;
let focused: ReturnType<typeof focusedSurfaceHost> | null = null;
let focusedRoot: HTMLElement | null = null;
let workspaceRoot: HTMLElement | null = null;
let stateRoot: HTMLElement | null = null;
let focusedCanBack = false;
let showingFocused = false;
let wholeCatalogStarted = false;
// A screen being made in this call (invariant 10), its latest declared requests, and its lines not drawn yet. Its
// drawing code is fetched when the call's arguments start to arrive (an AI writes the screen's name and requests before
// its lines), so a view that shows an existing screen never carries it.
let streamed: PartsScreenHandle | null = null;
let streamedRequests: Record<string, unknown> = {};
let partsCode: Promise<[typeof import('./parts-screen'), typeof import('./declared-request')]> | null = null;
let waitingLines: { text: string; finished: boolean } | null = null;

function clear() {
  if (stateRoot) {
    releaseScreenState(stateRoot);
    stateRoot.remove();
    stateRoot = null;
  }
  if (focusedRoot) focusedRoot.hidden = true;
  if (workspaceRoot) workspaceRoot.hidden = true;
}
function showState(state: Parameters<typeof mountScreenState>[1]) {
  clear();
  stateRoot = document.createElement('div');
  stateRoot.className = 'trillion-screen-state';
  host.append(stateRoot);
  mountScreenState(stateRoot, state);
}

showState({ status: 'loading', label: words.opening, layout: 'rows' });

// What the app handed: which screen a tool's answer is shown as (its `_meta`, for the view alone).
const app = connectToAiApp(window, {
  appName: 'trillion-screen', content: frame, displayModes: ['inline', 'fullscreen'],
  onToolInput: (args, { partial }) => {
    partsCode ??= Promise.all([import('./parts-screen'), import('./declared-request')]);
    if (typeof args.parts === 'string') drawParts(args.parts, !partial, args.requests);
  },
  onToolResult: ({ meta, structuredContent, isError }) => {
    const screen = ((meta as Record<string, unknown> | null)?.['trillion/screen']
      ?? (structuredContent as Record<string, unknown> | null)?.['trillion/screen']) as Asked | undefined;
    if (screen && typeof screen.id === 'string') {
      asked = screen;
      // The screen this call made is already drawn from its lines: it stays, now with its saved address, and the
      // workspace is not read for it.
      if (streamed) { opened = screen; countScreen('shown', screen); fit(); return; }
      if (ready) open(screen);
      else queueMicrotask(ensureStarted);
      return;
    }
    // A screen drawn from its lines stays when its save failed: the AI reads why and sends it again.
    if (streamed) return;
    if (!asked) missingScreen(isError);
  },
});

// The lines of a screen being made, drawn as they come: the first complete line paints, each next one adds its part.
function drawParts(text: string, finished: boolean, requests: unknown) {
  if (requests && typeof requests === 'object' && !Array.isArray(requests)) {
    streamedRequests = requests as Record<string, unknown>;
    streamed?.requests(streamedRequests);
  }
  if (!streamed) {
    const first = !waitingLines;
    waitingLines = { text, finished: finished || Boolean(waitingLines?.finished) };
    if (first) void partsCode!.then(([module, { declaredCall }]) => {
      clear();
      showingFocused = true;
      const root = document.createElement('div');
      root.className = 'trillion-screen-parts';
      host.append(root);
      streamed = module.mountPartsScreen(root, { requests: streamedRequests, call: (name, input) => declaredCall(streamedRequests, {}, name, input) });
      const lines = waitingLines!;
      waitingLines = null;
      drawParts(lines.text, lines.finished, null);
    }, error => showState(failedState(error, () => location.reload(), words.could_not_open)));
    return;
  }
  if (finished) streamed.end(text); else streamed.push(text);
  fit();
}

// The person's Trillion is read through the app (screen_read); the program's own files from Trillion's origin.
const ownFetch = window.fetch.bind(window);

// The embedded screen is a doorway, and its three useful moments are records in the same interaction store as every
// page and tool: shown, anything pressed in it, and the press that opens the same place in full Trillion. The frame
// keeps no person identifier; the collector applies the same privacy, robot and retention rules as every other event.
const aiAppName = () => {
  try { return new URL(document.referrer).host || 'unknown'; } catch { return 'unknown'; }
};
const addressOf = (screen: Asked | null = opened ?? asked) => addressForScreen(offered, screen, ORIGIN);
function countScreen(action: 'shown' | 'pressed' | 'full_open', screen: Asked | null = opened ?? asked, target = '') {
  if (!screen || navigator.doNotTrack === '1' || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true) return;
  const url = new URL(addressOf(screen));
  const body = JSON.stringify({ shell: 'ai-app', events: [{
    kind: 'ai_screen', action, screen: url.pathname, client: aiAppName(), ...(target ? { target: target.slice(0, 120) } : {}),
  }] });
  try { if (navigator.sendBeacon?.(`${ORIGIN}/i`, body)) return; } catch { /* fall through to a kept-alive request */ }
  void ownFetch(`${ORIGIN}/i`, { method: 'POST', body, keepalive: true, credentials: 'omit', mode: 'no-cors' }).catch(() => {});
}
const pressedName = (element: Element) => element.getAttribute('data-interaction') || element.getAttribute('aria-label')
  || (element as HTMLElement).innerText || (element as HTMLInputElement).value || element.tagName.toLowerCase();

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), character => character.charCodeAt(0));
async function bodyOf(body: BodyInit | null | undefined): Promise<{ text?: string; base64?: string }> {
  if (body === undefined || body === null) return {};
  if (typeof body === 'string') return { text: body };
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return { base64: btoa(binary) };
}
window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const request = input instanceof Request ? input : null;
  const signal = init.signal !== undefined ? init.signal : request?.signal;
  signal?.throwIfAborted();
  const url = new URL(request ? request.url : String(input), ORIGIN);
  if (url.origin !== ORIGIN) return ownFetch(input, init);
  if (!settings.reads.paths.some(path => url.pathname.startsWith(path))) return ownFetch(url.href, { ...init, credentials: 'omit' });
  const headers = new Headers(init.headers ?? request?.headers);
  const sent: Record<string, string> = {};
  for (const name of settings.reads.headers) { const value = headers.get(name); if (value) sent[name] = value; }
  const method = (init.method ?? request?.method ?? 'GET').toUpperCase();
  const body = await bodyOf(init.body ?? (request && method !== 'GET' && method !== 'HEAD' ? await request.arrayBuffer() : undefined));
  let answer: ReadAnswer;
  const path = `${url.pathname}${url.search}`;
  // A call the app could not make (the service busy, the connection dropped) is asked again by itself, quietly, after the
  // waits in quiet-retry.json while the screen keeps its loading state; a busy answer is asked again by api.ts the same way.
  // A lost reply does not prove the operation never ran. A read can ask again; a change can do so only with its caller's
  // original key carried to the store, as postJsonByKey does. Never create a key here or replay an unkeyed change.
  const repeatable = method === 'GET' || method === 'HEAD' || Boolean(sent['idempotency-key']);
  const patchable = method === 'GET';
  const callRead = (have?: string) => app.callTool('screen_read', { path, method, headers: sent, ...body, ...(patchable ? { patchable, ...(have ? { have } : {}) } : {}) }) as Promise<ReadAnswer>;
  try {
    answer = await retryQuietly(
      () => callRead(heldReads.get(path)?.identity).catch(error => {
        if (error?.name === 'AbortError') throw error;
        throw Object.assign(new Error(errorWords(error, 'The screen could not be reached. Try again.'), { cause: error }), error instanceof Error ? error : {}, { unreached: true });
      }),
      () => null, { signal, failures: repeatable, onTry: attempt => sayAskedAgain({ path, attempt }) });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new TypeError(errorWords(error));
  }
  // An answer that is only changes is rebuilt on what this screen holds; one that does not fit is read whole.
  let shown = answer.text;
  if (patchable) {
    let after = textAfter(answer, heldReads.get(path));
    if (after.stale) {
      heldReads.delete(path);
      answer = await callRead();
      after = textAfter(answer, undefined);
    }
    shown = after.text ?? answer.text;
    if (after.held) heldReads.set(path, after.held); else heldReads.delete(path);
  }
  const status = answer.status >= 200 && answer.status <= 599 ? answer.status : 502;
  const empty = status === 204 || status === 304 || method === 'HEAD';
  return new Response(empty ? null : answer.base64 ? bytesOf(answer.base64) : shown ?? '', { status, headers: answer.content_type ? { 'content-type': answer.content_type } : {} });
};
// A file's bytes as an element reads them (invariant 6): the workspace's own bytes address, swapped for the same file
// at a lease minted through screen_read (one per file, kept for the view's life; a lease lasts an hour).
const BYTES_PATH = '/work/api/namespace/bytes/';
const READ_ATTRIBUTES = ['src', 'poster'];
const leases = new Map<string, Promise<string>>();
const leasedAddress = (identity: string) => {
  let address = leases.get(identity);
  if (!address) {
    address = fetch(`${ORIGIN}/work/api/namespace/leases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'read', identity, seconds: 3600 }) })
      .then(answer => (answer.ok ? answer.json() : Promise.reject(new Error(`lease ${answer.status}`))))
      .then(({ lease }: { lease: string }) => `${ORIGIN}/namespace/bytes/${encodeURIComponent(identity)}?lease=${lease}`);
    address.catch(() => leases.delete(identity));
    leases.set(identity, address);
  }
  return address;
};
function readFromLease(element: Element) {
  for (const name of READ_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (!value) continue;
    const url = new URL(value, ORIGIN);
    if (url.origin !== ORIGIN || !url.pathname.startsWith(BYTES_PATH)) continue;
    const identity = decodeURIComponent(url.pathname.slice(BYTES_PATH.length));
    void leasedAddress(identity).then(address => { if (element.getAttribute(name) === value) element.setAttribute(name, address); }, () => {});
  }
}
const leaseObserver = new MutationObserver(changes => {
  for (const change of changes) {
    if (change.type === 'attributes') readFromLease(change.target as Element);
    for (const node of change.addedNodes) {
      if (!(node instanceof Element)) continue;
      readFromLease(node);
      node.querySelectorAll(READ_ATTRIBUTES.map(name => `[${name}]`).join(',')).forEach(readFromLease);
    }
  }
});
leaseObserver.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: READ_ATTRIBUTES });

// The live channel is the signed-in page's alone (invariant 3): a screen asking for it gets a quiet one.
const OwnSocket = window.WebSocket;
window.WebSocket = function QuietSocket(this: unknown, address: string | URL, protocols?: string | string[]) {
  // In the app's frame the page has no host of its own, so the workspace's own address reads `ws:///work/live`.
  const own = /^wss?:\/\/\//.test(String(address)) || [location.host, new URL(ORIGIN).host].includes(new URL(String(address), ORIGIN.replace(/^http/, 'ws')).host);
  if (!own) return new OwnSocket(address, protocols);
  return Object.assign(new EventTarget(), { readyState: 0, send() {}, close() {} });
} as unknown as typeof WebSocket;
// The AI-app host supplies authenticated request/reply instead of an inert WS.
// Resource changes stay at their owner; the existing signed-in bridge carries
// parked reads, and the shared screen remains the signed-in page's renderer.
installResourcePresentationHost(requestResourcePresentationHost({ readJson }));

function missingScreen(failed = false) {
  clear();
  const loading = failed && catalog && !catalog.state().complete && !Object.values(catalog.state().sources).some((source: any) => source.status === 'error');
  if (loading) showState({ status: 'loading', label: words.catalog_loading, layout: 'rows' });
  else if (failed) showState({
    status: 'failed', title: words.no_screen_title, description: words.screen_failed,
    retry: { label: words.retry, run: refreshWorkspace },
    secondary: { label: words.open_workspace, run: () => { asked = workspaceRequest(); if (ready) openWhole(asked); else ensureStarted(); } },
  });
  else showState({
    status: 'empty', icon: 'LayoutPanelLeft', title: words.no_screen_title, description: words.no_screen,
    action: { label: words.open_workspace, run: () => { asked = workspaceRequest(); if (ready) openWhole(asked); else ensureStarted(); } },
  });
  app.reportSize();
}

const isInputRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const mergeSurfaceInput = (base: Record<string, unknown> | undefined = {}, update: Record<string, unknown> | undefined = {}) => {
  const merged = { ...base };
  for (const [key, value] of Object.entries(update ?? {})) {
    merged[key] = isInputRecord(merged[key]) && isInputRecord(value)
      ? mergeSurfaceInput(merged[key] as Record<string, unknown>, value)
      : value;
  }
  return merged;
};

// A screen request the whole workspace's arrangement answers: the row as offered, with the asked input laid over it.
const inArrangement = (row: ScreenRow, input: Record<string, unknown> = {}) =>
  (Object.keys(input).length ? { id: row.id, surfaceInput: mergeSurfaceInput(row.surface_input as Record<string, unknown> | undefined, input) } : row);

const workspaceRequest = (from: Asked | null = null): Asked => ({
  id: `${String(surfaces.address_label).split('::').at(-1)}.workspace`, whole: true,
  address: settings.whole.address, input: workspaceInputFor(from),
});
function startWholeCatalog() {
  if (!catalog || wholeCatalogStarted) return;
  wholeCatalogStarted = true;
  void catalog.readTools();
  void catalog.readPursuits();
  void catalog.readConversations();
}
// The requested screen can mount in place first; opening the whole workspace then loads its remaining catalog owners.
function openWhole(screen: Asked) {
  showingFocused = false;
  clear();
  if (workspaceRoot) workspaceRoot.hidden = false;
  if (focusedRoot) focusedRoot.hidden = true;
  startWholeCatalog();
  const wanted = screensForWorkspace(offered, screen.input ?? {}, ORIGIN).map(({ row, input }: { row: ScreenRow; input: Record<string, unknown> }) => inArrangement(row, input));
  pendingWhole = (screen.input?.open || screen.input?.open_screen) && !wanted.length ? screen : null;
  const exact = screen.input?.open_screen as Asked | undefined;
  opened = exact?.id ? exact : screen;
  countScreen('shown', opened);
  if (whole) { if (wanted.length) openScreens(wanted); fit(); return; }
  frame.dataset.whole = 'true';
  host.dataset.trillionScreen = 'workspace';
  const root = document.createElement('div');
  root.className = 'trillion-workspace';
  workspaceRoot = root;
  host.append(root);
  whole = mountWorkspace(root, offered, { catalogComplete: catalog?.state().complete ?? false });
  const starting = hasSavedArrangement ? [] : (surfaces.open_at_start as string[]).map(id => offered.find(row => row.id === id)).filter(Boolean) as ScreenRow[];
  if (starting.length || wanted.length) openScreens([...starting, ...wanted]);
  fit();
}

function open(screen: Asked) {
  if (screen.presentation === 'focused' && !screen.whole) {
    const row = offered.find(item => item.id === screen.id);
    const entry = (row?.package_entry as { entry_name?: string } | undefined)?.entry_name;
    if (!row || !entry || !screens[entry]) { missingScreen(true); return; }
    const input = mergeSurfaceInput(row.surface_input as Record<string, unknown> | undefined, screen.input);
    const focusedScreen = { ...screen, input, address: addressForScreen(offered, { id: row.id, input }, ORIGIN) };
    clear();
    showingFocused = true;
    opened = focusedScreen;
    frame.dataset.whole = 'false';
    if (workspaceRoot) workspaceRoot.hidden = true;
    if (!focusedRoot) {
      if (!workspaceRoot) clear();
      focusedRoot = document.createElement('div');
      host.append(focusedRoot);
      focused = focusedSurfaceHost(focusedRoot, {
        mount: (element: HTMLElement, target: Asked) => {
          const targetRow = offered.find(item => item.id === target.id)!;
          const targetEntry = (targetRow.package_entry as { entry_name: string }).entry_name;
          releaseScreenState(element);
          const input = mergeSurfaceInput(targetRow.surface_input as Record<string, unknown> | undefined, target.input);
          element.dataset.trillionScreen = typeof input.screen === 'string' ? input.screen : targetEntry;
          return preserveScreenInputs(element, mountScreen(element, targetEntry, input, place => screens[targetEntry](place, { surfaceInput: input })), { surfaceInput: input });
        },
        changed: ({ current, canBack }: { current: Asked | null; canBack: boolean }) => { if (current) opened = current; focusedCanBack = canBack; fit(); },
        onError: (error: unknown, target: Asked, element: HTMLElement, context?: { updating: boolean; stop?: { pending?: (notice: { title: string; description: string }) => void } }) => {
          if (context?.updating) {
            context.stop?.pending?.({ title: words.could_not_open, description: words.focused_update_failed });
            return;
          }
          releaseScreenState(element);
          mountScreenState(element, failedState(error, () => focused?.open(target), words.could_not_open));
        },
      });
    }
    focusedRoot.hidden = false;
    focused!.open(focusedScreen);
    countScreen('shown', focusedScreen);
    fit();
    return;
  }
  openWhole(screen.whole ? screen : workspaceRequest(screen));
}

// The arrangement owns navigation. Remember its current request for the same-target external fallback and logging.
window.addEventListener(PLACEABLE_SURFACE_MIME, event => {
  const detail = (event as CustomEvent).detail as { id?: string; surfaceInput?: Record<string, unknown>; surface_input?: Record<string, unknown> } | null;
  if (!detail?.id || !offered.some(row => row.id === detail.id)) return;
  const next = { id: detail.id, input: detail.surfaceInput ?? detail.surface_input ?? {} };
  if (showingFocused) { event.preventDefault(); open({ ...next, address: addressOf(next), presentation: 'focused' }); return; }
  if (!whole) return;
  opened = { ...next, address: addressOf(next) };
});
// A link to one of Trillion's screens opens it in place; any other link opens outside the chat.
document.addEventListener('click', event => {
  const control = (event.target as Element | null)?.closest?.('a,button,summary,input[type=submit],input[type=button],[role=button],[role=link],[role=menuitem],[role=tab],[role=switch],[role=option],[data-interaction]');
  if (control) countScreen('pressed', opened ?? asked, pressedName(control));
}, true);
document.addEventListener('click', event => {
  const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!link || event.defaultPrevented) return;
  const url = new URL(link.getAttribute('href') ?? '', ORIGIN);
  const routed = screensFromAddress(offered, url.href, ORIGIN) as { row: ScreenRow; input: Record<string, unknown> }[];
  event.preventDefault();
  if (url.origin === ORIGIN && url.pathname === settings.whole.address && !routed.length) openWhole(workspaceRequest(opened?.whole ? null : opened));
  else if (routed.length && showingFocused) open({ id: routed[0].row.id, input: routed[0].input, address: `${url.pathname}${url.search}`, presentation: 'focused' });
  else if (routed.length && whole) openScreens(routed.map(({ row, input }) => inArrangement(row, input)));
  else if (routed.length) open({ id: routed[0].row.id, input: routed[0].input, address: `${url.pathname}${url.search}` });
  else app.openLink(url.href);
});

async function start() {
  const focusedStart = asked?.presentation === 'focused' && !asked.whole;
  const resultOf = <T,>(read: Promise<T>) => read.then(value => ({ value }), error => ({ error }));
  const [saved, viewer, toolsAnswer, pursuitsAnswer, showRules] = await Promise.all([
    readStartupRecords(),
    readJson<{ access_refs: string[] }>(firstAnswers.paths.viewer),
    focusedStart ? Promise.resolve({ value: { surfaces: [] as ScreenRow[] } }) : resultOf(readJson<{ surfaces: ScreenRow[]; next?: string }>(firstAnswers.paths.tool_screens)),
    // The person's pursuits are sidebar rows of the whole workspace, as on the page.
    focusedStart ? Promise.resolve({ value: [] as Record<string, unknown>[] }) : resultOf(readJson<unknown>(firstAnswers.paths.pursuits).then(pursuitRowsOf)),
    readJson<AppliedShowRules>(firstAnswers.paths.show_rules, { cache: 'no-store' }),
    answerTargets(),
  ]);
  const toolScreens = 'value' in toolsAnswer ? toolsAnswer.value : null;
  const pursuits = 'value' in pursuitsAnswer ? pursuitsAnswer.value : null;
  offered = offeredScreens(viewer, toolScreens?.surfaces ?? [], pursuits ?? []);
  await startScreenRecords(offered, saved);
  // Apply the same current policy before either embedded presentation mounts.
  await keepShowRules(showRules);
  hasSavedArrangement = addressLabelForInput('layout-state') in saved;
  // Every pane of an arranged screen mounts through the same runner the signed-in page installs.
  installScreenRunner(screens, surfaces.address_label);
  installTitleTooltips();
  catalog = createScreenCatalog({
    initial: {
      viewer,
      ...(!focusedStart && toolScreens ? { tools: toolScreens } : {}),
      ...(!focusedStart && pursuits ? { pursuits } : {}),
    },
    read: readJson,
    unavailable: (error: unknown) => error instanceof PlanNeeded ? error.upgrade_needed : null,
    offer: ({ viewer, tools, pursuits, conversations }: any) => offeredScreens(viewer, tools, pursuits, conversations),
    onChange: (rows: ScreenRow[], state: { complete: boolean }) => {
      if (JSON.stringify(rows) !== JSON.stringify(offered)) {
        offered.splice(0, offered.length, ...rows);
        showRecords({ [surfaces.address_label]: rows });
      }
      whole?.reoffer(offered, { catalogComplete: state.complete });
      if (ready && pendingWhole && screensForWorkspace(offered, pendingWhole.input ?? {}, ORIGIN).length) openWhole(pendingWhole);
      else if (ready && asked && !opened) open(asked);
      fit();
    },
    onError: () => fit(),
  });
  if ('error' in toolsAnswer) catalog.reportFailure('tools', toolsAnswer.error);
  if ('error' in pursuitsAnswer) catalog.reportFailure('pursuits', pursuitsAnswer.error);
  ready = true;
  if (asked) open(asked);
  if (!focusedStart) {
    wholeCatalogStarted = true;
    if (toolScreens) void catalog.takeTools(toolScreens);
    void catalog.readConversations();
  }
  onStoreChange(() => (wholeCatalogStarted
    ? Promise.all([catalog!.readViewer(), catalog!.readTools(), catalog!.readPursuits()])
    : catalog!.readViewer()).then(() => {}));
  let conversationsReadAt = Date.now();
  onStoreChange(() => {
    if (!wholeCatalogStarted) return;
    if (!forceConversationRefresh && Date.now() - conversationsReadAt < SCREEN_CATALOG_CONVERSATIONS_EVERY_MS) return;
    forceConversationRefresh = false;
    conversationsReadAt = Date.now();
    return catalog!.readConversations();
  }, AI_MESSAGES);
}

function refreshWorkspace() {
  if (!catalog) { location.reload(); return; }
  // The shared store-change scheduler gathers catalog and mounted-screen reads into one round.
  forceConversationRefresh = true;
  readEveryScreenAgain();
}
function ensureStarted() {
  if (!starting) starting = start().catch(error => showState(failedState(error, () => location.reload(), words.could_not_open)));
}
// Returning to the conversation checks the shared catalog and current screens. All reads still use the host's
// authorized screen_read route; the frame never receives a credential or opens a second account session.
window.addEventListener('focus', () => { if (ready) readEveryScreenAgain(); });
document.addEventListener('visibilitychange', () => { if (ready && document.visibilityState === 'visible') readEveryScreenAgain(); });

// Mount the person's look before the first read can fail, but after the chat's
// screen_read bridge is installed. The failure state is the shared ScreenState
// and must keep Trillion's button, icon and type roles even while offline.
const look = document.createElement('div');
look.hidden = true;
document.body.prepend(look);
flushSync(() => mountScreenLook({ el: look, props: {} }));
document.body.classList.add('screen-look-page');
// Wait for a selected result. Save-only/background calls do not load the person's workspace.
// The whole workspace fills the host's available box. Fullscreen changes only the box, never its contents or mounts.
// Footer and status are inside the advertised height, including narrow hosts where controls wrap to another row.
const sizeRoot = createRoot(sizeRow);
function SizeRow({ full, canFull }: { full: boolean; canFull: boolean }) {
  if (!whole && !focused && !streamed) return null;
  const askWholeScreen = () => { void app.askDisplayMode(full ? 'inline' : 'fullscreen').then(fit, fit); };
  const openFullTrillion = () => { countScreen('full_open'); app.openLink(addressOf()); };
  const states = catalog?.state().sources ?? {};
  const incomplete = Object.values(states).some((source: any) => source.status === 'error');
  const loading = Object.values(states).some((source: any) => source.status === 'loading' || source.status === 'idle');
  return (
    <Container layout="horizontal" alignItems="center" gap="xs" className="trillion-screen-size-row" data-screen-size-row="">
      {showingFocused && focusedCanBack ? <Button variant="ghost" size="sm" onClick={() => focused?.back()}>{words.back}</Button> : null}
      {canFull ? (
        <Button variant="ghost" size="sm" onClick={askWholeScreen} data-screen-size={full ? 'inline' : 'full'}>
          <Icon icon={full ? Minimize2 : Maximize2} size="sm" />
          {full ? words.back_to_chat : words.full_screen}
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" onClick={refreshWorkspace} data-screen-refresh="" aria-label={words.refresh}>
        <Icon icon={RefreshCw} size="sm" /><span className="trillion-screen-refresh-label">{words.refresh}</span>
      </Button>
      <Button variant="ghost" size="sm" onClick={openFullTrillion} data-interaction="screen-open-in-trillion">
        <Icon icon={ExternalLink} size="sm" />
        {words.open_full_trillion}
      </Button>
      {!showingFocused && (incomplete || loading || pendingWhole) ? <span role="status" className="trillion-screen-catalog-status" data-screen-catalog-state={incomplete ? 'error' : loading ? 'loading' : 'unavailable'}>
        {incomplete ? words.catalog_failed : loading ? words.catalog_loading : words.target_unavailable}
      </span> : null}
    </Container>
  );
}
function fit() {
  const placement = app.placement();
  const full = placement.mode === 'fullscreen';
  flushSync(() => sizeRoot.render(<SizeRow full={full} canFull={placement.modes.includes('fullscreen')} />));
  // The page's sidebar and floating controls can live in body portals. Reserve the footer through their shared
  // viewport owner so their hit areas end at the workspace, including on a phone and after host mode changes.
  reserveVisibleViewportBottom(sizeRow, sizeRow.offsetHeight);
  const total = Math.min(full ? window.innerHeight : settings.view.whole_px, placement.maxHeight ?? Infinity);
  stage.style.height = !showingFocused && whole ? `${Math.max(0, Math.floor(total - sizeRow.offsetHeight))}px` : '';
  stage.style.maxHeight = showingFocused ? `${Math.max(0, Math.floor(total - sizeRow.offsetHeight))}px` : '';
  stage.dataset.scrolls = showingFocused ? 'true' : 'false';
  app.reportSize();
}
const hostResize = new ResizeObserver(fit);
const sizeResize = new ResizeObserver(fit);
hostResize.observe(host);
sizeResize.observe(sizeRow);
app.onPlacement(fit);
window.addEventListener('resize', fit);
window.addEventListener('beforeunload', () => {
  focused?.dispose();
  catalog?.stop();
  leaseObserver.disconnect();
  hostResize.disconnect();
  sizeResize.disconnect();
  if (stateRoot) releaseScreenState(stateRoot);
}, { once: true });
fit();
