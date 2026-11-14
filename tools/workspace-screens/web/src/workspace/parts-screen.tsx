// src/workspace/parts-screen.tsx
//
// PURPOSE
//   Draws a screen made of shared parts (a `parts` screen: src/screen-spec.mjs) and keeps drawing it while an AI is
//   still sending it. A tool whose screen is { kind: "parts", spec, requests } opens through the tool screen
//   (tool-screen.tsx SHOWS), whole; the chat's screen view (screen-view.tsx) hands the growing lines of show_screen to
//   `push` while the AI writes them, so the root paints from the first line and each later line adds or changes only
//   its own elements.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One renderer: every element is a shared part from the library (parts/ui), found by its declared name
//      (parts/ui/declared-props.json, ./declared-parts.ts). This file names no part, prop or request.
//   2. Each element subscribes to its own entry of the spec; an element whose entry did not change is not drawn again
//      (src/view-patch.mjs keeps unchanged entries identical), and an element that reads no state does not redraw when
//      state changes.
//   3. One bad element never blanks the screen: an element that fails its part's declared props, names a part that does
//      not exist, holds itself, or throws as it draws shows the fallback in its own place; the rest draws on.
//   4. No code runs from a spec. An action is setState or a request the screen declares; `call` (the screen's host)
//      sends that request through the signed-in page's validated request owner (module-surface-requests.mjs), so a
//      press changes the person's real records, and a press that returns its request's promise shows pending, done or
//      failed in the part itself.
//   5. A read or an action that failed says so on the screen; a failed read is never drawn as empty data.
//   6. Only the latest read cycle may change read values or status, even when that cycle removes every read.

import * as React from 'react';
import { Container, Text } from '../../parts/ui';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { ScreenState } from '../../parts/ui/show/screen-state';
import {
  boundPath, checkElement, conditionHolds, declaredParts, pointerGet, pointerSet, readsState, resolveValue,
  screenSpecLimits, screenSpecWords, specStream,
} from 'trillion-workshop/tools/build-a-screen-from-patches/read-data/screen-spec.mjs';
import { declaredComponents } from './declared-parts';
import { reasonOf } from './failure';
import { loadScreenConditions } from './record-filter';
import { onStoreChange } from './store-changes';
import type { Unmount } from './lazy-screen';

type Element = { type?: string; props?: Record<string, unknown>; children?: string[]; on?: Record<string, Binding[]>; visible?: unknown; repeat?: { statePath?: string; key?: string } };
type Binding = { action: string; params?: Record<string, unknown>; result?: string };
type Read = { request: string; pick?: string };
export type PartsSpec = { root: string | null; elements: Record<string, Element>; state?: Record<string, unknown>; reads?: Record<string, Read> };
export type PartsCall = (name: string, input?: Record<string, unknown>) => Promise<unknown>;
type Part = { props?: Record<string, Record<string, unknown>>; text_prop?: string; children?: boolean; events?: Record<string, Handler>; binds?: Record<string, Handler> };
type Handler = { prop: string; from?: string; key?: string };
type Scope = { item?: unknown; index?: number; itemPath?: string };
type Checked = ReturnType<typeof checkElement>;
type Answer = ReturnType<ReturnType<typeof specStream>['push']>;

const parts = declaredParts as Record<string, Part>;
const say = (template: string, values: Record<string, unknown>) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const ROOT_SCOPE: Scope = {};

/** The screen's spec, its state and what failed, with one subscription road for every element. */
function partsStore(given: Record<string, unknown>) {
  let spec: PartsSpec = { root: null, elements: {}, state: {}, reads: {} };
  let state: Record<string, unknown> = {};
  let failure: string | null = null;
  let requests = given;
  const listeners = new Set<() => void>();
  let checked = new WeakMap<Element, Checked>();
  const emit = () => { for (const listener of listeners) listener(); };
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    spec: () => spec,
    state: () => state,
    failure: () => failure,
    // An element checked once per version of it (its identity) and of the screen's requests, so a line that changed
    // another element costs nothing here, and requests that arrive after the elements naming them are taken.
    checked: (key: string): Checked | undefined => {
      const element = spec.elements[key];
      if (!element) return undefined;
      let found = checked.get(element);
      if (!found) { found = checkElement(key, element, { requests }); checked.set(element, found); }
      return found;
    },
    setRequests(next: Record<string, unknown>) {
      if (JSON.stringify(next) === JSON.stringify(requests)) return;
      requests = next;
      checked = new WeakMap();
      emit();
    },
    setSpec(next: PartsSpec) {
      // State the AI sends starts the screen's state; what the person changes after it stays theirs.
      if (next.state !== spec.state) state = { ...(next.state ?? {}) };
      spec = next;
      emit();
    },
    setState(path: string, value: unknown) { state = pointerSet(state, path, value) as Record<string, unknown>; emit(); },
    fail(reason: string | null) { if (failure !== reason) { failure = reason; emit(); } },
  };
}
type Store = ReturnType<typeof partsStore>;
type Host = { store: Store; run: (bindings: Binding[], value: unknown, scope: Scope) => Promise<void> };
const HostContext = React.createContext<Host | null>(null);

// The value an event reports: its first argument, or the `from` path in it (currentTarget.value, id).
const eventValue = (handler: Handler, given: unknown) => (handler.from ? handler.from.split('.').reduce<unknown>((at, name) => (at === null || typeof at !== 'object' ? undefined : (at as Record<string, unknown>)[name]), given) : given);

class ElementBoundary extends React.Component<{ version: unknown; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous: { version: unknown }) { if (previous.version !== this.props.version && this.state.failed) this.setState({ failed: false }); }
  render() { return this.state.failed ? <Fallback /> : this.props.children; }
}

function Fallback() {
  return <Text variant="caption" color="muted" data-parts-fallback="">{screenSpecWords.part_failed}</Text>;
}

const useChecked = (store: Store, key: string) => React.useSyncExternalStore(store.subscribe, () => store.checked(key));
const useScreenState = (store: Store, wanted: boolean) => React.useSyncExternalStore(store.subscribe, () => (wanted ? store.state() : null));

// `trail` is the keys from the root down to this element's holder, one per line: a string, so an unchanged element held
// by a holder that drew again is still equal and is not drawn again.
const ElementNode = React.memo(function ElementNode({ id, scope, trail }: { id: string; scope: Scope; trail: string }) {
  const host = React.useContext(HostContext)!;
  const checked = useChecked(host.store, id);
  const state = useScreenState(host.store, Boolean(checked?.element) && readsState(checked!.element));
  if (!checked) return null;
  const holders = trail ? trail.split('\n') : [];
  if (holders.includes(id) || holders.length > screenSpecLimits.depth) return <Fallback />;
  if (!checked.usable || !checked.element) return <Fallback />;
  return (
    <ElementBoundary version={checked}>
      <Drawn id={id} element={checked.element as Element} scope={scope} state={state ?? host.store.state()} trail={trail ? `${trail}\n${id}` : id} host={host} />
    </ElementBoundary>
  );
});

function Drawn({ id, element, scope, state, trail, host }: { id: string; element: Element; scope: Scope; state: Record<string, unknown>; trail: string; host: Host }) {
  const here = { ...scope, state };
  if (element.visible !== undefined && !conditionHolds(element.visible, here)) return null;
  const type = String(element.type);
  const part = parts[type];
  const Part = declaredComponents[type];
  if (!Part) return <Fallback />;
  const given = element.props ?? {};
  const resolved = resolveValue(given, here) as Record<string, unknown>;
  const drawnCheck = checkElement(id, { ...element, props: resolved, on: undefined }, { resolved: true });
  // A required value still on its way (state a read has not filled yet) draws nothing until it comes.
  if (!drawnCheck.usable) return null;
  const props: Record<string, unknown> = { ...drawnCheck.element!.props };
  // A prop the part needs that the element left out takes its row's default.
  for (const [name, schema] of Object.entries(part.props ?? {})) if (props[name] === undefined && schema && 'default' in schema) props[name] = schema.default;
  const text = part.text_prop ? props[part.text_prop] : undefined;
  if (part.text_prop) delete props[part.text_prop];
  const handlers = new Map<string, ((given: unknown) => unknown)[]>();
  const add = (prop: string, run: (given: unknown) => unknown) => handlers.set(prop, [...(handlers.get(prop) ?? []), run]);
  for (const [name, handler] of Object.entries(part.binds ?? {})) {
    const path = boundPath(given[name], scope);
    if (path) add(handler.prop, value => host.store.setState(path, eventValue(handler, value)));
  }
  for (const [event, bindings] of Object.entries(element.on ?? {})) {
    const handler = part.events?.[event];
    if (!handler) continue;
    add(handler.prop, value => {
      if (handler.key && (value as { key?: string } | null)?.key !== handler.key) return undefined;
      return host.run(bindings, eventValue(handler, value), scope);
    });
  }
  for (const [prop, runs] of handlers) props[prop] = (value: unknown) => runs.map(run => run(value)).find(answer => answer instanceof Promise);
  // Every handler the row names is given, so a part that needs one (a switch's, a choice's) never draws without it.
  for (const handler of [...Object.values(part.events ?? {}), ...Object.values(part.binds ?? {})]) props[handler.prop] ??= () => undefined;
  const children = part.children === true ? childrenOf(element, here, scope, trail) : undefined;
  return <Part {...props}>{text !== undefined ? String(text) : children}</Part>;
}

// The elements an element holds; with `repeat`, its children once per item of the state list it names.
function childrenOf(element: Element, here: Scope & { state: Record<string, unknown> }, scope: Scope, trail: string) {
  const keys = element.children ?? [];
  if (!element.repeat?.statePath) return keys.map(key => <ElementNode key={key} id={key} scope={scope} trail={trail} />);
  const list = pointerGet(here.state, element.repeat.statePath);
  const items = Array.isArray(list) ? list.slice(0, screenSpecLimits.repeat_items) : [];
  return items.flatMap((item, index) => {
    const itemKey = element.repeat?.key && item && typeof item === 'object' ? String((item as Record<string, unknown>)[element.repeat.key] ?? index) : String(index);
    const itemScope = { item, index, itemPath: `${element.repeat!.statePath}/${index}` };
    return keys.map(key => <ElementNode key={`${itemKey}:${key}`} id={key} scope={itemScope} trail={trail} />);
  });
}

// Every element's visibility and choices are decided by the formula engine (screen-spec.mjs conditionHolds), so a screen
// draws once the engine's bytes are loaded, the same bytes the page's record filters use; if they cannot be fetched the
// screen says so rather than draw conditions it cannot decide.
function ConditionsLoaded({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<'loading' | 'ready' | 'failed'>('loading');
  React.useEffect(() => {
    let live = true;
    loadScreenConditions().then(() => live && setState('ready'), () => live && setState('failed'));
    return () => { live = false; };
  }, []);
  if (state === 'failed') return <Fallback />;
  return state === 'ready' ? <>{children}</> : <ScreenState state={{ status: 'loading', label: screenSpecWords.loading, layout: 'rows' }} />;
}

function Screen({ host }: { host: Host }) {
  const root = React.useSyncExternalStore(host.store.subscribe, () => host.store.spec().root);
  const failure = React.useSyncExternalStore(host.store.subscribe, host.store.failure);
  return (
    <HostContext.Provider value={host}>
      <Container layout="vertical" gap="sm" data-parts-screen="">
        {root ? <ElementNode id={root} scope={ROOT_SCOPE} trail="" /> : <ScreenState state={{ status: 'loading', label: screenSpecWords.loading, layout: 'rows' }} />}
        {failure ? <Text variant="caption" color="error" role="status">{failure}</Text> : null}
      </Container>
    </HostContext.Provider>
  );
}

export type PartsScreenHandle = Unmount & {
  /** The whole stream so far: every line it completes is drawn. */
  push: (text: string) => Answer;
  /** The whole stream, finished: its last line too. */
  end: (text: string) => Answer;
  /** A whole spec at once (a saved screen). */
  show: (spec: PartsSpec) => void;
  /** The screen's declared requests, when they arrive after its elements. */
  requests: (requests: Record<string, unknown>) => void;
};

/** Draws a parts screen into `element`. `call(name, input)` sends one declared request (the screen's host owns how). */
export function mountPartsScreen(element: HTMLElement, { call, requests = {} }: { call: PartsCall; requests?: Record<string, unknown> }): PartsScreenHandle {
  const store = partsStore(requests);
  const stream = specStream();
  let readsKey = '';
  let gone = false;
  let readVersion = 0;
  const failed = (error: unknown) => store.fail(say(screenSpecWords.failed, { reason: reasonOf(error) }));
  // Each read fills its state path; one that fails says so and leaves what was there.
  const read = async () => {
    const version = ++readVersion;
    const current = () => !gone && version === readVersion;
    const reads = Object.entries(store.spec().reads ?? {}).slice(0, screenSpecLimits.reads);
    if (!reads.length) return;
    await Promise.all(reads.map(async ([path, one]) => {
      const answer = await call(one.request, {});
      if (current()) store.setState(path, one.pick ? pointerGet(answer, one.pick) : answer);
    })).then(() => { if (current()) store.fail(null); }, error => { if (current()) failed(error); });
  };
  const run = async (bindings: Binding[], value: unknown, scope: Scope) => {
    try {
      for (const binding of bindings) {
        const params = resolveValue(binding.params ?? {}, { ...scope, state: store.state(), event: value }) as Record<string, unknown>;
        if (binding.action === 'setState') {
          if (typeof params.path === 'string') store.setState(params.path, Object.hasOwn(params, 'value') ? params.value : value);
          continue;
        }
        const answer = await call(binding.action, params);
        if (typeof binding.result === 'string') store.setState(binding.result, answer);
      }
      store.fail(null);
    } catch (error) { failed(error); throw error; }
    await read();
  };
  const take = (answer: Answer) => {
    store.setSpec(answer.spec as PartsSpec);
    const key = JSON.stringify(answer.spec.reads ?? {});
    if (key !== readsKey) { readsKey = key; void read(); }
    return answer;
  };
  const mounted = mountReactSurface(element, <ConditionsLoaded><Screen host={{ store, run }} /></ConditionsLoaded>);
  const changed = onStoreChange(read);
  const dispose = (() => { gone = true; changed(); queueMicrotask(() => mounted()); }) as PartsScreenHandle;
  dispose.push = text => take(stream.push(text));
  dispose.end = text => take(stream.end(text));
  dispose.show = spec => { take({ spec, changed: new Set(), said: [], restarted: false } as Answer); };
  dispose.requests = next => store.setRequests(next);
  return dispose;
}
