// src/workspace/scope-focus.ts
//
// PURPOSE
//   The person's saved focus, kept in their workspace record `rule-filter::focus-chain` (FOCUS_CHAIN_LABEL, read and
//   written through /work/api/records like every saved record, records.ts), as the app and screen levels of the shared
//   filter chain (parts/ui/show/rule-filter/focus-chain.ts). No dimension is offered: the values a focus picks from
//   (/work/api/scope/values) and the saved scope views (/work/api/scope/filters) have no owner in the engine
//   (macos/release.json route_owner_gate.retired), so neither is asked. The Focus editor edits the app level with the same rule filter every
//   list uses; each list reads its rows with `?scope={"saved":"<screen>"}`, so these levels are applied where records
//   are read and the lists only show them as chips (appliedAtSource).
//   Three levels live in the saved scope: the app's (the global scope over every screen), the arrangement's (the global
//   scope set to a list of screens) and a screen's own. `focusPathFor` names the levels the server applies to a screen,
//   so a list shows one chip per level that narrowed its rows and never a level the server skipped.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One store: the saved scope is the record; nothing here keeps a second copy beyond the last answer.
//   2. A level's rule is one `has_any_of` rule per dimension (its `param`), values the chosen ids; any other rule a
//      person builds is kept as the ids it names, since a saved scope is ids per dimension (all across dimensions, any
//      within one), which is exactly an All group of has_any_of rules.
//   3. No dimension, screen or value is named here: they would come from a scope values answer, which no owner gives.

import operators from 'trillion-workshop/tools/formula-engine/rules/rule-operators.json';
import { allOf, FOCUS_CHAIN_LABEL, withNodeRule, type NodeRules, type NodeRuleStore } from '../../parts/ui/show/rule-filter/focus-chain';
import type { RuleFacet, RuleFieldView } from '../../parts/ui/show/rule-filter/RuleFilter';
import type { RuleGroup, RuleNode, RuleOperatorData } from '../../parts/ui/show/rule-filter/rule-tree';
import { narrowListsBy } from './api';
import { readEveryScreenAgain } from './store-changes';
import { readSavedRecordFromOwner, updateSavedLabelValueDurably } from './records';

type Scope = Record<string, string[]>;
type Filters = { nodes: NodeRules; coverage: string[] | null };
export type Dimension = { id: string; param: string; label: string; icon?: string; values: { id: string; title: string; count?: number; parents?: string[] }[] };

const ALL = allOf(operators as RuleOperatorData);
/** The node id of the app's own level: the global scope over every screen. */
export const APP_FOCUS_NODE = 'app';
/** The node id of the arrangement's level: the global scope set to a list of screens. */
export const ARRANGEMENT_FOCUS_NODE = 'arrangement';

const idsIn = (node: RuleNode, param: string, into: Set<string> = new Set()): Set<string> => {
  if (node.kind === 'group') for (const child of node.rules) idsIn(child, param, into);
  else if (node.field === param) for (const value of [node.params.values ?? node.params.value].flat()) if (typeof value === 'string' && value) into.add(value);
  return into;
};

let dimensions: Dimension[] = [];
let rules: NodeRules = {};
let covered: string[] | null = null;
const listeners = new Set<() => void>();
const tell = () => { for (const listener of listeners) listener(); };
const params = () => dimensions.map(dimension => dimension.param);
let appScope: Scope = {};
let writeQueue: Promise<unknown> = Promise.resolve();
let editVersion = 0;
let hydrated = false;
const editedBeforeHydration = new Set<string>();
const adopt = (filters: Filters) => {
  const beforeRules = JSON.stringify(rules);
  rules = filters.nodes ?? {};
  covered = filters.coverage ?? null;
  const app = rules[APP_FOCUS_NODE];
  // The app's own focus narrows every list read from now on (api.ts), and every open screen reads itself again.
  const before = JSON.stringify(appScope);
  appScope = app ? Object.fromEntries(params().map(param => [param, [...idsIn(app, param)]]).filter(([, ids]) => ids.length)) : {};
  narrowListsBy(Object.keys(appScope).length ? JSON.stringify({ saved: APP_FOCUS_NODE }) : null);
  if (JSON.stringify(appScope) !== before || JSON.stringify(rules) !== beforeRules) readEveryScreenAgain();
  if (JSON.stringify(rules) !== beforeRules) tell();
};
const nodesOf = (value: unknown): NodeRules => (value && typeof value === 'object' && !Array.isArray(value) ? value as NodeRules : {});
const readSaved = async (): Promise<NodeRules> => nodesOf((await readSavedRecordFromOwner(FOCUS_CHAIN_LABEL)).value);
/** Keeps one level's rule in the saved record, merged into the record as the store holds it now; answers what it kept. */
const keep = (nodeId: string, rule: Parameters<NodeRuleStore['write']>[1]) =>
  updateSavedLabelValueDurably(FOCUS_CHAIN_LABEL, current => withNodeRule(nodesOf(current), nodeId, rule));

/** Read what can be chosen and what is saved, once a page; the answer includes the level the global focus is kept at. */
export const loadScopeFocus = () => (loading ??= readScopeFocus());
let loading: Promise<{ nodeId: string; fields: RuleFieldView[]; facets: Record<string, RuleFacet> }> | null = null;
async function readScopeFocus(): Promise<{ nodeId: string; fields: RuleFieldView[]; facets: Record<string, RuleFacet> }> {
  dimensions = [];
  // The first account read may have started before a view applied its saved
  // configuration. Hydrate other nodes, while retaining each locally edited
  // node's current value (including a clear) until its own write settles.
  let nodes = await readSaved();
  for (const nodeId of editedBeforeHydration) nodes = withNodeRule(nodes, nodeId, rules[nodeId] ?? null);
  hydrated = true;
  editedBeforeHydration.clear();
  adopt({ nodes, coverage: null });
  return {
    nodeId: covered ? ARRANGEMENT_FOCUS_NODE : APP_FOCUS_NODE,
    fields: dimensions.map(dimension => ({
      id: dimension.param, label: dimension.label, kind: 'tags', icon: dimension.icon,
      values: Object.fromEntries(dimension.values.map(value => [value.id, { label: value.title, ...(value.parents?.length ? { parents: value.parents } : {}) }])),
    })),
    facets: Object.fromEntries(dimensions.map(dimension => [dimension.param, { options: dimension.values.map(value => ({ value: value.id, count: value.count ?? 0 })) }])),
  };
}

/** The app and screen levels of the chain, kept in the person's saved scope. */
export const scopeFocus: NodeRuleStore = {
  read: () => rules,
  write: (nodeId, rule) => {
    if (!hydrated) editedBeforeHydration.add(nodeId);
    adopt({ nodes: withNodeRule(rules, nodeId, rule), coverage: covered });
    const version = ++editVersion;
    writeQueue = writeQueue.catch(() => {}).then(() => keep(nodeId, rule))
      .then(nodes => { if (version === editVersion) adopt({ nodes, coverage: covered }); }, () => {
        if (version === editVersion) void readSaved().then(nodes => {
          if (version === editVersion) adopt({ nodes, coverage: covered });
        }, () => {});
      });
  },
  subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  appliedAtSource: true,
};

/**
 * The levels above a list on `screen`, as src/record-scope.mjs resolves `{ saved: screen }`: the screen's own saved
 * scope when it has one, else the global one when it covers the screen (the app's, or the arrangement's when it lists
 * screens). The list's own node goes last.
 */
export const focusPathFor = (screen: string, own: string): string[] => {
  if (!covered) return [APP_FOCUS_NODE, screen, own];
  return covered.includes(screen) ? [APP_FOCUS_NODE, ARRANGEMENT_FOCUS_NODE, screen, own] : [APP_FOCUS_NODE, screen, own];
};

/** The scope a screen sends with its list read: its own saved scope, else the app's when that covers it. */
export const savedScopeParam = (screen: string) => `scope=${encodeURIComponent(JSON.stringify({ saved: screen }))}`;

/** What a focus can be set to (each dimension with its values' titles), read once and kept for this page. */
export function focusChoices(): Promise<Dimension[]> {
  return loadScopeFocus().then(() => dimensions, error => { loading = null; throw error; });
}
/** The app's focus now: the chosen ids per dimension param (empty when the whole workspace shows). */
export const focusNow = (): Scope => appScope;
/** Listen for the focus changing; returns the function that stops listening. */
export const onFocusChange = (listener: () => void) => scopeFocus.subscribe(listener);
/**
 * Set the whole workspace's focus to one value of one dimension (a space, a pursuit), or to nothing: every screen is
 * about it until it changes. Saved as the app's own level, the same record the rule filter writes.
 */
export async function focusOn(param: string | null, id: string | null): Promise<void> {
  await focusChoices();
  const rule: RuleGroup | null = param && id ? { kind: 'group', combinator: ALL, negate: false, rules: [{ kind: 'rule', field: param, operator: 'has_any_of', params: { values: [id] } }] } : null;
  adopt({ nodes: await keep(APP_FOCUS_NODE, rule), coverage: null });
}
