// Upload retries preserve explicit permanent refusals from access and storage
// owners. A lost transport or server interruption still uses the sender's
// existing bounded, paced recovery; response prose never selects that policy.
export function canRetrySendFailure(error) {
  if (error?.name === 'NamespaceRefused' || error?.name === 'AbortError') return false;
  return !(Number.isInteger(error?.status) && error.status >= 400 && error.status < 500);
}

// An unreadable successful reply can be retried. A known client refusal is
// final even when an intermediary answered with HTML instead of JSON.
export function canRetrySendResponse(response, unreadable = false) {
  return response.status >= 500 || (response.ok && unreadable);
}
