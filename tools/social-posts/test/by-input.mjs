// tools/social-posts/test/by-input.mjs
//
// Purpose: the row a run sees once the engine has chosen the variant its input names (invoke.by_input, an RFC 7396
// JSON merge patch over invoke, trillion-rust src/tool_runs/tools.rs), so a test can hold what a place's run is
// handed to what the place row declares. Test support only; the engine is the one resolver at run time.
export function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = target !== null && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

/** The invoke a run of `row` gets for `input`: the row's invoke without by_input, merged with its chosen variant. */
export function resolvedInvoke(row, input) {
  const { by_input: byInput, ...invoke } = row.invoke;
  const variant = byInput.variants[input[byInput.input]];
  if (!variant) throw new Error(`${row.id} has no variant for ${byInput.input} ${JSON.stringify(input[byInput.input])}`);
  return mergePatch(invoke, variant);
}
