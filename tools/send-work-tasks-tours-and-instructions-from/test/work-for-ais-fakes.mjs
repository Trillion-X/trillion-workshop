// Shared test fakes for the work-for-ais tests: the settings read from their owner's DATA file, an in-memory edge store with
// pages, a small audience matcher for the operators the old tests used, and account facts built the way the owner builds them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const rules = JSON.parse(readFileSync(fileURLToPath(new URL('../../decide-when-things-show/read-data/work-for-ais.json', import.meta.url)), 'utf8'));
export const HOUR = 3600000;
export const DAY = 24 * HOUR;
export const NOW = Date.parse('2026-10-08T12:00:00Z');

export const group = (...rules) => ({ kind: 'group', combinator: 'and', negate: false, rules });
export const rule = (field, operator, params = {}) => ({ kind: 'rule', field, operator, params });
export const row = (id, extra = {}) => ({ id, job: `do ${id}`, trigger: 'connect', priority: 5, ...extra });

// The operators the old tests used, over one account's facts. A group is an AND of its rules.
const operators = {
  is_any_of: (value, params) => params.values.includes(value),
  has_any_of: (value, params) => (value ?? []).some(item => params.values.includes(item)),
  between: (value, params) => value >= params.min && value <= params.max,
  equals: (value, params) => value === params.value,
  is_true: value => value === true,
};
export const matches = (tree, _fields, account) => tree.rules.every(item => operators[item.operator](account[item.field], item.params));

// The facts the owner builds for an account (the same fields as src/work-for-ais.mjs accountFacts).
export function factsFor(accountId, { plan = 'free', createdAt = null, setupIncluded = false, setupDone = false, bucket = 42, cohorts = [], experiments = [] } = {}) {
  return { account_id: accountId, plan, offers: null, capabilities: null, created_at: createdAt, cohorts, experiments, bucket,
    setup_included: setupIncluded, setup_done: setupDone, ai_connected: true, operator: false };
}

// An edge store: keys, get as JSON, delete, and a list in pages of `pageSize` keys.
export function edgeStore({ pageSize = 1000 } = {}) {
  const data = new Map();
  return {
    data,
    async put(key, value) { data.set(key, value); },
    async get(key) { return data.has(key) ? JSON.parse(data.get(key)) : null; },
    async delete(key) { data.delete(key); },
    async list({ prefix, cursor = 0 }) {
      const keys = [...data.keys()].filter(key => key.startsWith(prefix));
      const page = keys.slice(cursor, cursor + pageSize).map(name => ({ name }));
      const done = cursor + pageSize >= keys.length;
      return { keys: page, list_complete: done, ...(done ? {} : { cursor: cursor + pageSize }) };
    },
  };
}

// One record book per row id: `list(kind)` and `put(kind, row)`, each book in its own store.
export function recordBooks() {
  const stores = new Map();
  const store = name => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
  return {
    stores,
    of: name => ({
      list: kind => store(name).get(kind) ?? [],
      put: (kind, value) => store(name).set(kind, [value]),
    }),
  };
}
