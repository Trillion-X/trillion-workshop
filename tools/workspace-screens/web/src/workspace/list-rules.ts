// src/workspace/list-rules.ts
//
// NO PRIOR: the page's end of the person's own lists that hold or show by a rule.
//
// PURPOSE
//   What the sidebar part needs to decide the rules on the person's own lists and rows on this page, reached as
//   `#workspace-list-rules` (parts/sidebar/show/use-surface-collections.ts): the facts a rule may name (surfaces.json
//   `sidebar_row_facts`), the rows the page offers (kept here by main.tsx), and a decision by the same decider and the
//   same formula engine the app's own lists use (sidebar-rules.mjs over record-filter.ts filterRowsByRules).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here decides a rule: the formula engine does.
//   2. The rows are the page's own offered rows, the ones the sidebar draws.

import surfaces from './screens.mjs';
import { decideSidebarRules } from 'trillion-workshop/tools/set-up-my-account/read-data/sidebar-rules.mjs';
import { filterRowsByRules } from './record-filter';
import { readInputValue } from './records';
import type { DecidedListRules, RuleList } from '../../parts/sidebar/read-data/apply-list-rules';

export type ListRuleFact = { id: string; kind: string; label?: string; icon?: string; on?: string[] };
type Row = Record<string, unknown> & { id: string };

let offered: readonly Row[] = [];

/** The rows the page offers, kept once it knows them (main.tsx). */
export function keepListRuleRows(rows: readonly Row[]): void {
  offered = rows;
}

const recordOf = (name: string): Record<string, unknown> | null => {
  const value = readInputValue<unknown>(name);
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
};

export const listRules = {
  facts: (surfaces as unknown as { sidebar_row_facts: ListRuleFact[] }).sidebar_row_facts,
  rows: (): readonly Row[] => offered,
  decide: (lists: readonly RuleList[], now: number): Promise<DecidedListRules> =>
    decideSidebarRules({ data: surfaces, lists, rows: [...offered], readRecord: recordOf, now, filterRows: filterRowsByRules }) as Promise<DecidedListRules>,
};
