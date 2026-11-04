/**
 * Compare provider-reported OAuth grants with a service DATA declaration.
 * This is a display/diagnostic projection only; it never authorizes a tool.
 */

export type GrantRequirementStatus = 'satisfied' | 'missing' | 'unknown';

export type GrantRequirementResult = {
  status: GrantRequirementStatus;
};

/**
 * Each inner scope list is an AND group; any complete group satisfies the
 * requirement. Unknown grants or malformed/empty declarations stay unknown.
 */
export function evaluateGrantRequirement(
  alternatives: unknown,
  grantedScopes: unknown,
  grantsKnown: unknown,
): GrantRequirementResult {
  if (grantsKnown !== true || !Array.isArray(grantedScopes)
    || grantedScopes.some(scope => typeof scope !== 'string' || !scope.trim())
    || !Array.isArray(alternatives) || alternatives.length === 0) {
    return { status: 'unknown' };
  }

  const normalizedAlternatives: string[][] = [];
  for (const alternative of alternatives) {
    if (!Array.isArray(alternative) || alternative.length === 0
      || alternative.some(scope => typeof scope !== 'string' || !scope.trim())) {
      return { status: 'unknown' };
    }
    normalizedAlternatives.push([...new Set(alternative.map(scope => (scope as string).trim()))]);
  }

  const granted = new Set(grantedScopes.map(scope => (scope as string).trim()));
  return {
    status: normalizedAlternatives.some(alternative => alternative.every(scope => granted.has(scope)))
      ? 'satisfied'
      : 'missing',
  };
}
