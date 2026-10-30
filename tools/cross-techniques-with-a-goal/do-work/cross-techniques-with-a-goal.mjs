// tools/cross-techniques-with-a-goal/do-work/cross-techniques-with-a-goal.mjs
//
// Purpose
//   `tool:cross-techniques-with-a-goal`: one JSON request on standard input ({ goal, constraints?, wants?, rows,
//   vocabulary, models }), `{ result }` on the last line, or `{ error }` that says what to change in the request.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { readFileSync } from 'node:fs';
import { crossTechniquesWithAGoal } from './cross.mjs';

const conventions = JSON.parse(readFileSync(new URL('./technique-conventions.json', import.meta.url), 'utf8'));
try {
  const result = await crossTechniquesWithAGoal(JSON.parse(readFileSync(0, 'utf8')), conventions);
  console.log(JSON.stringify({ result }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
