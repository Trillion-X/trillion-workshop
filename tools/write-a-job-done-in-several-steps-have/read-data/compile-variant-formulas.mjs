// Writes each formula of tools/formula-engine/rules/variants.json as the binding the formula engine compiles its text into,
// so a step with variants carries bindings the workflow engine evaluates (it takes no formula text).
// usage: node tools/write-a-job-done-in-several-steps-have/read-data/compile-variant-formulas.mjs
// Run after changing a formula's text; tools/formula-engine/test/variants.test.mjs fails while text and binding differ.
import { readFileSync, writeFileSync } from 'node:fs';
import { compileText, initSync } from '../../formula-engine/built-stored-bytes/formula-engine/formula_engine.js';

initSync({ module: readFileSync(new URL('../../formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) });
const file = new URL('../../formula-engine/rules/variants.json', import.meta.url);
const rules = JSON.parse(readFileSync(file, 'utf8'));
const compiled = Object.values(rules.formulas).map(formula => JSON.stringify(compileText({ text: formula.text }).binding));
// Each binding on one line, so the file reads as its formulas' words.
Object.values(rules.formulas).forEach((formula, index) => { formula.binding = `\u0000${index}`; });
const written = JSON.stringify(rules, null, 2).replace(/"\\u0000(\d+)"/g, (_, index) => compiled[Number(index)]);
writeFileSync(file, `${written}\n`);
process.stdout.write(`${Object.keys(rules.formulas).length} formulas compiled into ${file.pathname}\n`);
