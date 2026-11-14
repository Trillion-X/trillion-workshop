// packages/ui/show/rule-filter/formula-engine-for-tests.ts
//
// Purpose
//   The real formula engine for this package's tests: its comparison rows and
//   its record filter, loaded from the formula-engine package in the same
//   checkout. Tests that filter records go through the engine that decides
//   them in the product, never through a stand-in.

import fs from 'node:fs'
import {createRecordFilter} from '../../../formula-engine/rules/filter-records.mjs'
import type {RuleOperatorData} from './rule-tree'

const read = (relative: string) => fs.readFileSync(new URL(relative, import.meta.url))

export const ruleOperators: RuleOperatorData = JSON.parse(String(read('../../../formula-engine/rules/rule-operators.json')))

export const filterRecords = createRecordFilter({
  operators: ruleOperators,
  wasmBytes: read('../../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm'),
})
