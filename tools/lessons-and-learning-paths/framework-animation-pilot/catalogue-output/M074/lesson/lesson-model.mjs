export const INITIAL_COMPARISON = Object.freeze({
  useIdentity: true,
  response: 'revise',
});

export function comparisonSummary(content, comparison) {
  const description = comparison.useIdentity ? content.labels.workedDescription : null;
  const response = comparison.response;
  if (!['revise', 'act'].includes(response)) throw new RangeError(`Unknown response: ${response}`);
  return {
    description,
    value: content.labels.workedValue,
    supportingAction: content.labels.workedSupport,
    challengingAction: content.labels.workedChallenge,
    response,
    message: response === 'revise' ? content.labels.revisionMessage : content.labels.nextMessage,
    resolution: response === 'revise' ? content.labels.workedRevision : content.labels.workedNext,
  };
}

export function transferState(comparison) {
  return {
    identityLabelUsed: comparison.useIdentity,
    response: comparison.response,
    result: 'illustrative source comparison; not learner performance or an identity score',
  };
}
