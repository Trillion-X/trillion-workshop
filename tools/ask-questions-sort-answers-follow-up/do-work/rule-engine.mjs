// tools/ask-questions-sort-answers-follow-up/do-work/rule-engine.mjs
//
// The formula engine (tools/formula-engine), loaded once in Node, for the questions asked only when their rules hold (a
// question's showWhen and hideWhen are its rule trees). Every tool row of this folder packs the engine's built files at
// trillion-workshop/tools/formula-engine, and a program that bundles this file carries them.
//
//   holds({ tree, facts }) -> boolean   whether a rule tree holds over facts (read-data/question-descriptor.ts answerFacts)
import { readFileSync } from 'node:fs';
import { initSync, holds as engineHolds } from 'trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine.js';

initSync({ module: readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm'))) });

export const holds = request => engineHolds(request);
