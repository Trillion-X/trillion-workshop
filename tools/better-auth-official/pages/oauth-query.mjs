// tools/better-auth-official/pages/oauth-query.mjs
//
// The sign-in pages of an AI's connect are opened by Better Auth's authorize step with the AI's request as a signed query
// (its own names, `exp`, `ba_iat`, `sig`, and `ba_param` naming every signed parameter; @better-auth/oauth-provider
// signed-query). A page carries that query on to the next page, and when the person is signed in sends the request back to
// authorize without the signature parts, as Better Auth's own sign-in hook does (its `prompt=login` taken out).
const signature = new Set(['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param']);
const signedNames = params => new Set(params.getAll('ba_param'));

/** The signed part of a page's query, as the oauth_query Better Auth's endpoints take; '' when the page was not opened by authorize. */
export function signedQuery(search) {
  const params = new URLSearchParams(search);
  const names = signedNames(params);
  if (!params.has('sig') || !names.size) return '';
  return new URLSearchParams([...params].filter(([key]) => key === 'sig' || names.has(key))).toString();
}

/** The AI's own authorization request: the signed parameters without the signature parts, and a `prompt` without `login`. */
export function authorizeQuery(search) {
  const params = new URLSearchParams(search);
  const names = signedNames(params);
  const request = new URLSearchParams([...params].filter(([key]) => names.has(key) && !signature.has(key)));
  const prompt = (request.get('prompt') ?? '').split(' ').filter(word => word && word !== 'login');
  if (prompt.length) request.set('prompt', prompt.join(' '));
  else request.delete('prompt');
  return request.toString();
}
