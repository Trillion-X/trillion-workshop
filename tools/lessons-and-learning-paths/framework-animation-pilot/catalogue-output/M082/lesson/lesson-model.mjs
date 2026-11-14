export const RESPONSES = ['continue', 'change', 'reconsider'];

export function decisionSummary(content, response) {
  const messages = {
    continue: content.labels.continueMessage,
    change: content.labels.changeMessage,
    reconsider: content.labels.reconsiderMessage,
  };
  if (!Object.hasOwn(messages, response)) throw new RangeError('Unknown response choice.');
  return messages[response];
}

export function transferState(response) {
  if (!RESPONSES.includes(response)) return { response: null, boundary: 'illustrative case; no learner outcome inferred' };
  return { response, boundary: 'illustrative case; no learner outcome inferred' };
}
