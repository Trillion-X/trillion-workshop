// packages/ui/show/rule-filter/formula-engine-for-tests.ts
//
// Purpose
//   The real formula engine for this package's tests: the Rust engine built to WebAssembly
//   (tools/formula-engine/built-stored-bytes/formula-engine), loaded from the formula-engine package in the same
//   checkout. Tests that filter records go through the engine that decides them in the product, never through a
//   stand-in. Its comparison rows are the engine's own copy of rules/rule-operators.json.

import fs from 'node:fs'
import {filterRecords as decideRecords, initSync} from 'trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine.js'
import type {RuleNode} from './rule-tree'

initSync({module: fs.readFileSync(new URL('../../../formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url))})

/** The records a rule tree keeps, by index, with the rules the engine could not finish. */
export function filterRecords(records: Record<string, unknown>[], tree: RuleNode, fields: {id: string; kind: string}[]) {
  return decideRecords({records, fields, tree})
}
