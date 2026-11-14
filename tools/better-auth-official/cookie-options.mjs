// Better Auth's `advanced` cookie options for the session cookie settings.json names. Better Auth puts __Secure- in front of
// every cookie name on an https base URL (its useSecureCookies rule); a name that already carries a cookie prefix (__Host-,
// __Secure-) would then be sent as __Secure-__Host-…, so for such a name that rule is turned off and every cookie is marked
// Secure by the base URL instead, through Better Auth's own `useSecureCookies` and `defaultCookieAttributes` options.
export function cookieOptions({ session_cookie_name: name, base_url: baseURL }) {
  const cookies = { session_token: { name } };
  if (!/^__(Host|Secure)-/.test(name)) return { cookies };
  return { useSecureCookies: false, defaultCookieAttributes: { secure: baseURL.startsWith('https://') }, cookies };
}
