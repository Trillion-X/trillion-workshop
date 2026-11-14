// src/workspace/tool-screen.tsx
//
// PURPOSE
//   A tool's own screen (entry `tool-screen`, the tool's id in the tab's input). A capability is registered once, as
//   a Workshop tool, and its human screen is one field on that same record:
//     "screen": { "kind": "<how it is shown>", "label"?, "icon"?, ...what that kind reads }
//   src/work-workshop.mjs toolSurfaces turns every such tool into a screen row whose id is the tool's id; the
//   sidebar holds those rows by a rule over rows (surfaces.json `holds`), and the arrangement keeps them in tabs,
//   panes and saved layouts like any screen. Nothing names a list, a place or an address.
//
//   How a screen is shown is `SHOWS`, keyed by `screen.kind`; a new kind is one entry here (`web-address` is drawn by the
//   shared guide, in web-address-screen.tsx, fetched when one first opens):
//     web-address  the tool's own hosted frontend (`url`), opened from here.
//     app-entry    an existing Trillion screen that already does the job (`entry`, with `input`).
//     module       saved { bundle, file } code runs in the shared isolated-module-surface host with named request
//                  capabilities; shipped { package, entry } modules stay in the page and are resolved by its import
//                  map (scripts/screen-modules.mjs). Both expose mount(element, props) and an optional update/cleanup.
//     parts        a screen made of shared parts (`spec`: src/screen-spec.mjs), drawn by ./parts-screen with no code of
//                  its own; its presses send the same named `requests` a module screen declares, through the same owner.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: this file names no tool, field or job; every word about the tool is the tool's own.
//   2. No markup: the guide and the shared screen states draw everything.
//   3. A tool has a screen only when its description declares one: there is no screen drawn from the tool's input
//      schema. A tool with none is done on the screen that already hosts its job (the file card, the editor, Automations,
//      the tray) or by the person's AI, and opened here it says "This tool has no screen here". A description that could
//      not be read shows the read's failure, with Try again (and again by itself while the failure may pass).
//   4. Whatever this host drew is let go of before the next thing draws there (releaseScreenState, then emptying it):
//      emptying a host whose shared state is still drawn leaves React holding nodes that are gone, and the next draw
//      throws and leaves the pane blank.

import React from 'react';
import { mountScreenState, releaseScreenState } from '../../parts/ui/show/screen-state';
import type { JsonSchema } from '../../parts/ui';
import { readJson, READ_MOST_MS } from './api';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { IsolatedModuleSurface } from '../../parts/ui';
import { moduleSurfaceScopeKey } from '../../parts/ui/show/isolated-module-surface/module-surface-requests.mjs';
import { onKeptAnswerReplaced, readWithKeptAnswers } from '../../parts/ui/show/request/kept-answers';
import { moduleAddress, screenModuleSpecifier } from './screen-module-address.mjs';
import screenTools from '../../records/workshop-screen-tool-records.json' with { type: 'json' };

// This loader reads full descriptors through the existing screen-inputs projection.
// The navigation projection in screens.mjs deliberately leaves module and form fields out.
const SCREEN_TOOL_ROWS = screenTools.records.map(record => record.payload).filter(row => row?.screen?.surface);
import { failedState } from './failure';
import { goTo } from './open-screen';
import type { ToolInputSchema } from './tool-inputs';
import { onStoreChange } from './store-changes';
import { toolScreenRequest } from './tool-screen-requests.mjs';
import { preserveScreenInputs, type ScreenProps, type Unmount } from './lazy-screen';
import { mountAddressedRenderer } from './addressed-renderer.mjs';
import { nativeResourcePresentationHost, resourcePresentationHost } from './resource-presentation-host.mjs';
import type { ResourcePresentationBinding } from './addressed-record-set';
import { declaredCall } from './declared-request';
import type { PartsScreenHandle, PartsSpec } from './parts-screen';

type ModuleSpec = { bundle?: string; file?: string; package?: string; entry?: string };
export type Screen = { kind: string; spec?: PartsSpec; runtime?: string; label?: string; about?: string; icon?: string; url?: string; entry?: string; input?: Record<string, unknown>; module?: ModuleSpec; requests?: Record<string, unknown>; resource_binding?: ResourcePresentationBinding };
export type Descriptor = { id: string; label?: string; job?: string; description?: string; input_schema?: ToolInputSchema; output_schema?: JsonSchema; screen?: Screen };
type Mount = (element: HTMLElement, props: { surfaceInput?: Record<string, unknown> }) => Unmount;
type Props = ScreenProps;
export type Show = (element: HTMLElement, tool: Descriptor, screen: Screen, props: Props, screens: Record<string, Mount>) => Unmount;

export const nameOf = (tool: Descriptor, screen: Screen) => screen.label ?? tool.label ?? tool.id;
/** The line a person reads about the tool: its screen's own plain line; the AI-facing description only when it has none. */
export const aboutOf = (tool: Descriptor, screen: Screen) => screen.about ?? tool.description ?? tool.job;
// Lets go of whatever the host drew and empties it (invariant 5).
const letGo = (element: HTMLElement) => () => { releaseScreenState(element); element.replaceChildren(); };
export const sameInput = (left?: Record<string, unknown>, right?: Record<string, unknown>) => JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});

// The `web-address` screen is drawn by the shared guide, which comes with ./web-address-screen, fetched when one first
// opens, so a tool whose screen is a module or a workspace screen never carries it.
const webAddressShow: Show = (element, tool, screen, props, screens) => {
  let gone = false;
  let latest = props;
  let shown: Unmount | null = null;
  import('./web-address-screen').then(
    module => {
      if (gone) return;
      releaseScreenState(element);
      shown = module.webAddress(element, tool, screen, latest, screens);
    },
    error => { if (!gone) mountScreenState(element, failedState(error, () => location.reload(), `${nameOf(tool, screen)} could not open`)); },
  );
  mountScreenState(element, { status: 'loading', label: 'Loading the tool', layout: 'rows' });
  const dispose: Unmount = () => { gone = true; shown?.(); };
  dispose.update = next => { latest = next; shown?.update?.(next); };
  return dispose;
};

const appEntry: Show = (element, tool, screen, props, screens) => {
  const mount = screen.entry ? screens[screen.entry] : undefined;
  if (!mount) return unavailable(element);
  // The tool's loading rows let go of the pane first: a screen whose code is already here mounts at once and, as a
  // React screen, adds its own box beside whatever the pane held, so it would draw under "Loading the tool".
  releaseScreenState(element);
  // The tab's own input rides along (an item it was opened at: /use/<tool>/<item>), under the screen's own input.
  let childProps = { ...props, surfaceInput: { ...(props.surfaceInput ?? {}), ...(screen.input ?? {}), tool_id: tool.id } };
  const unmount = preserveScreenInputs(element, mount(element, childProps), childProps);
  const dispose: Unmount = () => unmount();
  dispose.update = next => {
    const updatedProps = { ...next, surfaceInput: { ...(next.surfaceInput ?? {}), ...(screen.input ?? {}), tool_id: tool.id } };
    if (sameInput(childProps.surfaceInput, updatedProps.surfaceInput)) return;
    childProps = updatedProps;
    unmount.update?.(childProps);
  };
  return dispose;
};

// What the person's words already said (the tab's `filled_inputs`, { input: value }) starts in the screen's state at
// /<input>, over the spec's own starting values, so a part bound there opens filled.
const filledSpec = (spec: PartsSpec, filled: unknown): PartsSpec => (filled && typeof filled === 'object' && !Array.isArray(filled)
  ? { ...spec, state: { ...(spec.state ?? {}), ...(filled as Record<string, unknown>) } }
  : spec);

// A screen made of shared parts: drawn by ./parts-screen (fetched when one first opens) from the tool's own spec, its
// presses sent through declaredCall (./declared-request) with the tab's current input.
const partsScreen: Show = (element, tool, screen, props) => {
  let gone = false;
  let latest = props;
  let shown: PartsScreenHandle | null = null;
  mountScreenState(element, { status: 'loading', label: `Opening ${nameOf(tool, screen)}`, layout: 'rows' });
  import('./parts-screen').then(
    module => {
      if (gone) return;
      releaseScreenState(element);
      shown = module.mountPartsScreen(element, { requests: screen.requests ?? {}, call: (name, input) => declaredCall(screen.requests, latest.surfaceInput ?? {}, name, input) });
      shown.show(filledSpec(screen.spec ?? { root: null, elements: {} }, latest.surfaceInput?.filled_inputs));
    },
    error => { if (!gone) mountScreenState(element, failedState(error, () => location.reload(), `${nameOf(tool, screen)} could not open`)); },
  );
  const dispose: Unmount = () => { gone = true; shown?.(); };
  dispose.update = next => { latest = next; };
  return dispose;
};

// The tool's own code: its bundle's first file, imported once per page, mounted with the tab's own input.
const moduleScreen: Show = (element, tool, screen, props) => {
  // A kept bundle by its identity (a row the Workshop resolved), or a module built with this page by its row's own spec,
  // which the page's import map names (scripts/screen-modules.mjs importMap).
  const spec = screen.module ?? {};
  if (spec.bundle && spec.file && screen.runtime === 'isolated') {
    releaseScreenState(element);
    let latestInput = props.surfaceInput ?? {};
    let nextUpdateId = 0;
    const pendingUpdates = new Map<string, { resolve: (accepted: boolean) => void; timer: number }>();
    const node = (surfaceInput: Record<string, unknown>, inputUpdateId?: string) => <IsolatedModuleSurface
      key={moduleSurfaceScopeKey(surfaceInput)}
      bundle={spec.bundle!}
      file={spec.file!}
      title={nameOf(tool, screen)}
      surfaceInput={surfaceInput}
      inputUpdateId={inputUpdateId}
      onMediaLease={async (identity, input) => {
        const spaceId = input.space_id;
        if (spaceId !== undefined && spaceId !== null) {
          const itemId = input.item_id;
          if (typeof spaceId !== 'string' || !spaceId.trim() || typeof itemId !== 'string' || !itemId.trim()) {
            throw new Error('The shared file is unavailable here.');
          }
          return readJson<{ identity: string; url: string; scope: 'read' }>(
            `/work/api/spaces/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(itemId)}/file`,
            {}, false, { applyFocus: false },
          ).then(file => ({ ...file, scope: 'read' as const }));
        }
        return readJson<{ identity: string; scope: 'read'; lease: string }>(
          '/work/api/namespace/leases',
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'read', identity, seconds: 3600 }) },
          false, { applyFocus: false },
        );
      }}
      onInputUpdateResult={(id, accepted) => {
        const pending = pendingUpdates.get(id);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        pendingUpdates.delete(id);
        pending.resolve(accepted);
      }}
      requests={screen.requests}
      onCall={(name, input = {}) => declaredCall(screen.requests, surfaceInput, name, input)}
    />;
    const mounted = mountReactSurface(element, node(latestInput));
    const dispose: Unmount = () => {
      for (const pending of pendingUpdates.values()) { window.clearTimeout(pending.timer); pending.resolve(false); }
      pendingUpdates.clear();
      queueMicrotask(() => mounted());
    };
    dispose.update = next => {
      const previousScope = moduleSurfaceScopeKey(latestInput);
      latestInput = next.surfaceInput ?? {};
      if (moduleSurfaceScopeKey(latestInput) !== previousScope) {
        for (const pending of pendingUpdates.values()) { window.clearTimeout(pending.timer); pending.resolve(false); }
        pendingUpdates.clear();
        dispose.pending?.(null);
        mounted.render?.(node(latestInput));
        return true;
      }
      const id = String(++nextUpdateId);
      const result = new Promise<boolean>(resolve => {
        const timer = window.setTimeout(() => { pendingUpdates.delete(id); resolve(false); }, 5000);
        pendingUpdates.set(id, { resolve, timer });
      });
      mounted.render?.(node(latestInput, id));
      return result;
    };
    return dispose;
  }
  const address = spec.bundle && spec.file ? moduleAddress(spec.bundle, spec.file)
    : spec.package && spec.entry ? screenModuleSpecifier({ package: spec.package, entry: spec.entry }) : '';
  if (!address) return unavailable(element);
  if (screen.resource_binding) {
    mountScreenState(element, { status: 'loading', label: `Opening ${nameOf(tool, screen)}`, layout: 'rows' });
    return mountAddressedRenderer({ element, binding: screen.resource_binding, props,
      host: resourcePresentationHost(nativeResourcePresentationHost({ readJson })),
      resolveRenderer: async () => import(address),
      beforeMount: () => releaseScreenState(element),
      onError: (error: unknown) => mountScreenState(element, failedState(error, () => location.reload(), `${nameOf(tool, screen)} could not open`)),
    });
  }
  let unmount: Unmount = letGo(element);
  let mountedScreen: Unmount | null = null;
  let gone = false;
  // The screen's own input rides over the tab's, as it does for an app-entry screen, so a row that fixes an input
  // (a guide's `screen`, a Home card's `card`) opens the same whether the screen's code is in the page or a module.
  const withScreenInput = (given: Props): Props => ({ ...given, surfaceInput: { ...(given.surfaceInput ?? {}), ...(screen.input ?? {}) } });
  let latestProps = withScreenInput(props);
  mountScreenState(element, { status: 'loading', label: `Opening ${nameOf(tool, screen)}`, layout: 'rows' });
  // A browser keeps a module that failed to arrive as failed for the rest of the page, so trying again reloads it.
  import(address).then(
    (loaded: { mount?: Mount }) => {
      if (gone) return;
      if (typeof loaded.mount !== 'function') { unmount = unavailable(element); return; }
      releaseScreenState(element);
      // A tool's own code that throws as it draws fails in its own pane, with a way to try again; the page and every
      // other pane go on.
      // A module is let go while the page holding it is itself drawing (a list switching away from Draw), when React
      // cannot take the module's own root down; it goes as soon as that drawing is done, as shared screens do
      // (parts/ui/show/react-surface-mount).
      try {
        const mountedProps = { ...latestProps, surfaceInput: latestProps.surfaceInput ?? {} };
        const stop = preserveScreenInputs(element, loaded.mount(element, mountedProps), mountedProps);
        mountedScreen = stop;
        const dispose: Unmount = () => queueMicrotask(() => stop?.());
        unmount = dispose;
      }
      catch (error) { mountScreenState(element, failedState(error, () => location.reload(), `${nameOf(tool, screen)} could not open`)); }
    },
    error => { if (!gone) mountScreenState(element, failedState(error, () => location.reload(), `${nameOf(tool, screen)} could not open`)); },
  );
  const dispose: Unmount = () => { gone = true; unmount(); };
  dispose.update = given => {
    const next = withScreenInput(given);
    const changed = !sameInput(latestProps.surfaceInput, next.surfaceInput);
    latestProps = next;
    if (!changed || gone) return;
    mountedScreen?.update?.(next);
  };
  return dispose;
};

const SHOWS: Record<string, Show> = { 'web-address': webAddressShow, 'app-entry': appEntry, module: moduleScreen, parts: partsScreen };

function unavailable(element: HTMLElement): () => void {
  mountScreenState(element, { status: 'empty', icon: 'Wrench', title: 'This tool has no screen here', description: 'Your AI can still use it. Open the Marketplace to see it.', action: goTo('Open the Marketplace', 'trillion.marketplace') });
  return letGo(element);
}

/** The tool named in the tab's input (`tool_id`, or the rest of a /use/ address), shown as its own screen says. */
export function mountToolScreen(element: HTMLElement, props: Props, screens: Record<string, Mount>): Unmount {
  let latestProps = props;
  const named = String(props.surfaceInput?.tool_id ?? '');
  const id = named && !named.includes(':') ? `tool:${named}` : named;
  if (!id) return unavailable(element);
  // A screen row of the page's own (records/workshop-screen-tool-records.json) opens straight away from its row, on
  // every plan and in every space, with no Workshop read: its module, or the workspace screen it names.
  const own = SCREEN_TOOL_ROWS.find(row => row.id === id && (row.screen.kind === 'module' || row.screen.kind === 'app-entry')) as Descriptor | undefined;
  if (own?.screen) return SHOWS[own.screen.kind](element, own, own.screen, props, screens);
  let unmount: Unmount = letGo(element);
  let gone = false;
  let readNumber = 0;
  let shownDescriptor = '';
  let shownScreenKind = '';
  let savedInput: Record<string, unknown> = {};
  let openingUpdatedScreen = false;
  mountScreenState(element, { status: 'loading', label: 'Loading the tool', layout: 'rows' });
  // The tool's description is answered from the copy this device kept when there is one, and the screen is drawn again
  // when the store describes it differently.
  let path = toolScreenRequest(id, props.surfaceInput, 'describe').path;
  // A company tool is described through its current grant, never a personal fallback.
  const draw = (read: Promise<{ descriptor: Descriptor }>) => {
    const thisRead = ++readNumber;
    return read.then(async ({ descriptor }) => {
      if (gone || thisRead !== readNumber) return;
      let resolvedProps = latestProps;
      let nextSavedInput = savedInput;
      if (descriptor.screen?.kind === 'module' && latestProps.surfaceInput?.space_id && latestProps.surfaceInput?.screen_context_id) {
        throw new Error('Private saved screen context cannot open in a pursuit.');
      }
      if (descriptor.screen?.kind === 'module' && !latestProps.surfaceInput?.space_id) {
        const contextRequest = toolScreenRequest(id, latestProps.surfaceInput, 'context');
        const context = await readJson<{ input?: Record<string, unknown> }>(contextRequest.path, { ...contextRequest.init, signal: AbortSignal.timeout(READ_MOST_MS) }, true, { applyFocus: false });
        if (gone || thisRead !== readNumber) return;
        nextSavedInput = context.input ?? {};
        const { screen_context_id: _contextId, ...given } = latestProps.surfaceInput ?? {};
        resolvedProps = { ...latestProps, surfaceInput: { ...nextSavedInput, ...given, tool_id: id } };
      }
      // Most account changes have nothing to do with this tool. Keep a person's half-entered inputs in place when
      // the exact descriptor is unchanged; a new saved version still replaces the screen.
      const signature = JSON.stringify(descriptor);
      if (signature === shownDescriptor) { openingUpdatedScreen = false; unmount.pending?.(null); return; }
      if (shownDescriptor && shownScreenKind === 'module' && !openingUpdatedScreen) {
        unmount.pending?.({ title: 'This saved screen has changed', description: 'Your work is still here. Finish it before opening the updated screen.', action: {
          label: 'Open updated screen', run: () => { openingUpdatedScreen = true; void draw(readJson<{ descriptor: Descriptor }>(path)); },
        } });
        return;
      }
      openingUpdatedScreen = false;
      shownDescriptor = signature;
      savedInput = nextSavedInput;
      unmount();
      // A tool that declares no screen has none: its job is done on the screen that already hosts it, or by the person's AI.
      const screen = descriptor.screen;
      shownScreenKind = screen?.kind ?? '';
      const show = screen ? SHOWS[screen.kind] : undefined;
      unmount = preserveScreenInputs(element, screen && show ? show(element, descriptor, screen, resolvedProps, screens) : unavailable(element), resolvedProps);
    }).catch(error => {
      // A read that failed says nothing about whether the tool has a screen: it is a failure, tried again, never "no screen".
      // The shared state takes the place of the loading rows in the same host, and lets go of it before the tool draws.
      if (gone || thisRead !== readNumber) return;
      openingUpdatedScreen = false;
      if (shownDescriptor && shownScreenKind === 'module' && !error?.upgrade_needed && ![401, 403, 404, 410].includes(error?.status)) {
        unmount.pending?.({ title: 'Could not check this saved screen', description: 'Your work is still here. Try again when the connection is available.', action: {
          label: 'Try again', run: () => { void draw(readJson<{ descriptor: Descriptor }>(path)); },
        } });
        return;
      }
      shownDescriptor = '';
      shownScreenKind = '';
      savedInput = {};
      unmount();
      mountScreenState(element, failedState(error, () => { mountScreenState(element, { status: 'loading', label: 'Loading the tool', layout: 'rows' }); draw(readJson<{ descriptor: Descriptor }>(path)); }, 'The tool could not open'));
      unmount = letGo(element);
    });
  };
  draw(readWithKeptAnswers(() => readJson<{ descriptor: Descriptor }>(path)));
  const replaced = onKeptAnswerReplaced(changed => { if (changed === path) draw(readJson<{ descriptor: Descriptor }>(path)); });
  // Save, publish, and removal may happen in another tab or through an AI. The account's live revision makes this
  // exact descriptor read current while the tool remains open; stale reads cannot repaint a newer version.
  const changed = onStoreChange(() => draw(readJson<{ descriptor: Descriptor }>(path)));
  const dispose: Unmount = () => { gone = true; changed(); replaced(); unmount(); };
  dispose.update = next => {
    const changedInputs = !sameInput(latestProps.surfaceInput, next.surfaceInput);
    if (!changedInputs) return;
    const previousScope = moduleSurfaceScopeKey(latestProps.surfaceInput);
    const previousContext = latestProps.surfaceInput?.screen_context_id;
    const nextScope = moduleSurfaceScopeKey(next.surfaceInput);
    latestProps = next;
    if (previousScope !== nextScope || previousContext !== next.surfaceInput?.screen_context_id) {
      path = toolScreenRequest(id, next.surfaceInput, 'describe').path;
      ++readNumber;
      openingUpdatedScreen = false;
      shownDescriptor = '';
      shownScreenKind = '';
      savedInput = {};
      unmount();
      mountScreenState(element, { status: 'loading', label: 'Loading the tool', layout: 'rows' });
      unmount = letGo(element);
      draw(readJson<{ descriptor: Descriptor }>(path));
      return;
    }
    const { screen_context_id: _contextId, ...given } = next.surfaceInput ?? {};
    unmount.update?.({ ...next, surfaceInput: { ...savedInput, ...given, tool_id: id } });
  };
  return dispose;
}
