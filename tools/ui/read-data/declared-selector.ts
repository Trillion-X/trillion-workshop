// A deliberately small, pure selector grammar for owner-declared object paths.
// It is data traversal, not a query language: root, named own-object members, and fixed list positions
// (`$.posts[0].title`), because many services answer with a list even when they made one thing.

export type DeclaredSelector = string & { readonly __declared_selector: unique symbol };

export type DeclaredSelectorError = { readonly selector_contract_error: string };

export function validatedDeclaredSelector(value: unknown): DeclaredSelector | undefined {
  return typeof value === 'string' && /^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[(?:0|[1-9][0-9]*)\])*$/.test(value)
    ? value as DeclaredSelector
    : undefined;
}

// Each step of a validated selector: a member name, or a list position.
function selectorSteps(declared: DeclaredSelector): readonly (string | number)[] {
  return [...declared.slice(1).matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[([0-9]+)\]/g)]
    .map(match => (match[1] !== undefined ? match[1] : Number(match[2])));
}

/** Convert the one validated selector grammar into the canonical own-property
 * path shape consumed by addressed readers. Root (`$`) is the empty path. */
export function declaredSelectorPath(value: unknown): readonly string[] | undefined {
  const declared = validatedDeclaredSelector(value);
  return declared
    ? selectorSteps(declared).map(String)
    : undefined;
}

export function selectDeclaredValue(value: unknown, selector: string | undefined): unknown | DeclaredSelectorError {
  if (!selector) return value;
  const declared = validatedDeclaredSelector(selector);
  if (!declared) return { selector_contract_error: 'invalid result selector' };
  let current: unknown = value;
  for (const step of selectorSteps(declared)) {
    const present = typeof step === 'number'
      ? Array.isArray(current) && step < current.length
      : !!current && typeof current === 'object' && !Array.isArray(current) && Object.prototype.hasOwnProperty.call(current, step);
    if (!present) return { selector_contract_error: 'selector path absent from owner result' };
    current = (current as Record<string | number, unknown>)[step];
  }
  return current;
}
