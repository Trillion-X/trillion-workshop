// tools/workflows/read-data/kept-piped-values.mjs
//
// A binding that selects a run's own value and drops it: `{ select: { from: "input" | "steps", path }, transform:
// [{ op: "op:core.coalesce", args: { values: [<defaults only>] } }] }`. op:core.coalesce answers the first of its own
// `values` that is not null and never reads the value piped into it (the formula engine's lambda bodies and the
// `{ select: literal 0 } | coalesce([...])` idiom rely on that), so such a binding always answers the default and the
// selected value never reaches the step. Found Nov 24 2026: workflow:release-a-mac-app-with-apples-own-tools dropped its
// carried files, signing keychain and publish_to (16 bindings); bring-a-shared-checkout-back-to-main, find-who-is-in-a-clip
// and place-each-allowed-clip-where-the-site-reads-it dropped 5 more inputs.
//
// droppedPipeProblems names each such binding of a definition, with the two ways to write what was meant. A binding whose
// candidates include any selection of their own (`steps.search.output | coalesce([steps.search.output.rows, ...])`) chose
// its candidates on purpose and is left alone, as is any binding that already lists the piped value first
// (`{ "select": { "from": "self" } }`).
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isDefault = value => !object(value) || (value.select?.from === 'literal' && !value.transform);
const PIPED_FROM = new Set(['input', 'steps']);

function selected(select) {
  const path = Array.isArray(select.path) ? select.path.join('.') : select.path;
  return [select.from, select.key, path].filter(part => part !== undefined && part !== '').join('.');
}

/** Every binding of `definition` ({ steps: [...] }) that selects an input or step value and pipes it into a coalesce of
 *  defaults only, as one refusal each: `definition.steps.<id>: <what> ...`. */
export function droppedPipeProblems(definition, name = 'definition') {
  const problems = [];
  const visit = (node, at) => {
    if (Array.isArray(node)) { node.forEach(item => visit(item, at)); return; }
    if (!object(node)) return;
    const first = Array.isArray(node.transform) ? node.transform[0] : undefined;
    if (node.$kind === 'binding' && PIPED_FROM.has(node.select?.from) && node.select.path !== undefined
      && object(first) && first.op === 'op:core.coalesce') {
      const values = first.args?.values;
      if (Array.isArray(values) && values.length > 0 && values.every(isDefault)) {
        problems.push(`${at}: the binding selects ${selected(node.select)} and pipes it into op:core.coalesce whose values are only defaults, so the selected value is never used (coalesce reads only its own values). Write { "op": "op:core.if_null", "args": { "fallback": <the default> } } instead, or put { "$kind": "binding", "select": { "from": "self" } } first among the values.`);
      }
    }
    for (const value of Object.values(node)) visit(value, at);
  };
  for (const step of Array.isArray(definition?.steps) ? definition.steps : []) visit(step, `${name}.steps.${step?.id ?? '?'}`);
  return problems;
}
